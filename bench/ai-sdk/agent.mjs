// A read-only code-review agent built on the Vercel AI SDK, run to capture
// real traces for burnlint (roadmap step 2). It answers fixed questions about
// a repository with four tools and exports its spans over OTLP/HTTP JSON to
// `burnlint record`.
//
// Each task runs in up to three variants, so every waste rule has a run where
// it should fire and one where it should stay silent:
//   normal    prompt caching on (top-level cache_control), stable prompt,
//             read_file takes a line range.
//   wasteful  caching on, but the system prompt carries the time and changes
//             every step; read_file has no range; list_files always returns
//             the whole tree; the prompt asks for rereads and repeat searches.
//   nocache   normal, without cache_control (Anthropic caches nothing then).
//
// Checked with: ai 7.0.157, @ai-sdk/anthropic 4.0.92, @ai-sdk/otel 1.0.157,
//   @opentelemetry/api 1.9.1, sdk-trace-node 2.12.1, resources 2.12.1,
//   exporter-trace-otlp-http 0.223.2 (see package.json; npm ci).
//
// Usage (from this folder, with `burnlint record` running):
//   node ../../dist/cli.js record -o ../../captures/ai-sdk.jsonl     # terminal 1
//   ANTHROPIC_API_KEY=... node agent.mjs                              # terminal 2
// Options:
//   --tasks review,explain,principle   --variants normal,wasteful,nocache
//   --telemetry semconv|legacy         (semconv = OpenTelemetry, the v7 default;
//                                       legacy = LegacyOpenTelemetry, ai.* spans)
//   --max-steps 15  --budget 8 (USD, all runs)  --run-cap 1.5 (USD, one run)
//   --repo ../..    --model claude-sonnet-5-5
//   --mock          scripted model, no API key, no cost: checks the pipeline only.
//                   Its traces are not real and must never become a fixture.
//
// Answers and per-run usage go to out/ (runs.jsonl has the trace id of each run,
// for grading outcomes later). Traces carry prompts, tool results and answers,
// as the SDK records them by default; burnlint never prints them.

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { trace, diag, DiagLogLevel } from "@opentelemetry/api";
import { NodeTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-node";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { generateText, isStepCount, registerTelemetry, tool } from "ai";
import { OpenTelemetry, LegacyOpenTelemetry } from "@ai-sdk/otel";
import { z } from "zod";

const { values: opt } = parseArgs({
  options: {
    tasks: { type: "string", default: "review,explain,principle" },
    variants: { type: "string", default: "normal,wasteful,nocache" },
    telemetry: { type: "string", default: "semconv" },
    "max-steps": { type: "string", default: "15" },
    budget: { type: "string", default: "8" },
    "run-cap": { type: "string", default: "1.5" },
    repo: { type: "string", default: "../.." },
    model: { type: "string", default: "claude-sonnet-5-5" },
    mock: { type: "boolean", default: false },
  },
});

const REPO = resolve(opt.repo);
const MAX_STEPS = Number(opt["max-steps"]);
const BUDGET = Number(opt.budget);
const RUN_CAP = Number(opt["run-cap"]);
if (!["semconv", "legacy"].includes(opt.telemetry)) throw new Error("--telemetry must be semconv or legacy");

// Claude Sonnet 5.5, USD per 1M tokens (Anthropic model docs, Nov 2026). Only
// used for the budget guard; burnlint prices the trace with its own table.
const PRICE = { input: 2, output: 10, cacheRead: 0.1, cacheWrite5m: 2.5 };

const TASKS = {
  review:
    "Review commit fd08744 in this repository for correctness bugs. Use git_show to see the change and read the " +
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
  "and cite file:line for every claim.";

const SYSTEM_WASTEFUL =
  "You are a code reviewer working in a read-only checkout of a TypeScript repository. Use the tools to look at " +
  "the code and never guess what a file contains. Always read a file again in full right before you cite it, even " +
  "if you read it earlier. Before your final answer, run each search you made once more to confirm it. Be concise, " +
  "and cite file:line for every claim.";

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

function makeTools(variant) {
  const wasteful = variant === "wasteful";
  const READ_CAP = 400;
  return {
    list_files: tool({
      description: "List files under a directory of the repository (recursive).",
      inputSchema: z.object({ dir: z.string().describe("Directory relative to the repo root").default(".") }),
      execute: safe(({ dir }) => {
        // Wasteful: ignores the directory and returns the whole tree with sizes.
        const root = wasteful ? REPO : inside(dir);
        const files = walk(root);
        const lines = files.map((f) => (wasteful ? `${relative(REPO, f)}\t${statSync(f).size} bytes` : relative(REPO, f)));
        return lines.slice(0, wasteful ? Infinity : 300).join("\n") || "(empty)";
      }),
    }),
    read_file: tool({
      description: wasteful
        ? "Read a whole file, with line numbers."
        : `Read a file with line numbers. Give start_line/end_line for part of it; at most ${READ_CAP} lines per call.`,
      inputSchema: wasteful
        ? z.object({ path: z.string() })
        : z.object({ path: z.string(), start_line: z.number().int().min(1).optional(), end_line: z.number().int().min(1).optional() }),
      execute: safe(({ path, start_line, end_line }) => {
        const lines = readFileSync(inside(path), "utf8").split("\n");
        if (wasteful) return numbered(lines, 1);
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
        const out = execFileSync("git", ["-C", REPO, "show", "--stat", "--patch", "--no-color", commit], {
          encoding: "utf8",
          maxBuffer: 16 << 20,
        });
        return out.length > 80000 ? out.slice(0, 80000) + "\n(diff truncated at 80000 characters)" : out;
      }),
    }),
  };
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
  // Scripted: list, read, read the same file again, grep, answer. Usage grows
  // like a cached conversation would. Pipeline check only, not a real trace.
  const { MockLanguageModelV4 } = await import("ai/test");
  const script = [
    ["list_files", { dir: "src/rules" }],
    ["read_file", { path: "src/audit.ts", start_line: 1, end_line: 60 }],
    ["read_file", { path: "src/audit.ts", start_line: 1, end_line: 60 }],
    ["grep", { pattern: "unitOf", path: "src" }],
  ];
  let n = 0;
  return new MockLanguageModelV4({
    provider: "anthropic.messages",
    modelId: opt.model,
    doGenerate: async () => {
      const i = n++ % (script.length + 1);
      const usage = {
        inputTokens: { total: 1200 + i * 900, noCache: 40, cacheRead: i ? 1200 + (i - 1) * 900 : 0, cacheWrite: i ? 860 : 1160 },
        outputTokens: { total: 80, text: 80, reasoning: 0 },
      };
      const call = script[i];
      return {
        content: call
          ? [{ type: "tool-call", toolCallId: `mock_${n}`, toolName: call[0], input: JSON.stringify(call[1]) }]
          : [{ type: "text", text: "Mock answer: sub-agents roll into their session (src/audit.ts:194)." }],
        finishReason: { unified: call ? "tool-calls" : "stop", raw: call ? "tool_use" : "end_turn" },
        usage,
        response: { id: `msg_mock_${n}`, modelId: opt.model, timestamp: new Date() },
        warnings: [],
      };
    },
  });
}

// ---------- run ----------

async function main() {
  const tasks = opt.tasks.split(",");
  const variants = opt.variants.split(",");
  for (const t of tasks) if (!TASKS[t]) throw new Error(`unknown task ${t}`);
  for (const v of variants) if (!["normal", "wasteful", "nocache"].includes(v)) throw new Error(`unknown variant ${v}`);

  diag.setLogger({ error: console.error, warn: console.error, info() {}, debug() {}, verbose() {} }, DiagLogLevel.WARN);
  const url = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ? undefined : "http://127.0.0.1:4318/v1/traces";
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ "service.name": "burnlint-bench-reviewer" }),
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter(url ? { url } : {}))],
  });
  provider.register();
  registerTelemetry(opt.telemetry === "legacy" ? new LegacyOpenTelemetry() : new OpenTelemetry({ usage: true, providerMetadata: true }));
  const tracer = trace.getTracer("burnlint-bench");

  const model = await makeModel();
  mkdirSync("out", { recursive: true });
  let spent = 0;

  for (const task of tasks) {
    for (const variant of variants) {
      if (spent >= BUDGET) {
        console.log(`budget of $${BUDGET} reached ($${spent.toFixed(2)} spent), skipping the rest`);
        break;
      }
      const label = `${task}-${variant}-${opt.telemetry}${opt.mock ? "-mock" : ""}`;
      await tracer.startActiveSpan("bench.run", { attributes: { "bench.task": task, "bench.variant": variant } }, async (span) => {
        const traceId = span.spanContext().traceId;
        const started = Date.now();
        const record = { traceId, task, variant, telemetry: opt.telemetry, model: opt.model, mock: opt.mock, startedAt: new Date(started).toISOString() };
        try {
          const result = await generateText({
            model,
            instructions: variant === "wasteful" ? SYSTEM_WASTEFUL : SYSTEM,
            prompt: TASKS[task],
            tools: makeTools(variant),
            stopWhen: [isStepCount(MAX_STEPS), ({ steps }) => sumUsd(steps) >= RUN_CAP],
            maxOutputTokens: 4000,
            providerOptions: {
              anthropic: {
                effort: "medium",
                thinking: { type: "between_tools" },
                ...(variant === "nocache" ? {} : { cacheControl: { type: "ephemeral" } }),
              },
            },
            // Wasteful: the time in the system prompt changes the cached prefix every step.
            prepareStep:
              variant === "wasteful" ? () => ({ instructions: `${SYSTEM_WASTEFUL}\nCurrent time: ${new Date().toISOString()}` }) : undefined,
            telemetry: { functionId: `reviewer-${task}` },
          });
          const usd = sumUsd(result.steps);
          spent += usd;
          const u = result.totalUsage;
          Object.assign(record, {
            steps: result.steps.length,
            finishReason: result.finishReason,
            answered: result.finishReason === "stop",
            usage: {
              input: u.inputTokens,
              cacheRead: u.inputTokenDetails?.cacheReadTokens,
              cacheWrite: u.inputTokenDetails?.cacheWriteTokens,
              output: u.outputTokens,
              reasoning: u.outputTokenDetails?.reasoningTokens,
            },
            usd: Number(usd.toFixed(4)),
          });
          writeFileSync(join("out", `${label}.md`), result.text || "(no answer: stopped before a final reply)\n");
          console.log(
            `${label.padEnd(30)} ${String(result.steps.length).padStart(2)} steps  ` +
              `in ${u.inputTokens}  read ${u.inputTokenDetails?.cacheReadTokens ?? "?"}  write ${u.inputTokenDetails?.cacheWriteTokens ?? "?"}  ` +
              `out ${u.outputTokens}  ~$${usd.toFixed(3)}  ${result.finishReason}  trace ${traceId}`,
          );
        } catch (e) {
          record.error = e.message;
          span.recordException(e);
          console.error(`${label}: ${e.message}`);
        } finally {
          record.seconds = Math.round((Date.now() - started) / 1000);
          appendFileSync(join("out", "runs.jsonl"), JSON.stringify(record) + "\n");
          span.end();
          await provider.forceFlush();
        }
      });
    }
  }
  await provider.shutdown();
  console.log(`done, ~$${spent.toFixed(2)} spent by this script's estimate`);
}

await main();
