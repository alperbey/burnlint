import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import { parseArgs } from "node:util";
import { audit, severityRank } from "./audit.js";
import { diff, gate, GroupKeyError, type DiffResult } from "./diff.js";
import type { Severity } from "./model.js";
import { PriceTable, type Price } from "./pricing.js";
import { DEFAULT_PORT, PROTOBUF_HINT, defaultRecordFile, startRecorder } from "./record.js";
import { renderDiffJson, renderDiffTable, renderJson, renderMarkdown, renderTable, verdictLine } from "./report.js";
import { defaultConfig, rules } from "./rules/index.js";
import { plainText } from "./text.js";

// dist/src/cli.js -> package.json, in the repo and in an installed package alike.
const VERSION: string = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;

const HELP = `burnlint — cost per run for AI agents, and the avoidable part

Usage:
  burnlint audit [paths...]   Lint trace files or folders
  burnlint diff <base> <head> Compare cost per run before and after a change
  burnlint record             Receive OTLP traces from a running agent and save them for audit
  burnlint rules              List rules

Inputs (detected per file):
  Claude Code session logs     ~/.claude/projects/**/*.jsonl (default when no path is given)
  OTLP/JSON traces             OpenTelemetry GenAI spans, .json or .jsonl

Options:
  -f, --format <table|json|md>   Output format (default: table)
      --fail-on <high|medium|low>  Exit 1 if any finding is at or above this severity (info never fails)
      --rule <id>                Only run this rule (repeatable)
      --prices <file.json>       Price overrides: { "model-id": { "input": 3, "output": 15, ... } } in USD per 1M tokens
      --high-usd <n>             Cost for high severity (default 1)
      --medium-usd <n>           Cost for medium severity (default 0.1)
      --runs-per-month <n>       Project spend and avoidable spend to this many runs a month
  -v, --verbose                  Show each occurrence, file paths and all notes
  -h, --help
      --version

Diff:
  Runs the same tasks before (base) and after (head) a change; each side is a trace file or a
  folder. Runs are compared within groups (the same agent or task), and the overall change is
  at base's mix of groups, with a permutation test of whether it is more than noise.

      --group-by <key>           Run label to group by (default: gen_ai.agent.name, else the
                                 Claude Code project, else one group), e.g. a root-span attribute
      --fail-above <pct>         Exit 1 if cost per run rose more than this many percent and the
                                 runs show a rise clearly (one-sided p < 0.05). A rise the runs
                                 can't tell from noise passes. Inputs must be the same on both
                                 sides: a task that reads a growing repo costs more by itself. With 3 runs per group, only rises
                                 of 15-20% or more are reliably seen; use 5+ runs for 10%.
  -f, --format <table|json>      Output format (default: table)
      --prices <file.json>       Price overrides, as for audit

Record:
  Listens on 127.0.0.1 for OTLP/HTTP with JSON encoding and appends each trace export to a
  JSONL file. Start it, run the agent with OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
  and OTEL_EXPORTER_OTLP_PROTOCOL=http/json, stop it with Ctrl-C, then audit the file.

  -o, --out <file.jsonl>         File to append to (default: ./burnlint-<UTC time>.jsonl)
      --port <n>                 Port to listen on (default ${DEFAULT_PORT}, 0 = any free port)
  -v, --verbose                  Log every export received
`;

// Error lines can carry label keys, paths and parser messages from a trace.
const err = (line: string) => process.stderr.write(plainText(line) + "\n");

/** Options each command takes. Anything else on the command line is refused, not ignored. */
const COMMAND_OPTIONS: Record<string, string[]> = {
  audit: ["format", "fail-on", "rule", "prices", "high-usd", "medium-usd", "runs-per-month", "verbose"],
  diff: ["format", "group-by", "fail-above", "prices"],
  record: ["out", "port", "verbose"],
  rules: [],
};

function usdOption(name: string, raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(n) || n < 0) throw new Error(`--${name} must be a USD amount of zero or more, got "${raw}"`);
  return n;
}

const PRICE_FIELDS = ["input", "output", "cacheRead", "cacheWrite5m", "cacheWrite1h"];

function loadPrices(file: string): Record<string, Partial<Price>> {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`--prices ${file}: ${(e as Error).message}`);
  }
  const bad = (why: string) => new Error(`--prices ${file}: ${why}`);
  if (typeof data !== "object" || data === null || Array.isArray(data)) throw bad(`expected an object of model ids`);
  for (const [model, price] of Object.entries(data)) {
    if (typeof price !== "object" || price === null || Array.isArray(price)) throw bad(`"${model}" must be an object`);
    for (const [field, value] of Object.entries(price)) {
      if (field === "provider" && typeof value === "string") continue;
      if (!PRICE_FIELDS.includes(field)) throw bad(`"${model}" has unknown field "${field}" (known: ${PRICE_FIELDS.join(", ")})`);
      if (value !== null && (typeof value !== "number" || !Number.isFinite(value) || value < 0))
        throw bad(`"${model}".${field} must be a number of USD per 1M tokens, or null`);
    }
  }
  return data as Record<string, Partial<Price>>;
}

