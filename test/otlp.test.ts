import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readOtlp } from "../src/adapters/otlp.js";
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
