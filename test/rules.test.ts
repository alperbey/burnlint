import { test } from "node:test";
import assert from "node:assert/strict";
import type { Run, ToolCall, Turn } from "../src/model.js";
import { emptyTokens } from "../src/model.js";
import { modelCandidates, PriceTable } from "../src/pricing.js";
import { cacheThrash } from "../src/rules/cache-thrash.js";
import { duplicateToolCall } from "../src/rules/duplicate-tool-call.js";
import { rereadUnchanged } from "../src/rules/reread-unchanged.js";
import { defaultConfig } from "../src/rules/types.js";
import { classifyTool, stableKey } from "../src/tools.js";

const ctx = { prices: new PriceTable(), config: defaultConfig };

function tool(name: string, input: object, extra: Partial<ToolCall> = {}): ToolCall {
  const { kind, target } = classifyTool(name, input);
  return { id: Math.random().toString(36), name, input, inputKey: stableKey(input), kind, target, resultTokens: 2000, ...extra };
}

function runOf(turnTools: ToolCall[][], opts: { human?: number[] } = {}): Run {
  const turns: Turn[] = turnTools.map((tools, index) => ({
    index,
    humanInputBefore: opts.human?.includes(index),
    call: { id: `c${index}`, model: "claude-sonnet-4-6", provider: "anthropic", providerSource: "inferred", tokens: null },
    tools,
  }));
  return { id: "r", source: "test", file: "f", turns, notes: [] };
}

test("duplicate-tool-call: identical calls flagged, key order ignored", () => {
  const run = runOf([[tool("search", { q: "x", n: 5 })], [tool("search", { n: 5, q: "x" })], []]);
  const f = duplicateToolCall.check(run, ctx);
  assert.equal(f.length, 1);
  assert.deepEqual(f[0]!.turns, [0, 1]);
  // 2000 tokens written at $3.75/M, then read at $0.3/M for 1 later turn
  assert.ok(Math.abs(f[0]!.costUsd! - (2000 * 3.75 + 2000 * 0.3) / 1e6) < 1e-9);
});

test("duplicate-tool-call: a write in between resets", () => {
  const run = runOf([[tool("Bash", { command: "npm test" })], [tool("Edit", { file_path: "a.ts" })], [tool("Bash", { command: "npm test" })]]);
  assert.equal(duplicateToolCall.check(run, ctx).length, 0);
});

test("duplicate-tool-call: retry after a failure is not a duplicate", () => {
  const run = runOf([[tool("fetch_page", { id: 1 }, { isError: true })], [tool("fetch_page", { id: 1 })]]);
  assert.equal(duplicateToolCall.check(run, ctx).length, 0);
});

test("duplicate-tool-call: human input in between resets", () => {
  const run = runOf([[tool("Bash", { command: "df -h" })], [tool("Bash", { command: "df -h" })]], { human: [1] });
  assert.equal(duplicateToolCall.check(run, ctx).length, 0);
});

test("reread-unchanged: same file and range read twice", () => {
  const run = runOf([[tool("Read", { file_path: "a.ts" })], [], [tool("Read", { file_path: "a.ts" })], [tool("Read", { file_path: "a.ts" })]]);
  const f = rereadUnchanged.check(run, ctx);
  assert.equal(f.length, 1);
  assert.deepEqual(f[0]!.turns, [0, 2, 3]);
  assert.equal(f[0]!.tokens, 4000);
});

test("reread-unchanged: different ranges are not rereads", () => {
  const run = runOf([[tool("Read", { file_path: "a.ts", offset: 0 })], [tool("Read", { file_path: "a.ts", offset: 200 })]]);
  assert.equal(rereadUnchanged.check(run, ctx).length, 0);
});

test("reread-unchanged: write to that file or a shell command resets", () => {
  const a = runOf([[tool("Read", { file_path: "a.ts" })], [tool("Edit", { file_path: "a.ts" })], [tool("Read", { file_path: "a.ts" })]]);
  assert.equal(rereadUnchanged.check(a, ctx).length, 0);
  const b = runOf([[tool("Read", { file_path: "a.ts" })], [tool("Bash", { command: "sed -i s/x/y/ a.ts" })], [tool("Read", { file_path: "a.ts" })]]);
  assert.equal(rereadUnchanged.check(b, ctx).length, 0);
  const c = runOf([[tool("Read", { file_path: "a.ts" })], [tool("Edit", { file_path: "b.ts" })], [tool("Read", { file_path: "a.ts" })]]);
  assert.equal(rereadUnchanged.check(c, ctx).length, 1);
});

function cacheRun(rows: Array<{ read: number; w5?: number; w1?: number; ts?: string }>): Run {
  const run = runOf(rows.map(() => []));
  rows.forEach((r, i) => {
    const t = emptyTokens();
    t.input = 5;
    t.output = 100;
    t.cacheRead = r.read;
    t.cacheWrite5m = r.w5 ?? 0;
    t.cacheWrite1h = r.w1 ?? 0;
    t.cacheWriteOther = 0;
    t.cacheKnown = true;
    run.turns[i]!.call.tokens = t;
    run.turns[i]!.call.ts = r.ts;
  });
  return run;
}

test("cache-thrash: first turn ignored, healthy growth ignored", () => {
  const run = cacheRun([{ read: 0, w5: 90000 }, { read: 90000, w5: 2000 }, { read: 92000, w5: 3000 }]);
  assert.equal(cacheThrash.check(run, ctx).length, 0);
});

test("cache-thrash: mid-run rewrite flagged with avoidable cost", () => {
  const run = cacheRun([
    { read: 0, w5: 90000, ts: "2026-11-01T10:00:00Z" },
    { read: 90000, w5: 2000, ts: "2026-11-01T10:01:00Z" },
    { read: 0, w5: 95000, ts: "2026-11-01T10:02:00Z" },
  ]);
  const f = cacheThrash.check(run, ctx);
  assert.equal(f.length, 1);
  assert.deepEqual(f[0]!.turns, [2]);
  // sonnet-4-6: 5m write $3.75, read $0.30 -> 95000 * 3.45 / 1e6
  assert.ok(Math.abs(f[0]!.costUsd! - (95000 * 3.45) / 1e6) < 1e-9);
  assert.match(f[0]!.message, /prefix changed/);
});

test("cache-thrash: long gap is reported as expiry", () => {
  const run = cacheRun([
    { read: 0, w1: 90000, ts: "2026-11-01T10:00:00Z" },
    { read: 0, w1: 91000, ts: "2026-11-01T12:30:00Z" },
  ]);
  const f = cacheThrash.check(run, ctx);
  assert.match(f[0]!.message, /expired/);
  assert.match(f[0]!.message, /2h30m/);
});

test("cache-thrash: calls with unknown cache usage are skipped", () => {
  const run = cacheRun([{ read: 0, w5: 90000 }, { read: 0, w5: 95000 }]);
  run.turns[1]!.call.tokens!.cacheKnown = false;
  assert.equal(cacheThrash.check(run, ctx).length, 0);
});

test("model name variants resolve to priced entries", () => {
  const p = new PriceTable();
  for (const m of ["claude-sonnet-4-6", "anthropic/claude-sonnet-4-6", "us.anthropic.claude-sonnet-4-6", "claude-sonnet-4-5-20250929"]) {
    assert.ok(p.lookup(m), `no price for ${m}`);
  }
  assert.deepEqual(modelCandidates("deepseek/deepseek-chat").slice(0, 2), ["deepseek/deepseek-chat", "deepseek-chat"]);
});
