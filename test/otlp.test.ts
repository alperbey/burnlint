import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readOtlp } from "../src/adapters/otlp.js";
import { chatSpan, otlp, span, tmpFile, toolSpan } from "./helpers.js";

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
