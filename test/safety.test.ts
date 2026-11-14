// What a trace can put in front of the user: names and paths in a trace are
// written by whoever produced it, often a model. They must not drive the
// terminal, inject Markdown into a PR comment, or reach Object's prototype.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { audit, collectFiles, type AuditResult, type RunSummary } from "../src/audit.js";
import { compare, GroupKeyError } from "../src/diff.js";
import type { Finding } from "../src/model.js";
import { PriceTable } from "../src/pricing.js";
import { renderDiffTable, renderMarkdown, renderTable } from "../src/report.js";
import { escapeMd, plainText } from "../src/text.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cli = join(root, "dist", "cli.js");
const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });

const HOSTILE = "evil\x1b[2J\x1b]8;;http://x\x07\nFAKE LINE\r‮axe.ts‬ <img src=x> [ok](http://x) @someone `c` *b* &amp; | cell";

const runOf = (extra: Partial<RunSummary> = {}): RunSummary => ({
  id: "t.jsonl#abc", file: "/t/t.jsonl", source: "otlp", calls: 2, pricedCalls: 2, failedCalls: 0, costUsd: 1,
  unpricedModels: [], models: [], promptTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheUnknownCalls: 0,
  labels: {}, notes: [], ...extra,
});

function hostileResult(): AuditResult {
  const finding: Finding = {
    rule: "reread-unchanged", severity: "high", runId: "t.jsonl#abc", file: "/t/t.jsonl", turns: [1],
    message: `read ${HOSTILE} twice`, details: [HOSTILE], costUsd: 2, tokens: 10, fix: "no-loss", avoidableUsd: 2,
  };
  return {
    files: 1, skippedFiles: [], ignoredFiles: [], runs: [runOf({ agent: HOSTILE, notes: [HOSTILE], unpricedModels: [HOSTILE] })],
    findings: [finding], totalCostUsd: 1, findingsCostUsd: 2, avoidableUsd: 2, prices: { source: "test", retrieved: "2026-11-14" },
    perRun: { count: 1, meanUsd: 1, medianUsd: 1, p90Usd: 1, maxUsd: 1, avoidableUsd: 2, avoidableShare: 1, incomplete: 0 },
    excludedRuns: { failed: 0, unpriced: 0 },
  };
}

const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/;

test("plainText drops control characters and bidi overrides, line breaks become spaces", () => {
  assert.equal(plainText("a\x1b[31mb\nc\td‮e\x9bf"), "a[31mb c def");
  assert.equal(plainText("src/ok-file.ts"), "src/ok-file.ts");
});

test("terminal output carries no escape sequence, line break or bidi override from a trace", () => {
  for (const verbose of [false, true]) {
    const out = renderTable(hostileResult(), { verbose, width: 100 });
    assert.doesNotMatch(out, CONTROL);
    assert.doesNotMatch(out, /\nFAKE LINE/, "a trace string must not start a line of its own");
  }
  // Our own colors still work.
  assert.match(renderTable(hostileResult(), { color: true }), /\x1b\[1mburnlint\x1b\[0m/);
});

test("Markdown output: no HTML, links, mentions, code or cell breaks from a trace", () => {
  const md = renderMarkdown(hostileResult());
  assert.doesNotMatch(md, CONTROL);
  assert.doesNotMatch(md, /(?<!\\)<img/);
  assert.doesNotMatch(md, /(?<!\\)\[ok(?<!\\)\]/);
  assert.doesNotMatch(md, /@someone/);
  assert.doesNotMatch(md, /(?<!\\)`c/);
  assert.doesNotMatch(md, /(?<!\\)&amp;/);
  // Every finding row still has exactly 6 cells.
  const row = md.split("\n").find((l) => l.startsWith("| high"))!;
  assert.equal(row.split(/(?<!\\)\|/).length - 2, 6);
  // burnlint's own Markdown is untouched.
  assert.match(md, /`reread-unchanged`/);
  assert.match(md, /<details><summary>Notes<\/summary>/);
});

test("escapeMd keeps plain paths readable", () => {
  assert.equal(escapeMd("src/rules/cache-thrash.ts (2 times)"), "src/rules/cache-thrash.ts (2 times)");
  assert.equal(escapeMd("node_modules/@types/x"), "node\\_modules/@​types/x");
});

test("diff table carries no control characters from group names or paths", () => {
  const r = (cost: number) => runOf({ costUsd: cost, labels: { "gen_ai.agent.name": HOSTILE } });
  const out = renderDiffTable(compare([r(1), r(1.1), r(0.9)], [r(1), r(1.2), r(1)]), { width: 100 });
  assert.doesNotMatch(out, CONTROL);
});

test("names of Object's own properties are ordinary names", () => {
  assert.equal(new PriceTable().lookup("constructor"), undefined);
  assert.equal(new PriceTable().lookup("__proto__"), undefined);
  assert.equal(new PriceTable({ constructor: { input: 1, output: 2 } }).lookup("constructor")?.input, 1);
  assert.throws(() => compare([runOf()], [runOf()], { groupBy: "constructor" }), GroupKeyError);
  assert.equal(compare([runOf({ labels: { toString: "x" } })], [runOf({ labels: { toString: "x" } })], { groupBy: "toString" }).groups[0]!.name, "x");
  for (const cmd of ["toString", "constructor", "hasOwnProperty"]) {
    const r = run(cmd, "x");
    assert.equal(r.status, 2, cmd);
    assert.match(r.stderr, /unknown command/);
  }
});

test("a dangling symlink or unreadable folder inside a scanned folder is reported, not fatal", () => {
  const dir = mkdtempSync(join(tmpdir(), "burnlint-scan-"));
  writeFileSync(join(dir, "a.json"), JSON.stringify({ resourceSpans: [] }));
  symlinkSync(join(dir, "gone.jsonl"), join(dir, "dangling.jsonl"));
  symlinkSync(join(dir, "gone-too"), join(dir, "dangling.txt"));
  mkdirSync(join(dir, "sub"));
  const unreadable: string[] = [];
  assert.deepEqual(collectFiles([dir], unreadable), [join(dir, "a.json")]);
  assert.deepEqual(unreadable, [`${join(dir, "dangling.jsonl")} (ENOENT)`], "a non-trace name is ignored quietly");
  assert.deepEqual(audit([dir]).skippedFiles, [`${join(dir, "dangling.jsonl")} (ENOENT)`]);
  // A path named on the command line that can't be read is still an error.
  assert.throws(() => collectFiles([join(dir, "dangling.jsonl")]));
});
