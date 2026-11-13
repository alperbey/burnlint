// A read-only code-review agent built on the Vercel AI SDK, run to capture
// real traces for burnlint (roadmap step 2). It answers fixed questions about
// a repository with four tools and exports its spans over OTLP/HTTP JSON to
// `burnlint record`.
//
// Each run has two phases in one trace: answer the task, then check the
// answer (a self-check pass, common in real agents). Variants differ from
// `normal` in exactly one way, so each waste can be priced on its own:
//   normal   prompt caching on (top-level cache_control), stable prompt,
//            read_file takes a line range; the check uses what was read.
//   prefix   the system prompt ends with the current time, changed every
//            step, so the cached prefix is lost each call.
//   nocache  no cache_control (Anthropic then caches nothing).
//   reread   the check phase is told to read every cited file again.
//
// Controls:
// - A per-run marker opens the system prompt, so runs can't read each other's
//   caches (the first capture's runs did, which skewed the baseline).
// - --repeat runs every cell several times; one run per cell is too noisy.
// - Each answer is graded with deterministic checks (see grade()): it must
//   cite file:line, every citation must exist, and task-specific facts must
//   appear. That says the answer is grounded, not that it is right.
//
// Checked with: ai 7.0.157, @ai-sdk/anthropic 4.0.92, @ai-sdk/otel 1.0.157,
//   @opentelemetry/api 1.9.1, sdk-trace-node 2.12.1, resources 2.12.1,
//   exporter-trace-otlp-http 0.223.2 (see package.json; npm ci).
//
// Usage (from this folder, with `burnlint record` running):
//   node ../../dist/cli.js record -o ../../captures/ai-sdk-2.jsonl   # terminal 1
//   ANTHROPIC_API_KEY=... node agent.mjs                              # terminal 2
// Options:
//   --tasks review,explain,principle   --variants normal,prefix,nocache,reread
//   --repeat 3
//   --telemetry semconv|legacy         (semconv = OpenTelemetry, the v7 default;
//                                       legacy = LegacyOpenTelemetry, ai.* spans)
//   --max-steps 15 (answer phase; the check phase gets 8)
//   --budget 15 (USD, all runs)  --run-cap 1.5 (USD, one run)
//   --repo ../..    --model claude-sonnet-5-5
//   --grade <dir>   re-grade saved answers (<...>-<task>-<variant>-...md) and exit.
//   --mock          scripted model, no API key, no cost: checks the pipeline only.
//                   Its traces are not real and must never become a fixture.
//
// Answers and per-run results go to out/ (runs.jsonl: trace id, usage, grade;
// `batch` tells invocations apart). Traces carry prompts, tool results and
// answers, as the SDK records them by default; burnlint never prints them.

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { trace, diag, DiagLogLevel } from "@opentelemetry/api";
import { NodeTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-node";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { generateText, isStepCount, registerTelemetry, tool } from "ai";
import { OpenTelemetry, LegacyOpenTelemetry } from "@ai-sdk/otel";
import { z } from "zod";

const VARIANTS = ["normal", "prefix", "nocache", "reread"];

const { values: opt } = parseArgs({
  options: {
    tasks: { type: "string", default: "review,explain,principle" },
    variants: { type: "string", default: VARIANTS.join(",") },
    repeat: { type: "string", default: "3" },
    telemetry: { type: "string", default: "semconv" },
    "max-steps": { type: "string", default: "15" },
    budget: { type: "string", default: "15" },
    "run-cap": { type: "string", default: "1.5" },
    repo: { type: "string", default: "../.." },
    model: { type: "string", default: "claude-sonnet-5-5" },
    mock: { type: "boolean", default: false },
    grade: { type: "string" },
  },
});

const REPO = resolve(opt.repo);
const MAX_STEPS = Number(opt["max-steps"]);
const CHECK_STEPS = 8;
const REPEAT = Number(opt.repeat);
const BUDGET = Number(opt.budget);
const RUN_CAP = Number(opt["run-cap"]);
for (const [k, v] of Object.entries({ "max-steps": MAX_STEPS, repeat: REPEAT, budget: BUDGET, "run-cap": RUN_CAP }))
  if (!(v > 0)) throw new Error(`--${k} must be a positive number`);
if (!["semconv", "legacy"].includes(opt.telemetry)) throw new Error("--telemetry must be semconv or legacy");

// Claude Sonnet 5.5, USD per 1M tokens (Anthropic model docs, Nov 2026). Only
// used for the budget guard; burnlint prices the trace with its own table.
const PRICE = { input: 2, output: 10, cacheRead: 0.1, cacheWrite5m: 2.5 };

const REVIEW_COMMIT = "fd08744";

const TASKS = {
  review:
    `Review commit ${REVIEW_COMMIT} in this repository for correctness bugs. Use git_show to see the change and read the ` +
    "surrounding code where you need it. Report at most 5 findings, each with file:line, what goes wrong and a " +
    "concrete input that triggers it. If you find none, say so.",
  explain:
    "In this repository, how are sub-agents counted when computing cost per run? Trace it from where a Claude Code " +
    "log is read to where the per-run statistics are computed. Answer in under 200 words and cite file:line for each step.",
  principle:
    "This tool promises that findings never include tool inputs (queries, commands). Check every place under " +
    "src/rules/ where a finding's message or details are built, and say whether any of them can include a tool " +
    "input. Cite file:line for each place you checked.",
};

const SYSTEM =
  "You are a code reviewer working in a read-only checkout of a TypeScript repository. Use the tools to look at " +
  "the code and never guess what a file contains. Prefer grep and line ranges over reading whole files. Be concise, " +
  "and cite every claim as path:line, with the path relative to the repository root.";

const CHECK = {
  normal:
    "Check your answer before you finish. Use what you have already read; call a tool only for code you have not " +
    "looked at yet. Then give your final answer in full, corrected where needed.",
  reread:
    "Check your answer before you finish. Read every file you cited again with read_file, then give your final " +
    "answer in full, corrected where needed.",
};

// ---------- tools (read-only, confined to the repo) ----------

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "out", "captures"]);