async function record(values: { out?: string; port?: string; verbose: boolean }): Promise<number> {
  const file = values.out ?? defaultRecordFile();
  if (extname(file) !== ".jsonl") {
    err(`--out must end in .jsonl so that audit picks the file up: ${file}`);
    return 2;
  }
  const port = values.port === undefined ? DEFAULT_PORT : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535 || values.port?.trim() === "") {
    err(`--port must be a number from 0 to 65535`);
    return 2;
  }

  const recorder = await startRecorder({ file, port, verbose: values.verbose, log: err });
  const endpoint = `http://127.0.0.1:${recorder.port}`;
  err(`burnlint record: listening on ${endpoint} (OTLP/HTTP, JSON), traces go to ${file}`);
  err(`Run the agent with:`);
  err(`  OTEL_EXPORTER_OTLP_ENDPOINT=${endpoint}`);
  err(`  OTEL_EXPORTER_OTLP_PROTOCOL=http/json`);
  err(`Ctrl-C to stop.`);

  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  await recorder.close();

  const s = recorder.stats;
  err("");
  if (s.spans) {
    err(`recorded ${s.spans} span(s) from ${s.requests} export(s) to ${file}`);
    err(`next: burnlint audit ${file}`);
  } else {
    err(`no spans received, nothing written`);
  }
  if (s.protobufRefused) err(`${s.protobufRefused} protobuf trace export(s) refused: ${PROTOBUF_HINT}`);
  if (s.invalid) err(`${s.invalid} trace export(s) refused as unreadable (rerun with -v for the reason)`);
  if (s.logsDropped || s.metricsDropped)
    err(`${s.logsDropped} log and ${s.metricsDropped} metric export(s) ignored: only traces are recorded`);
  return 0;
}

