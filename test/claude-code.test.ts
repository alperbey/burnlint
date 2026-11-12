import { test } from "node:test";
import assert from "node:assert/strict";
import { readClaudeCode } from "../src/adapters/claude-code.js";
import { callCost, PriceTable } from "../src/pricing.js";
import { ccAssistant, ccToolResult, ccUser, jsonl, tmpFile } from "./helpers.js";

test("split assistant lines with one message id count usage once", () => {
  const usage = { input_tokens: 2, output_tokens: 1366, cache_read_input_tokens: 138591, cache_creation_input_tokens: 156248, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 156248 } };
  const file = tmpFile(
    "s.jsonl",
    jsonl([
      ccUser("hi"),
      ccAssistant({ id: "m1", model: "claude-opus-5-5", usage, text: "thinking" }),
      ccAssistant({ id: "m1", model: "claude-opus-5-5", usage, text: "answer" }),
      ccAssistant({ id: "m1", model: "claude-opus-5-5", usage, tools: [{ id: "t1", name: "Bash", input: { command: "ls" } }] }),
    ]),
  );
  const [run] = readClaudeCode(file);
  assert.equal(run!.turns.length, 1);
  assert.equal(run!.turns[0]!.tools.length, 1);
  const t = run!.turns[0]!.call.tokens!;
  assert.equal(t.cacheWrite1h, 156248);
  assert.equal(t.cacheWrite5m, 0);
  // Hand calculation at opus-5-5 prices ($4 in, $20 out, $0.2 read, $8 1h write):
  // 2*4 + 1366*20 + 138591*0.2 + 156248*8 = 8 + 27,320 + 27,718.2 + 1,249,984 = 1,305,030.2 per 1e6
  const cost = callCost(run!.turns[0]!.call, new PriceTable());
  assert.ok(Math.abs(cost! - 1.3050302) < 1e-9, `cost ${cost}`);
});

test("all-zero usage means unknown, not free", () => {
  const file = tmpFile(
    "s.jsonl",
    jsonl([ccUser("hi"), ccAssistant({ id: "m1", usage: { input_tokens: 0, output_tokens: 0 } })]),
  );
  const [run] = readClaudeCode(file);
  assert.equal(run!.turns[0]!.call.tokens, null);
  assert.match(run!.notes.join(" "), /no usage data/);
});

test("tool results are linked to tool calls", () => {
  const file = tmpFile(
    "s.jsonl",
    jsonl([
      ccUser("read it"),
      ccAssistant({ id: "m1", tools: [{ id: "t1", name: "Read", input: { file_path: "/a.ts" } }] }),
      ccToolResult("t1", "y".repeat(800), false),
    ]),
  );
  const tool = readClaudeCode(file)[0]!.turns[0]!.tools[0]!;
  assert.equal(tool.kind, "read");
  assert.equal(tool.target, "/a.ts");
  assert.equal(tool.resultTokens, 200);
  assert.equal(tool.isError, false);
});

test("human messages mark turn boundaries; tool results do not", () => {
  const file = tmpFile(
    "s.jsonl",
    jsonl([
      ccUser("first"),
      ccAssistant({ id: "m1", tools: [{ id: "t1", name: "Bash", input: { command: "ls" } }] }),
      ccToolResult("t1", "ok"),
      ccAssistant({ id: "m2", text: "done" }),
      ccUser("second"),
      ccAssistant({ id: "m3", text: "ok" }),
    ]),
  );
  const turns = readClaudeCode(file)[0]!.turns;
  assert.deepEqual(
    turns.map((t) => !!t.humanInputBefore),
    [true, false, true],
  );
});

test("sidechain records become a separate run", () => {
  const file = tmpFile(
    "s.jsonl",
    jsonl([ccUser("go"), ccAssistant({ id: "m1", text: "main" }), ccAssistant({ id: "m2", text: "sub", sidechain: true })]),
  );
  const runs = readClaudeCode(file);
  assert.equal(runs.length, 2);
  assert.ok(runs.some((r) => r.agent === "agent-1"));
});
