import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { readClaudeCode } from "../src/adapters/claude-code.js";
import { audit, loadRuns } from "../src/audit.js";
import { callCost, PriceTable } from "../src/pricing.js";
import { ccAssistant, ccToolResult, ccUser, jsonl, tmpFile } from "./helpers.js";

test("a session that opens with bookkeeping and an oversized first message is still recognized", () => {
  const file = tmpFile(
    "s.jsonl",
    jsonl([
      { type: "queue-operation", operation: "enqueue", sessionId: "s1", timestamp: "2026-11-01T10:00:00Z" },
      { type: "queue-operation", operation: "dequeue", sessionId: "s1", timestamp: "2026-11-01T10:00:00Z" },
      ccUser("x".repeat(70_000)),
      ccAssistant({ id: "m1" }),
    ]),
  );
  const runs = loadRuns(file);
  assert.ok(runs, "detected as a Claude Code session");
  assert.equal(runs[0]!.turns.length, 1);
  // Other JSONL with a sessionId is not taken for a session.
  assert.equal(loadRuns(tmpFile("o.jsonl", jsonl([{ sessionId: "abc", type: "page_view" }]))), null);
});

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

test("compaction marks the next call as context-replaced, not as human input", () => {
  // Record shapes as Claude Code v2.1.x writes them (flags only; content redacted).
  const file = tmpFile(
    "s.jsonl",
    jsonl([
      ccUser("first"),
      ccAssistant({ id: "m1", text: "a" }),
      { type: "system", subtype: "compact_boundary", sessionId: "s1", uuid: "c1", parentUuid: null, compactMetadata: { trigger: "auto", preTokens: 160000 } },
      { ...ccUser("summary of the conversation so far"), isCompactSummary: true, isVisibleInTranscriptOnly: true },
      ccAssistant({ id: "m2", text: "b" }),
      ccAssistant({ id: "m3", text: "c" }),
    ]),
  );
  const turns = readClaudeCode(file)[0]!.turns;
  assert.deepEqual(turns.map((t) => [!!t.humanInputBefore, !!t.contextReplacedBefore]), [[true, false], [false, true], [false, false]]);
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

test("real Claude Code session (redacted): cost and cache-thrash match an independent calculation", () => {
  const file = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", "claude-code-session.jsonl");
  const [run, ...rest] = readClaudeCode(file);
  assert.equal(rest.length, 0);
  assert.equal(run!.project, "scratch-2026-10-27-53a77d");
  assert.equal(run!.turns.length, 44);

  // Usage counted once per message id, priced from Anthropic's page for Claude
  // Opus 5.5 (2026-11): input $4, output $20, cache read $0.20, 1h write 2x = $8.
  const records = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const calls: Array<{ ts: string; u: Record<string, any> }> = [];
  const seen = new Set<string>();
  for (const d of records)
    if (d.type === "assistant" && !seen.has(d.message.id)) {
      seen.add(d.message.id);
      calls.push({ ts: d.timestamp, u: d.message.usage });
    }
  const sum = (f: (u: Record<string, any>) => number) => calls.reduce((s, c) => s + f(c.u), 0);
  const expected =
    (sum((u) => u.input_tokens) * 4 +
      sum((u) => u.output_tokens) * 20 +
      sum((u) => u.cache_read_input_tokens) * 0.2 +
      sum((u) => u.cache_creation.ephemeral_5m_input_tokens) * 5 +
      sum((u) => u.cache_creation.ephemeral_1h_input_tokens) * 8) /
    1e6;
  const result = audit([file]);
  assert.ok(Math.abs(result.totalCostUsd - expected) < 1e-9, `${result.totalCostUsd} vs ${expected}`);

  // One cache rewrite at the second call, after a 3h35m break. Lost: what the
  // first call left cached (its reads and writes) minus what the second read,
  // rewritten at the 1h write rate less the read rate. Net of a keep-alive that
  // re-reads the first call's whole prompt every 55 minutes of the break.
  const [a, b] = calls as [(typeof calls)[0], (typeof calls)[0]];
  const cachedAfterA = a.u.cache_read_input_tokens + a.u.cache_creation_input_tokens;
  const lost = Math.min(cachedAfterA - b.u.cache_read_input_tokens, b.u.cache_creation.ephemeral_1h_input_tokens);
  const gapMin = (Date.parse(b.ts) - Date.parse(a.ts)) / 60000;
  const pings = Math.floor(gapMin / 55);
  const promptA = a.u.input_tokens + cachedAfterA;
  const [f, ...others] = result.findings;
  assert.equal(others.length, 0);
  assert.equal(f!.rule, "cache-thrash");
  assert.match(f!.message, /after 3h35m idle, within the 12h keep-alive/);
  assert.ok(Math.abs(f!.costUsd! - (lost * 7.8) / 1e6) < 1e-12);
  assert.ok(Math.abs(f!.avoidableUsd! - ((lost * 7.8) / 1e6 - (pings * promptA * 0.2) / 1e6)) < 1e-12);
});