function inside(p) {
  const abs = resolve(REPO, p ?? ".");
  const rel = relative(REPO, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`${p} is outside the repository`);
  const parts = rel.split(sep);
  if (parts.some((s) => SKIP_DIRS.has(s))) throw new Error(`${p} is not available`);
  if (/^\.env/.test(basename(abs))) throw new Error(`${p} is not available`);
  return abs;
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    if (SKIP_DIRS.has(name) || name.startsWith(".env")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const safe = (fn) => async (input) => {
  try {
    return fn(input);
  } catch (e) {
    return `error: ${e.message}`;
  }
};

const numbered = (lines, from) => lines.map((l, i) => `${from + i}\t${l}`).join("\n");

const READ_CAP = 400;
const tools = {
  list_files: tool({
    description: "List files under a directory of the repository (recursive).",
    inputSchema: z.object({ dir: z.string().describe("Directory relative to the repo root").default(".") }),
    execute: safe(({ dir }) => walk(inside(dir)).map((f) => relative(REPO, f)).slice(0, 300).join("\n") || "(empty)"),
  }),
  read_file: tool({
    description: `Read a file with line numbers. Give start_line/end_line for part of it; at most ${READ_CAP} lines per call.`,
    inputSchema: z.object({ path: z.string(), start_line: z.number().int().min(1).optional(), end_line: z.number().int().min(1).optional() }),
    execute: safe(({ path, start_line, end_line }) => {
      const lines = readFileSync(inside(path), "utf8").split("\n");
      const from = start_line ?? 1;
      const to = Math.min(end_line ?? lines.length, from + READ_CAP - 1, lines.length);
      const more = to < lines.length ? `\n(${lines.length} lines; continue with start_line=${to + 1})` : "";
      return numbered(lines.slice(from - 1, to), from) + more;
    }),
  }),
  grep: tool({
    description: "Search files for a regular expression. Returns file:line: text, at most 80 matches.",
    inputSchema: z.object({ pattern: z.string(), path: z.string().describe("File or directory").default(".") }),
    execute: safe(({ pattern, path }) => {
      const re = new RegExp(pattern);
      const root = inside(path);
      const files = statSync(root).isDirectory() ? walk(root) : [root];
      const hits = [];
      for (const f of files) {
        const lines = readFileSync(f, "utf8").split("\n");
        lines.forEach((l, i) => re.test(l) && hits.push(`${relative(REPO, f)}:${i + 1}: ${l.trim().slice(0, 200)}`));
        if (hits.length >= 80) break;
      }
      return hits.slice(0, 80).join("\n") || "no matches";
    }),
  }),
  git_show: tool({
    description: "Show a commit's message, changed files and diff.",
    inputSchema: z.object({ commit: z.string().describe("Commit hash, 7-40 hex characters") }),
    execute: safe(({ commit }) => {
      if (!/^[0-9a-f]{7,40}$/.test(commit)) throw new Error("commit must be a 7-40 character hex hash");
      const out = git("show", "--stat", "--patch", "--no-color", commit);
      return out.length > 80000 ? out.slice(0, 80000) + "\n(diff truncated at 80000 characters)" : out;
    }),
  }),
};

function git(...args) {
  return execFileSync("git", ["-C", REPO, ...args], { encoding: "utf8", maxBuffer: 16 << 20 });
}

// ---------- grading (deterministic; grounded, not necessarily right) ----------

const repoFiles = () => walk(REPO).map((f) => relative(REPO, f).split(sep).join("/"));

/** Line counts of a file now and, for the review task, at the reviewed commit. */
function lineCounts(path) {
  const counts = [];
  try {
    counts.push(readFileSync(join(REPO, path), "utf8").split("\n").length);
  } catch {}
  try {
    counts.push(git("show", `${REVIEW_COMMIT}:${path}`).split("\n").length);
  } catch {}
  return counts;
}

function grade(task, answer) {
  const files = repoFiles();
  const cites = [...answer.matchAll(/([\w./-]+\.(?:ts|mjs|js|json|md)):(\d+)(?:[-–](\d+))?/g)].map((m) => ({
    path: m[1].replace(/^\.\//, ""),
    line: Number(m[3] ?? m[2]),
  }));
  // A citation is valid if it names a real file (full path, or a unique suffix of one) and a line inside it.
  const resolved = cites.map((c) => {
    const matches = files.filter((f) => f === c.path || f.endsWith("/" + c.path));
    const path = matches.length === 1 ? matches[0] : undefined;
    return { ...c, path, ok: path != null && c.line >= 1 && lineCounts(path).some((n) => c.line <= n) };
  });
  const cited = (re) => resolved.some((c) => c.ok && re.test(c.path));
  const checks = {
    answered: answer.trim().length > 0,
    cites: resolved.length > 0,
    citationsValid: resolved.length > 0 && resolved.every((c) => c.ok),
  };
  if (task === "explain") {
    checks.citesAudit = cited(/(^|\/)src\/audit\.ts$/);
    checks.citesClaudeCodeReader = cited(/(^|\/)src\/adapters\/claude-code\.ts$/);
    checks.mentionsSession = /session/i.test(answer);
  } else if (task === "principle") {
    for (const rule of ["cache-thrash", "duplicate-tool-call", "reread-unchanged"]) checks[`cites:${rule}`] = cited(new RegExp(`src/rules/${rule}\\.ts$`));
  } else if (task === "review") {
    const changed = new Set(git("show", "--name-only", "--format=", REVIEW_COMMIT).trim().split("\n"));
    checks.citesChangedFile = resolved.some((c) => c.ok && changed.has(c.path)) || /no (correctness )?bugs|none found|found none/i.test(answer);
  }
  return { pass: Object.values(checks).every(Boolean), checks, citations: resolved.length, invalid: resolved.filter((c) => !c.ok).length };
}

// ---------- cost (budget guard only) ----------

function usdOf(u) {
  const d = u.inputTokenDetails ?? {};
  const read = d.cacheReadTokens ?? 0;
  const write = d.cacheWriteTokens ?? 0;
  const plain = d.noCacheTokens ?? Math.max(0, (u.inputTokens ?? 0) - read - write);
  return (plain * PRICE.input + read * PRICE.cacheRead + write * PRICE.cacheWrite5m + (u.outputTokens ?? 0) * PRICE.output) / 1e6;
}
const sumUsd = (steps) => steps.reduce((s, st) => s + usdOf(st.usage), 0);

// ---------- model ----------

async function makeModel() {
  if (!opt.mock) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set (or use --mock)");
    const { anthropic } = await import("@ai-sdk/anthropic");
    return anthropic(opt.model);
  }
  // Scripted: per phase, list, read, grep, answer. Usage grows like a cached
  // conversation would. Pipeline check only, not a real trace.
  const { MockLanguageModelV4 } = await import("ai/test");
  const script = [
    ["list_files", { dir: "src/rules" }],
    ["read_file", { path: "src/audit.ts", start_line: 190, end_line: 200 }],
    ["grep", { pattern: "unitOf", path: "src" }],
  ];
  let n = 0;
  return new MockLanguageModelV4({
    provider: "anthropic.messages",
    modelId: opt.model,
    doGenerate: async () => {
      const i = n++ % (script.length + 1);
      const call = script[i];
      return {
        content: call
          ? [{ type: "tool-call", toolCallId: `mock_${n}`, toolName: call[0], input: JSON.stringify(call[1]) }]
          : [{ type: "text", text: "Mock answer: sub-agents roll into their session (src/audit.ts:194, src/adapters/claude-code.ts:90)." }],
        finishReason: { unified: call ? "tool-calls" : "stop", raw: call ? "tool_use" : "end_turn" },
        usage: {
          inputTokens: { total: 1200 + i * 900, noCache: 40, cacheRead: i ? 1200 + (i - 1) * 900 : 0, cacheWrite: i ? 860 : 1160 },
          outputTokens: { total: 80, text: 80, reasoning: 0 },
        },
        response: { id: `msg_mock_${n}`, modelId: opt.model, timestamp: new Date() },
        warnings: [],
      };
    },
  });
}

// ---------- run ----------

async function runOnce(model, task, variant, rep, batch, tracer) {
  const label = `${task}-${variant}-${rep}-${opt.telemetry}${opt.mock ? "-mock" : ""}`;
  return tracer.startActiveSpan(
    "bench.run",
    { attributes: { "bench.task": task, "bench.variant": variant, "bench.rep": rep, "bench.batch": batch } },
    async (span) => {
      const traceId = span.spanContext().traceId;
      const started = Date.now();
      const record = { batch, traceId, task, variant, rep, telemetry: opt.telemetry, model: opt.model, mock: opt.mock, startedAt: new Date(started).toISOString() };
      // The marker opens the system prompt, so no other run shares a cached prefix with this one.
      const system = `Run ${randomUUID().slice(0, 8)}. ${SYSTEM}`;
      const common = {
        model,
        tools,
        maxOutputTokens: 4000,
        providerOptions: {
          anthropic: {
            effort: "medium",
            thinking: { type: "between_tools" },
            ...(variant === "nocache" ? {} : { cacheControl: { type: "ephemeral" } }),
          },
        },
        instructions: system,
        // prefix: the time at the end of the system prompt changes the cached prefix every step.
        prepareStep: variant === "prefix" ? () => ({ instructions: `${system}\nCurrent time: ${new Date().toISOString()}` }) : undefined,
        telemetry: { functionId: `reviewer-${task}` },
      };
      let usd = 0;
      try {
        const answer = await generateText({
          ...common,
          prompt: TASKS[task],
          stopWhen: [isStepCount(MAX_STEPS), ({ steps }) => sumUsd(steps) >= RUN_CAP],
        });
        usd += sumUsd(answer.steps);
        const check = await generateText({
          ...common,
          messages: [
            { role: "user", content: TASKS[task] },
            // All steps' messages. In AI SDK 7, `response.messages` holds only the last
            // step (the second capture used it, so its check phase lost every tool result).
            ...answer.responseMessages,
            { role: "user", content: variant === "reread" ? CHECK.reread : CHECK.normal },
          ],
          stopWhen: [isStepCount(CHECK_STEPS), ({ steps }) => usd + sumUsd(steps) >= RUN_CAP],
        });
        usd += sumUsd(check.steps);
        const text = check.text || answer.text;
        const tot = (pick) => (pick(answer.totalUsage) ?? 0) + (pick(check.totalUsage) ?? 0);
        const g = grade(task, text);
        Object.assign(record, {
          steps: answer.steps.length + check.steps.length,
          answerSteps: answer.steps.length,
          finishReason: check.finishReason,
          answered: check.finishReason === "stop",
          usage: {
            input: tot((u) => u.inputTokens),
            cacheRead: tot((u) => u.inputTokenDetails?.cacheReadTokens),
            cacheWrite: tot((u) => u.inputTokenDetails?.cacheWriteTokens),
            output: tot((u) => u.outputTokens),
          },
          usd: Number(usd.toFixed(4)),
          grade: g,
        });
        writeFileSync(join("out", `${batch}-${label}.md`), text || "(no answer: stopped before a final reply)\n");
        const u = record.usage;
        console.log(
          `${label.padEnd(28)} ${String(record.steps).padStart(2)} steps  in ${u.input}  read ${u.cacheRead}  write ${u.cacheWrite}  ` +
            `out ${u.output}  ~$${usd.toFixed(3)}  ${check.finishReason}  ${g.pass ? "pass" : "FAIL " + Object.keys(g.checks).filter((k) => !g.checks[k]).join(",")}`,
        );
      } catch (e) {
        record.error = e.message;
        span.recordException(e);
        console.error(`${label}: ${e.message}`);
      } finally {
        record.usd ??= Number(usd.toFixed(4));
        record.seconds = Math.round((Date.now() - started) / 1000);
        appendFileSync(join("out", "runs.jsonl"), JSON.stringify(record) + "\n");
        span.end();
      }
      return { usd, error: record.error };
    },
  );
}

async function main() {
  const tasks = opt.tasks.split(",");
  const variants = opt.variants.split(",");
  for (const t of tasks) if (!TASKS[t]) throw new Error(`unknown task ${t}`);
  for (const v of variants) if (!VARIANTS.includes(v)) throw new Error(`unknown variant ${v} (${VARIANTS.join(", ")})`);
  if (!opt.mock && !existsSync(join(REPO, ".git"))) throw new Error(`${REPO} is not a git checkout`);

  diag.setLogger({ error: console.error, warn: console.error, info() {}, debug() {}, verbose() {} }, DiagLogLevel.WARN);
  const url = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ? undefined : "http://127.0.0.1:4318/v1/traces";
  const provider = new NodeTracerProvider({
    // Scripted runs are named apart, so they can't pass for real ones in a shared capture.
    resource: resourceFromAttributes({ "service.name": opt.mock ? "burnlint-bench-reviewer-MOCK" : "burnlint-bench-reviewer" }),
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter(url ? { url } : {}))],
  });
  provider.register();
  registerTelemetry(opt.telemetry === "legacy" ? new LegacyOpenTelemetry() : new OpenTelemetry({ usage: true, providerMetadata: true }));
  const tracer = trace.getTracer("burnlint-bench");

  const model = await makeModel();
  mkdirSync("out", { recursive: true });
  const batch = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const total = REPEAT * tasks.length * variants.length;
  console.log(`batch ${batch}: ${total} runs (${tasks.length} tasks x ${variants.length} variants x ${REPEAT}), budget $${BUDGET}`);
  let spent = 0;
  let failures = 0;

  // Repeat-major order, so a budget stop leaves complete rounds rather than missing cells.
  outer: for (let rep = 1; rep <= REPEAT; rep++) {
    for (const task of tasks) {
      for (const variant of variants) {
        if (spent >= BUDGET) {
          console.log(`budget of $${BUDGET} reached ($${spent.toFixed(2)} spent), stopping`);
          break outer;
        }
        const { usd, error } = await runOnce(model, task, variant, rep, batch, tracer);
        spent += usd;
        await provider.forceFlush();
        if (error && ++failures >= 3 && spent === 0) {
          console.log("3 runs failed before spending anything; stopping (check the API key)");
          break outer;
        }
      }
    }
  }
  await provider.shutdown();
  console.log(`done, ~$${spent.toFixed(2)} spent by this script's estimate; results in out/runs.jsonl (batch ${batch})`);
}

if (opt.grade) {
  for (const name of readdirSync(opt.grade).filter((n) => n.endsWith(".md")).sort()) {
    const task = Object.keys(TASKS).find((t) => new RegExp(`(^|-)${t}-`).test(name));
    if (!task) continue;
    const g = grade(task, readFileSync(join(opt.grade, name), "utf8"));
    const failed = Object.keys(g.checks).filter((k) => !g.checks[k]);
    console.log(`${name.padEnd(48)} ${g.pass ? "pass" : "FAIL " + failed.join(",")}  (${g.citations} citations, ${g.invalid} invalid)`);
  }
} else {
  await main();
}