function runDiff(paths: string[], values: { format: string; "group-by"?: string; "fail-above"?: string; prices?: string }): number {
  if (paths.length !== 2) {
    err(`diff takes two paths, base and head (got ${paths.length})`);
    return 2;
  }
  for (const t of paths) {
    if (!existsSync(t)) {
      err(`not found: ${t}`);
      return 2;
    }
  }
  if (!["table", "json"].includes(values.format)) {
    err(`--format must be table or json for diff, got "${values.format}"`);
    return 2;
  }
  const raw = values["fail-above"];
  const failAbove = raw === undefined ? undefined : Number(raw.replace(/%$/, ""));
  if (failAbove !== undefined && (raw!.trim() === "" || !Number.isFinite(failAbove) || failAbove < 0)) {
    err(`--fail-above must be a percentage of zero or more, got "${raw}"`);
    return 2;
  }
  const groupBy = values["group-by"];
  if (groupBy !== undefined && !groupBy.trim()) {
    err(`--group-by needs a label key`);
    return 2;
  }

  const prices = new PriceTable(values.prices ? loadPrices(values.prices) : undefined);
  let result: DiffResult;
  try {
    result = diff([paths[0]!], [paths[1]!], { prices, groupBy });
  } catch (e) {
    if (e instanceof GroupKeyError) {
      err(`--group-by ${groupBy}: ${e.message}`);
      return 2;
    }
    throw e;
  }

  if (values.format === "json") process.stdout.write(renderDiffJson(result) + "\n");
  else
    process.stdout.write(
      renderDiffTable(result, {
        color: process.stdout.isTTY && !process.env.NO_COLOR,
        width: process.stdout.isTTY ? process.stdout.columns : undefined,
      }) + "\n",
    );

  for (const [name, side] of [["base", result.base], ["head", result.head]] as const) {
    if (!side.counted) {
      err(`burnlint: no priced runs in ${name} (${side.paths.join(", ")}); nothing to compare`);
      return 2;
    }
  }
  if (!result.overall) {
    err(`burnlint: no group has priced runs on both sides; nothing was compared`);
    return 2;
  }
  if (failAbove === undefined) return 0;
  const g = gate(result, failAbove);
  const ch = result.overall?.change;
  const rose = ch == null ? "" : `${(ch * 100).toFixed(1)}%`;
  if (g === "can't tell") {
    err(`burnlint: --fail-above ${failAbove}%: can't decide, ${verdictLine(result)}`);
    return 2;
  }
  if (g === "fail") {
    err(`burnlint: cost per run rose ${rose}, above ${failAbove}% (one-sided p=${result.overall!.pHigher.toPrecision(2)})`);
    return 1;
  }
  if (g === "unclear") err(`burnlint: cost per run rose ${rose}, above ${failAbove}%, but not enough runs to tell it from noise; passing`);
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals, tokens } = parseArgs({
    args: argv,
    allowPositionals: true,
    tokens: true,
    options: {
      format: { type: "string", short: "f", default: "table" },
      "fail-on": { type: "string" },
      rule: { type: "string", multiple: true },
      prices: { type: "string" },
      "high-usd": { type: "string" },
      "medium-usd": { type: "string" },
      "runs-per-month": { type: "string" },
      "group-by": { type: "string" },
      "fail-above": { type: "string" },
      out: { type: "string", short: "o" },
      port: { type: "string" },
      verbose: { type: "boolean", short: "v", default: false },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", default: false },
    },
  });

  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  const [command, ...paths] = positionals;
  if (values.help || !command) {
    process.stdout.write(HELP);
    return command || values.help ? 0 : 2;
  }

  const allowed = Object.hasOwn(COMMAND_OPTIONS, command) ? COMMAND_OPTIONS[command] : undefined;
  if (!allowed) {
    process.stderr.write(`unknown command: ${plainText(command)}\n\n${HELP}`);
    return 2;
  }
  const given = new Set(tokens.flatMap((t) => (t.kind === "option" ? [t.name] : [])));
  const stray = [...given].filter((name) => !allowed.includes(name));
  if (stray.length) {
    err(`${command} does not take ${stray.map((name) => `--${name}`).join(", ")}`);
    return 2;
  }

  if (command === "rules") {
    for (const r of rules) process.stdout.write(`${r.id.padEnd(22)} ${r.description}\n`);
    return 0;
  }

  if (command === "record") {
    if (paths.length) {
      err(`record takes no paths (got ${paths.join(" ")}); use --out for the output file`);
      return 2;
    }
    return record(values);
  }

  if (command === "diff") return runDiff(paths, values);

  const format = values.format;
  if (!["table", "json", "md"].includes(format)) {
    err(`--format must be table, json or md, got "${format}"`);
    return 2;
  }
  const unknownRules = (values.rule ?? []).filter((id) => !rules.some((r) => r.id === id));
  if (unknownRules.length) {
    err(`unknown rule: ${unknownRules.join(", ")} (rules: ${rules.map((r) => r.id).join(", ")})`);
    return 2;
  }
  const rawVolume = values["runs-per-month"];
  const runsPerMonth = rawVolume === undefined ? undefined : Number(rawVolume.replace(/[_,]/g, ""));
  if (runsPerMonth !== undefined && (rawVolume!.trim() === "" || !Number.isFinite(runsPerMonth) || runsPerMonth <= 0)) {
    err(`--runs-per-month must be a number above zero, got "${rawVolume}"`);
    return 2;
  }
  const highUsd = usdOption("high-usd", values["high-usd"]);
  const mediumUsd = usdOption("medium-usd", values["medium-usd"]);
  if ((mediumUsd ?? defaultConfig.mediumUsd) > (highUsd ?? defaultConfig.highUsd)) {
    err(`--medium-usd must not be above --high-usd`);
    return 2;
  }

  let targets = paths;
  if (!targets.length) {
    const def = join(homedir(), ".claude", "projects");
    if (!existsSync(def)) {
      process.stderr.write(`no path given and ${def} does not exist\n`);
      return 2;
    }
    targets = [def];
  }
  for (const t of targets) {
    if (!existsSync(t)) {
      process.stderr.write(`not found: ${t}\n`);
      return 2;
    }
  }

  const failOn = values["fail-on"] as Severity | undefined;
  if (failOn && !["high", "medium", "low"].includes(failOn)) {
    process.stderr.write(`--fail-on must be high, medium or low\n`);
    return 2;
  }

  const prices = new PriceTable(values.prices ? loadPrices(values.prices) : undefined);
  const config: Record<string, number> = {};
  if (highUsd !== undefined) config.highUsd = highUsd;
  if (mediumUsd !== undefined) config.mediumUsd = mediumUsd;

  const result = audit(targets, { prices, config, only: values.rule, runsPerMonth });

  if (format === "json") process.stdout.write(renderJson(result) + "\n");
  else if (format === "md") process.stdout.write(renderMarkdown(result) + "\n");
  else
    process.stdout.write(
      renderTable(result, {
        color: process.stdout.isTTY && !process.env.NO_COLOR,
        verbose: values.verbose,
        width: process.stdout.isTTY ? process.stdout.columns : undefined,
      }) + "\n",
    );

  // "No findings" must not pass a CI gate when there was nothing to check.
  if (!result.runs.length) {
    const skipped = result.skippedFiles.length ? `, ${result.skippedFiles.length} file(s) could not be read (-v lists them)` : "";
    err(`burnlint: no agent runs found in ${targets.join(", ")}${skipped}; nothing was audited`);
    return 2;
  }

  if (failOn && result.findings.some((f) => severityRank(f.severity) >= severityRank(failOn))) return 1;
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    err(`burnlint: ${(e as Error).message}`);
    process.exitCode = 2;
  },
);
