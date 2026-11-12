import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { audit, severityRank } from "./audit.js";
import type { Severity } from "./model.js";
import { PriceTable } from "./pricing.js";
import { renderJson, renderMarkdown, renderTable } from "./report.js";
import { rules } from "./rules/index.js";

const HELP = `burnlint — find wasted tokens and money in agent traces

Usage:
  burnlint audit [paths...]   Lint trace files or folders
  burnlint rules              List rules

Inputs (detected per file):
  Claude Code session logs     ~/.claude/projects/**/*.jsonl (default when no path is given)
  OTLP/JSON traces             OpenTelemetry GenAI spans, .json or .jsonl

Options:
  -f, --format <table|json|md>   Output format (default: table)
      --fail-on <high|medium|low>  Exit 1 if any finding is at or above this severity
      --rule <id>                Only run this rule (repeatable)
      --prices <file.json>       Price overrides: { "model-id": { "input": 3, "output": 15, ... } } in USD per 1M tokens
      --high-usd <n>             Cost for high severity (default 1)
      --medium-usd <n>           Cost for medium severity (default 0.1)
  -v, --verbose                  Show all notes and skipped files
  -h, --help
`;

function main(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      format: { type: "string", short: "f", default: "table" },
      "fail-on": { type: "string" },
      rule: { type: "string", multiple: true },
      prices: { type: "string" },
      "high-usd": { type: "string" },
      "medium-usd": { type: "string" },
      verbose: { type: "boolean", short: "v", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  const [command, ...paths] = positionals;
  if (values.help || !command) {
    process.stdout.write(HELP);
    return command || values.help ? 0 : 2;
  }

  if (command === "rules") {
    for (const r of rules) process.stdout.write(`${r.id.padEnd(22)} ${r.description}\n`);
    return 0;
  }

  if (command !== "audit") {
    process.stderr.write(`unknown command: ${command}\n\n${HELP}`);
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

  const prices = new PriceTable(values.prices ? JSON.parse(readFileSync(values.prices, "utf8")) : undefined);
  const config: Record<string, number> = {};
  if (values["high-usd"]) config.highUsd = Number(values["high-usd"]);
  if (values["medium-usd"]) config.mediumUsd = Number(values["medium-usd"]);

  const result = audit(targets, { prices, config, only: values.rule });

  const format = values.format;
  if (format === "json") process.stdout.write(renderJson(result) + "\n");
  else if (format === "md") process.stdout.write(renderMarkdown(result) + "\n");
  else if (format === "table")
    process.stdout.write(
      renderTable(result, { color: process.stdout.isTTY && !process.env.NO_COLOR, verbose: values.verbose }) + "\n",
    );
  else {
    process.stderr.write(`unknown format: ${format}\n`);
    return 2;
  }

  if (failOn && result.findings.some((f) => severityRank(f.severity) >= severityRank(failOn))) return 1;
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  process.stderr.write(`burnlint: ${(e as Error).message}\n`);
  process.exitCode = 2;
}
