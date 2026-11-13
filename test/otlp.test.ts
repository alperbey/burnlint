import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readOtlp } from "../src/adapters/otlp.js";
import { audit } from "../src/audit.js";
import type { Turn } from "../src/model.js";
import { PriceTable } from "../src/pricing.js";
import { cacheThrash } from "../src/rules/cache-thrash.js";
import { rereadUnchanged } from "../src/rules/reread-unchanged.js";
import { defaultConfig } from "../src/rules/types.js";
import { chatSpan, otlp, span, tmpFile, toolSpan } from "./helpers.js";

const ctx = { prices: new PriceTable(), config: defaultConfig };

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("real openai-v2 instrumentation trace: DeepSeek relabeled, cache unknown", () => {
  const [run] = readOtlp(join(root, "fixtures", "otel-deepseek-via-openai.json"));
  assert.equal(run!.turns.length, 3);
  for (const t of run!.turns) {
    assert.equal(t.call.provider, "deepseek");
    assert.equal(t.call.providerSource, "relabeled");
    assert.equal(t.call.reportedProvider, "openai");
    assert.equal(t.call.tokens!.cacheKnown, false);
  }
  assert.equal(run!.turns[0]!.tools[0]!.target, "src/app.py");
  assert.match(run!.notes.join("\n"), /upper bound/);
  // base64 ids from the protobuf JSON mapping are normalized to hex
  assert.match(run!.id, /#[0-9a-f]{12}$/);
});

test("cache attributes are subtracted from total input", () => {
  const file = tmpFile(
    "t.json",
    JSON.stringify(
      otlp([
        chatSpan("1", 0, {
          "gen_ai.provider.name": "anthropic",
          "gen_ai.request.model": "claude-sonnet-4-6",
          "gen_ai.usage.input_tokens": 10000,
          "gen_ai.usage.cache_read.input_tokens": 8000,
          "gen_ai.usage.cache_creation.input_tokens": 1500,
          "gen_ai.usage.output_tokens": 300,
        }),
      ]),
    ),
  );
  const t = readOtlp(file)[0]!.turns[0]!.call.tokens!;
  assert.equal(t.input, 500);
  assert.equal(t.cacheRead, 8000);
  assert.equal(t.cacheWriteOther, 1500);
  assert.equal(t.cacheKnown, true);
});

test("server address beats reported provider", () => {
  const file = tmpFile(
    "t.json",
    JSON.stringify(
      otlp([
        chatSpan("1", 0, {
          "gen_ai.provider.name": "openai",
          "gen_ai.request.model": "some-custom-name",
          "server.address": "api.deepseek.com",
          "gen_ai.usage.input_tokens": 100,
          "gen_ai.usage.output_tokens": 10,
        }),
      ]),
    ),
  );
  const c = readOtlp(file)[0]!.turns[0]!.call;
  assert.equal(c.provider, "deepseek");
  assert.equal(c.providerSource, "relabeled");
});

test("hosting platforms are not relabeled", () => {
  const file = tmpFile(
    "t.json",
    JSON.stringify(
      otlp([
        chatSpan("1", 0, {
          "gen_ai.provider.name": "aws.bedrock",
          "gen_ai.request.model": "anthropic.claude-sonnet-4-6",
          "gen_ai.usage.input_tokens": 100,
          "gen_ai.usage.output_tokens": 10,
        }),
      ]),
    ),
  );
  assert.equal(readOtlp(file)[0]!.turns[0]!.call.providerSource, "reported");
});

test("aggregate parent spans with usage are skipped", () => {
  const file = tmpFile(
    "t.json",
    JSON.stringify(
      otlp([
        span({ id: "a", name: "invoke_agent x", start: 0, attrs: { "gen_ai.operation.name": "invoke_agent", "gen_ai.usage.input_tokens": 300, "gen_ai.usage.output_tokens": 30 } }),
        chatSpan("1", 1, { "gen_ai.request.model": "gpt-5.5", "gen_ai.usage.input_tokens": 100, "gen_ai.usage.output_tokens": 10 }, "a"),
        chatSpan("2", 5, { "gen_ai.request.model": "gpt-5.5", "gen_ai.usage.input_tokens": 200, "gen_ai.usage.output_tokens": 20 }, "a"),
      ]),
    ),
  );
  const run = readOtlp(file)[0]!;
  assert.equal(run.turns.length, 2);
  assert.match(run.notes.join("\n"), /aggregate/);
});

test("a truncated JSONL line is skipped and noted, the rest of the file is read", () => {
  const good = JSON.stringify(otlp([chatSpan("1", 0, { "gen_ai.request.model": "gpt-5.5", "gen_ai.usage.input_tokens": 100, "gen_ai.usage.output_tokens": 10 })]));
  const run = readOtlp(tmpFile("t.jsonl", `${good}\n{"resourceSpans":[{"scope`))[0]!;
  assert.equal(run.turns.length, 1);
  assert.match(run.notes.join("\n"), /1 unparseable line\(s\) skipped/);
  assert.throws(() => readOtlp(tmpFile("t.jsonl", `{"resourceSpans":[{"scope`)), /not valid JSON/);
});

test("JSONL with one request per line; tools attach to the preceding call", () => {
  const lines = [
    otlp([chatSpan("1", 0, { "gen_ai.request.model": "gpt-5.5", "gen_ai.usage.input_tokens": 100, "gen_ai.usage.output_tokens": 10 })]),
    otlp([toolSpan("2", 3, "read_file", { path: "a.py" })]),
    otlp([chatSpan("3", 6, { "gen_ai.request.model": "gpt-5.5", "gen_ai.usage.input_tokens": 1200, "gen_ai.usage.output_tokens": 10 })]),
  ];
  const file = tmpFile("t.jsonl", lines.map((l) => JSON.stringify(l)).join("\n"));
  const run = readOtlp(file)[0]!;
  assert.equal(run.turns.length, 2);
  assert.equal(run.turns[0]!.tools.length, 1);
  assert.equal(run.turns[0]!.tools[0]!.resultTokens, 1000);
  assert.equal(run.turns[1]!.tools.length, 0);
});

test("a model span with error status and no usage is a failed call, not a call without usage", () => {
  const failed = { ...chatSpan("1", 0, { "gen_ai.provider.name": "anthropic", "gen_ai.request.model": "claude-sonnet-4-6" }), status: { code: 2, message: "invalid x-api-key" } };
  const ok = chatSpan("2", 10, {
    "gen_ai.provider.name": "anthropic",
    "gen_ai.request.model": "claude-sonnet-4-6",
    "gen_ai.usage.input_tokens": 100,
    "gen_ai.usage.output_tokens": 10,
  });
  const run = readOtlp(tmpFile("t.json", JSON.stringify(otlp([failed, ok]))))[0]!;
  assert.equal(run.turns[0]!.call.failed, true);
  assert.equal(run.turns[1]!.call.failed, undefined);
  assert.match(run.notes.join("\n"), /1 model call\(s\) failed with an error status/);
  assert.doesNotMatch(run.notes.join("\n"), /no usage data/);
  // The string form some JSON encoders use is read too.
  const named = { ...failed, status: { code: "STATUS_CODE_ERROR" } };
  assert.equal(readOtlp(tmpFile("t.json", JSON.stringify(otlp([named]))))[0]!.turns[0]!.call.failed, true);
});

test("a prompt that shrinks starts a new context: repeat and cache rules start over there", () => {
  const usage = (input: number, read: number, write: number) => ({
    "gen_ai.provider.name": "anthropic",
    "gen_ai.request.model": "claude-sonnet-4-6",
    "gen_ai.usage.input_tokens": input,
    "gen_ai.usage.cache_read.input_tokens": read,
    "gen_ai.usage.cache_creation.input_tokens": write,
    "gen_ai.usage.output_tokens": 50,
  });
  // Real shape (AI SDK 7, a second generateText call in the same trace that was given only
  // the first call's final answer): the prompt drops from ~5.8k to ~1.6k tokens.
  const spans = (third: Record<string, string | number>) => [
    chatSpan("1", 0, usage(3000, 0, 2990)),
    toolSpan("2", 10, "read_file", { path: "src/a.ts" }),
    chatSpan("3", 20, usage(5800, 2990, 2800)),
    chatSpan("4", 30, third),
    toolSpan("5", 40, "read_file", { path: "src/a.ts" }),
  ];
  const reset = readOtlp(tmpFile("t.json", JSON.stringify(otlp(spans(usage(1640, 1069, 568))))))[0]!;
  assert.equal(reset.turns[2]!.contextReplacedBefore, true);
  assert.match(reset.notes.join("\n"), /1 context reset\(s\)/);
  assert.equal(rereadUnchanged.check(reset, ctx).length, 0);
  assert.equal(cacheThrash.check(reset, ctx).length, 0);
  // The same calls in one growing conversation: the second read is a reread.
  const grown = readOtlp(tmpFile("t.json", JSON.stringify(otlp(spans(usage(6500, 5790, 700))))))[0]!;
  assert.equal(grown.turns[2]!.contextReplacedBefore, undefined);
  assert.equal(rereadUnchanged.check(grown, ctx).length, 1);
  // A small dip (a dropped thinking block) is not a reset.
  const dip = readOtlp(tmpFile("t.json", JSON.stringify(otlp(spans(usage(5500, 5400, 90))))))[0]!;
  assert.equal(dip.turns[2]!.contextReplacedBefore, undefined);
});

// Real AI SDK 7 captures (bench/ai-sdk/agent.mjs, Claude Sonnet 5.5), redacted with
// scripts/redact-capture.mjs. Each file: an "explain" run in the normal variant, the same
// task with the time in the system prompt (prefix busted every step), and a run whose only
// call failed. Each run has two generateText calls in one trace (answer, then check), and the
// check call was given only the final answer, so its prompt shrinks: a context reset.
// Token totals below are what the SDK itself reported for the run (result.totalUsage), not
// read from the trace.
const SDK_TOTALS: Record<string, { input: number; read: number; write: number; output: number }> = {
  "5ce38dc5fa89": { input: 24825, read: 13293, write: 11512, output: 2176 }, // legacy normal
  "829c8f1f9a32": { input: 36708, read: 0, write: 36688, output: 2538 }, // legacy prefix
  f16f2c15d069: { input: 26447, read: 14578, write: 11849, output: 2440 }, // semconv normal
  "694b0ad6abc2": { input: 27950, read: 0, write: 27932, output: 2326 }, // semconv prefix
};

for (const [format, failedId] of [["legacy", "9cdd1c67f10a"], ["semconv", "e49833e1bce0"]] as const) {
  test(`real AI SDK 7 capture (${format}): cost matches the SDK's own usage, failed run counted apart`, () => {
    const file = join(root, "fixtures", `ai-sdk-v7-${format}.jsonl`);
    const runs = readOtlp(file);
    const price = new PriceTable().lookup("claude-sonnet-5-5")!;
    for (const run of runs) {
      const id = run.id.split("#")[1]!;
      assert.equal(run.dialect, format === "legacy" ? "ai-sdk" : "gen_ai");
      if (id === failedId) {
        assert.equal(run.turns.length, 1);
        assert.equal(run.turns[0]!.call.failed, true);
        continue;
      }
      const want = SDK_TOTALS[id]!;
      const sum = (f: (t: NonNullable<Turn["call"]["tokens"]>) => number) => run.turns.reduce((s, t) => s + f(t.call.tokens!), 0);
      assert.equal(sum((t) => t.cacheRead ?? 0), want.read);
      assert.equal(sum((t) => t.cacheWriteOther ?? 0), want.write);
      assert.equal(sum((t) => t.input! + (t.cacheRead ?? 0) + (t.cacheWriteOther ?? 0)), want.input);
      assert.equal(sum((t) => t.output ?? 0), want.output);
      assert.equal(run.turns.filter((t) => t.contextReplacedBefore).length, 1);
      assert.ok(run.turns.some((t) => t.tools.some((x) => x.name === "read_file" && x.kind === "read" && x.resultTokens! > 0)));
    }
    const r = audit([file]);
    for (const s of r.runs.filter((x) => !x.id.endsWith(failedId))) {
      const t = SDK_TOTALS[s.id.split("#")[1]!]!;
      const want = ((t.input - t.read - t.write) * price.input! + t.read * price.cacheRead! + t.write * price.cacheWrite5m! + t.output * price.output!) / 1e6;
      assert.ok(Math.abs(s.costUsd - want) < 1e-9, `${s.id}: ${s.costUsd} vs ${want}`);
    }
    assert.deepEqual(r.excludedRuns, { failed: 1, unpriced: 0 });
    assert.equal(r.perRun!.count, 2);
  });

  test(`real AI SDK 7 capture (${format}): cache-thrash only on the busted prefix, savable = stable-prefix counterfactual`, () => {
    const file = join(root, "fixtures", `ai-sdk-v7-${format}.jsonl`);
    const r = audit([file]);
    const price = new PriceTable().lookup("claude-sonnet-5-5")!;
    const rate = price.cacheWrite5m! - price.cacheRead!;
    for (const run of readOtlp(file)) {
      const findings = r.findings.filter((f) => f.runId === run.id);
      const busted = SDK_TOTALS[run.id.split("#")[1]!]?.read === 0;
      assert.deepEqual(findings.map((f) => f.rule), busted ? ["cache-thrash"] : [], run.id);
      if (!busted) continue;
      // Each call would have read what the previous call cached; skip the reset and tiny losses.
      let want = 0;
      run.turns.forEach((t, i) => {
        if (!i || t.contextReplacedBefore) return;
        const p = run.turns[i - 1]!.call.tokens!;
        const lost = (p.cacheRead ?? 0) + (p.cacheWriteOther ?? 0) - (t.call.tokens!.cacheRead ?? 0);
        if (lost >= 1024) want += (Math.min(lost, t.call.tokens!.cacheWriteOther ?? 0) * rate) / 1e6;
      });
      assert.ok(want > 0);
      assert.ok(Math.abs(findings[0]!.avoidableUsd! - want) < 1e-9, `${findings[0]!.avoidableUsd} vs ${want}`);
    }
  });
}
