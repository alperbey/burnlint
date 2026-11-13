import { test } from "node:test";
import assert from "node:assert/strict";
import type { Run, ToolCall, Turn } from "../src/model.js";
import { emptyTokens } from "../src/model.js";
import { modelCandidates, PriceTable } from "../src/pricing.js";
import { cacheThrash } from "../src/rules/cache-thrash.js";
import { duplicateToolCall } from "../src/rules/duplicate-tool-call.js";
import { rereadUnchanged } from "../src/rules/reread-unchanged.js";
import { defaultConfig, formatDuration } from "../src/rules/types.js";
import { classifyTool, contentKey, isVolatileTool, mayBeSameFile, stableKey } from "../src/tools.js";

const ctx = { prices: new PriceTable(), config: defaultConfig };

/** A tool call whose result is `result` (the same text by default, so repeats return identical results). */
function tool(name: string, input: object, extra: Partial<ToolCall> & { result?: string } = {}): ToolCall {
  const { result = "same result", ...rest } = extra;
  const { kind, target } = classifyTool(name, input);
  return { id: Math.random().toString(36), name, input, inputKey: stableKey(input), kind, target, resultTokens: 2000, resultKey: contentKey(result), ...rest };
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
  // Dropping the repeat loses nothing the model didn't already have.
  assert.equal(f[0]!.fix, "no-loss");
  assert.equal(f[0]!.avoidableUsd, f[0]!.costUsd);
});

test("duplicate-tool-call: a write in between resets", () => {
  const run = runOf([[tool("Grep", { pattern: "foo" })], [tool("Edit", { file_path: "a.ts" })], [tool("Grep", { pattern: "foo" })]]);
  assert.equal(duplicateToolCall.check(run, ctx).length, 0);
});

test("duplicate-tool-call: a shell command in between resets, and shell commands are never reported", () => {
  const search = runOf([[tool("Grep", { pattern: "foo" })], [tool("Bash", { command: "git checkout other-branch" })], [tool("Grep", { pattern: "foo" })]]);
  assert.equal(duplicateToolCall.check(search, ctx).length, 0);
  const tests = runOf([[tool("Bash", { command: "npm test" })], [tool("Bash", { command: "sed -i s/a/b/ src/x.ts" })], [tool("Bash", { command: "npm test" })]]);
  assert.equal(duplicateToolCall.check(tests, ctx).length, 0);
  // Back to back, too: the output depends on state the trace doesn't show.
  const twice = runOf([[tool("run_command", { command: "kubectl get pods" })], [tool("run_command", { command: "kubectl get pods" })]]);
  assert.equal(duplicateToolCall.check(twice, ctx).length, 0);
});

test("duplicate-tool-call: a different or unknown result is not a duplicate", () => {
  const changed = runOf([[tool("list_issues", { repo: "x" }, { result: "3 open" })], [tool("list_issues", { repo: "x" }, { result: "4 open" })]]);
  assert.equal(duplicateToolCall.check(changed, ctx).length, 0);
  const unknown = runOf([[tool("list_issues", { repo: "x" }, { resultKey: undefined })], [tool("list_issues", { repo: "x" }, { resultKey: undefined })]]);
  assert.equal(duplicateToolCall.check(unknown, ctx).length, 0);
  // Changed once, then the same answer again: only the last call repeats.
  const then = runOf([
    [tool("list_issues", { repo: "x" }, { result: "3 open" })],
    [tool("list_issues", { repo: "x" }, { result: "4 open" })],
    [tool("list_issues", { repo: "x" }, { result: "4 open" })],
  ]);
  assert.deepEqual(duplicateToolCall.check(then, ctx)[0]!.turns, [1, 2]);
});

test("duplicate-tool-call: polling tools are never reported", () => {
  for (const name of ["get_job_status", "getJobStatus", "wait_for_build", "mcp__ci__poll", "ping"]) {
    assert.equal(isVolatileTool(name), true, name);
    const run = runOf([[tool(name, { id: 7 }, { result: "running" })], [tool(name, { id: 7 }, { result: "running" })]]);
    assert.equal(duplicateToolCall.check(run, ctx).length, 0, name);
  }
  for (const name of ["Grep", "mapping_lookup", "list_shipping_options"]) assert.equal(isVolatileTool(name), false, name);
});

test("duplicate-tool-call: the finding does not print the tool input", () => {
  const run = runOf([[tool("search", { q: "secret project codename" })], [tool("search", { q: "secret project codename" })]]);
  const [f] = duplicateToolCall.check(run, ctx);
  assert.equal(f!.message, "search called 2x with identical input and result (turns 1, 2)");
});

test("duplicate-tool-call: retry after a failure is not a duplicate", () => {
  const run = runOf([[tool("fetch_page", { id: 1 }, { isError: true })], [tool("fetch_page", { id: 1 })]]);
  assert.equal(duplicateToolCall.check(run, ctx).length, 0);
});

test("duplicate-tool-call: human input in between resets", () => {
  const calls = () => [[tool("Glob", { pattern: "**/*.ts" })], [tool("Glob", { pattern: "**/*.ts" })]];
  assert.equal(duplicateToolCall.check(runOf(calls()), ctx).length, 1);
  assert.equal(duplicateToolCall.check(runOf(calls(), { human: [1] }), ctx).length, 0);
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

test("reread-unchanged: a write under another spelling of the path resets", () => {
  const spellings: Array<[string, string]> = [
    ["src/a.ts", "./src/a.ts"],
    ["src/a.ts", "/work/repo/src/a.ts"],
    ["/work/repo/src/a.ts", "src/lib/../a.ts"],
    ["../src/a.ts", "/work/src/a.ts"],
    ["src\\a.ts", "src/a.ts"],
    ["file:///work/repo/src/a.ts", "/work/repo/src/a.ts"],
  ];
  for (const [read, write] of spellings) {
    const run = runOf([[tool("read_file", { path: read })], [tool("edit_file", { path: write })], [tool("read_file", { path: read })]]);
    assert.equal(rereadUnchanged.check(run, ctx).length, 0, `${read} / ${write}`);
  }
  // A different file with the same name still doesn't reset.
  assert.equal(mayBeSameFile("src/a.ts", "/work/repo/lib/a.ts"), false);
  assert.equal(mayBeSameFile("/x/src/a.ts", "/y/src/a.ts"), false);
});

test("reread-unchanged: different content on the second read is not a reread", () => {
  const run = runOf([[tool("Read", { file_path: "a.ts" }, { result: "v1" })], [], [tool("Read", { file_path: "a.ts" }, { result: "v2" })]]);
  assert.equal(rereadUnchanged.check(run, ctx).length, 0);
  // Without result content the rule still works from the tool calls alone.
  const blind = runOf([[tool("Read", { file_path: "a.ts" }, { resultKey: undefined })], [tool("Read", { file_path: "a.ts" }, { resultKey: undefined })]]);
  assert.equal(rereadUnchanged.check(blind, ctx).length, 1);
});

test("reread-unchanged: remote resources are not files", () => {
  const run = runOf([[tool("fetch", { url: "https://status.example.com" })], [tool("fetch", { url: "https://status.example.com" })]]);
  assert.equal(rereadUnchanged.check(run, ctx).length, 0);
  const viewed = runOf([[tool("view", { url: "https://example.com/doc" })], [tool("view", { url: "https://example.com/doc" })]]);
  assert.equal(rereadUnchanged.check(viewed, ctx).length, 0);
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
  // Turn 2 lost the 92k the previous call left cached; the other 3k it wrote are new and
  // would be written anyway. sonnet-4-6: 5m write $3.75, read $0.30 -> 92000 * 3.45 / 1e6
  assert.ok(Math.abs(f[0]!.costUsd! - (92000 * 3.45) / 1e6) < 1e-9);
  assert.match(f[0]!.message, /prefix changed/);
  assert.equal(f[0]!.fix, "no-loss");
  assert.equal(f[0]!.avoidableUsd, f[0]!.costUsd);
});

test("cache-thrash: expiry is savable only net of the keep-alive that would have prevented it", () => {
  const run = cacheRun([
    { read: 0, w1: 90000, ts: "2026-11-01T10:00:00Z" },
    { read: 0, w1: 91000, ts: "2026-11-01T12:30:00Z" },
  ]);
  const [f] = cacheThrash.check(run, ctx);
  // sonnet-4-6: 1h write $6, read $0.30. The 90k cached before the break are rewritten
  // (the other 1k are new). 150 min idle = 2 pings of the previous prompt
  // (5 input + 90000 written), each a cache read.
  const rewrite = (90000 * 5.7) / 1e6;
  const ping = (90005 * 0.3) / 1e6;
  assert.ok(Math.abs(f!.costUsd! - rewrite) < 1e-9);
  assert.ok(Math.abs(f!.avoidableUsd! - (rewrite - 2 * ping)) < 1e-9);
  assert.equal(f!.fix, "no-loss");
  assert.equal(f!.message, "1 cache rewrite after 2h30m idle, within the 12h keep-alive");
  assert.equal(f!.severity, "medium"); // severity follows the $0.46 saving, not the $0.51 cost
  assert.deepEqual(f!.details, ["turn 2 · 90k tokens · $0.51 · idle 2h30m"]);
});

test("cache-thrash: a break longer than the keep-alive pays for the pings and the rewrite", () => {
  const run = cacheRun([
    { read: 0, w1: 90000, ts: "2026-11-01T10:00:00Z" },
    { read: 0, w1: 91000, ts: "2026-11-01T23:00:00Z" },
  ]);
  const [f] = cacheThrash.check(run, ctx);
  // 12h of pings every 55 min = 13, none of which prevented the rewrite.
  assert.ok(Math.abs(f!.avoidableUsd! - -(13 * 90005 * 0.3) / 1e6) < 1e-9);
  assert.match(f!.message, /after 13h idle, beyond the 12h keep-alive/);
  // Nothing to gain: shown, but never fails --fail-on.
  assert.equal(f!.severity, "info");
  const longer = cacheThrash.check(run, { ...ctx, config: { ...ctx.config, keepAliveHours: 24 } })[0]!;
  assert.ok(longer.avoidableUsd! > 0);
});

test("cache-thrash: a model switch is a trade-off, reported apart from other causes", () => {
  const run = cacheRun([
    { read: 0, w1: 90000, ts: "2026-11-01T10:00:00Z" },
    { read: 0, w1: 91000, ts: "2026-11-01T10:01:00Z" },
    { read: 91000, w1: 1000, ts: "2026-11-01T10:02:00Z" },
    { read: 0, w1: 92000, ts: "2026-11-01T10:03:00Z" },
  ]);
  for (const i of [1, 2, 3]) run.turns[i]!.call.model = "claude-opus-4-6";
  const f = cacheThrash.check(run, ctx);
  assert.deepEqual(
    f.map((x) => [x.turns, x.fix, x.avoidableUsd === null]),
    [
      [[3], "no-loss", false],
      [[1], "trade-off", true],
    ],
  );
  assert.match(f[1]!.message, /after a model switch/);
  assert.equal(f[1]!.severity, "info");
});

test("cache-thrash: the first call after compaction is not flagged", () => {
  const run = cacheRun([{ read: 0, w1: 90000 }, { read: 90000, w1: 2000 }, { read: 0, w1: 40000 }, { read: 40000, w1: 1000 }]);
  assert.equal(cacheThrash.check(run, ctx).length, 1);
  run.turns[2]!.contextReplacedBefore = true;
  assert.equal(cacheThrash.check(run, ctx).length, 0);
});

test("cache-thrash: expiry is judged against the TTL the call wrote with", () => {
  // 20 minutes: past a 5m cache, well within a 1h cache.
  const at = (w: "w1" | "w5") =>
    cacheThrash.check(
      cacheRun([
        { read: 0, [w]: 90000, ts: "2026-11-01T10:00:00Z" },
        { read: 0, [w]: 91000, ts: "2026-11-01T10:20:00Z" },
      ]),
      ctx,
    )[0]!.message;
  assert.match(at("w5"), /after 20m idle/);
  assert.match(at("w1"), /prompt prefix changed/);
});

test("repeat rules reset after compaction: earlier results are gone from context", () => {
  const run = runOf([[tool("Read", { file_path: "a.ts" }), tool("Glob", { pattern: "*.ts" })], [tool("Read", { file_path: "a.ts" }), tool("Glob", { pattern: "*.ts" })]]);
  assert.equal(rereadUnchanged.check(run, ctx).length, 1);
  assert.equal(duplicateToolCall.check(run, ctx).length, 1);
  run.turns[1]!.contextReplacedBefore = true;
  assert.equal(rereadUnchanged.check(run, ctx).length, 0);
  assert.equal(duplicateToolCall.check(run, ctx).length, 0);
});

test("cache-thrash: long gap is reported as expiry", () => {
  const run = cacheRun([
    { read: 0, w1: 90000, ts: "2026-11-01T10:00:00Z" },
    { read: 0, w1: 91000, ts: "2026-11-01T12:30:00Z" },
  ]);
  const f = cacheThrash.check(run, ctx);
  assert.match(f[0]!.message, /after 2h30m idle/);
});

test("cache-thrash: a big new tool result on a cold cache is not a rewrite", () => {
  // Real shape (AI SDK, Sonnet 5.5): step 2 adds a 28k-token diff. It reads all that step 1
  // cached and writes the new part once. The old rule (big write, more than read) fired here.
  const run = cacheRun([{ read: 0, w5: 1065 }, { read: 1065, w5: 28209 }, { read: 29274, w5: 2873 }, { read: 32147, w5: 1051 }]);
  assert.equal(cacheThrash.check(run, ctx).length, 0);
});

test("cache-thrash: savable is what was cached and lost, against a stable-prefix counterfactual", () => {
  // Prefix busted every step (a timestamp in the system prompt): each call reads nothing and
  // writes its whole prompt. A stable prefix would have read the previous prompt and written
  // only the new part, so the waste is each previous prompt at write minus read.
  const rows = [2048, 29229, 40258, 41514];
  const run = cacheRun(rows.map((w) => ({ read: 0, w5: w })));
  const [f] = cacheThrash.check(run, ctx);
  // Each call's cached total is 0 read + its write (cacheRun adds 5 uncached input, not cached).
  const lost = rows.slice(0, -1).reduce((s, w) => s + w, 0);
  assert.ok(Math.abs(f!.avoidableUsd! - (lost * 3.45) / 1e6) < 1e-9);
  assert.deepEqual(f!.turns, [1, 2, 3]);
  // Independently: actual cost minus the cost of the same calls with a stable prefix.
  const w = 3.75, r = 0.3;
  const actual = rows.reduce((s, x) => s + x * w, 0);
  const stable = rows.reduce((s, x, i) => s + (i ? rows[i - 1]! * r + (x - rows[i - 1]!) * w : x * w), 0);
  assert.ok(Math.abs(f!.avoidableUsd! - (actual - stable) / 1e6) < 1e-9);
});

test("cache-thrash: a partial loss counts only the lost part", () => {
  const run = cacheRun([{ read: 0, w5: 50000 }, { read: 30000, w5: 25000 }]);
  const [f] = cacheThrash.check(run, ctx);
  assert.equal(f!.tokens, 20000);
  assert.ok(Math.abs(f!.costUsd! - (20000 * 3.45) / 1e6) < 1e-9);
});

test("cache-thrash: a failed call in between leaves the cache state alone; tiny losses are ignored", () => {
  const run = cacheRun([{ read: 0, w5: 90000 }, { read: 0, w5: 0 }, { read: 90000, w5: 1000 }]);
  run.turns[1]!.call.tokens = null;
  run.turns[1]!.call.failed = true;
  assert.equal(cacheThrash.check(run, ctx).length, 0);
  const small = cacheRun([{ read: 0, w5: 90000 }, { read: 89500, w5: 1500 }]);
  assert.equal(cacheThrash.check(small, ctx).length, 0);
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

test("idle times read as minutes, hours or days", () => {
  assert.deepEqual([16, 150, 180, 2383, 9840, 128290].map(formatDuration), ["16m", "2h30m", "3h", "39h43m", "6d20h", "89d"]);
});
