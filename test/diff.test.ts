import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { audit, type RunSummary } from "../src/audit.js";
import { compare, gate, GroupKeyError } from "../src/diff.js";
import { readOtlp } from "../src/adapters/otlp.js";
import { renderDiffTable, verdictLine } from "../src/report.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixture = (name: string) => join(root, "fixtures", name);
const cli = join(root, "dist", "cli.js");
const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });

let seq = 0;
const runOf = (costUsd: number, labels: Record<string, string> = {}, extra: Partial<RunSummary> = {}): RunSummary => ({
  id: `r${++seq}`, file: "/t/a.jsonl", source: "otlp", calls: 4, pricedCalls: 4, failedCalls: 0, costUsd,
  unpricedModels: [], models: ["claude-sonnet-5-5"], promptTokens: 1000, outputTokens: 100, cacheReadTokens: 500,
  cacheUnknownCalls: 0, labels, notes: [], ...extra,
});
const group = (name: string, costs: number[], extra: Partial<RunSummary> = {}) =>
  costs.map((c) => runOf(c, { "gen_ai.agent.name": name }, extra));
const close = (a: number, b: number, msg?: string) => assert.ok(Math.abs(a - b) < 1e-12, `${msg ?? ""} ${a} != ${b}`);

test("overall change is at base's mix, with an exact permutation p", () => {
  const r = compare(
    [...group("a", [0.1, 0.12, 0.14]), ...group("b", [0.01, 0.02, 0.03])],
    [...group("a", [0.2, 0.22, 0.24]), ...group("b", [0.04, 0.05, 0.06])],
  );
  assert.equal(r.groupBy, "gen_ai.agent.name");
  const o = r.overall!;
  close(o.baseUsd, 0.5 * 0.12 + 0.5 * 0.02);
  close(o.headUsd, 0.5 * 0.22 + 0.5 * 0.05);
  close(o.change!, 0.065 / 0.07);
  // C(6,3) relabelings per group, 400 in all. Both groups fully separated: the
  // observed labeling is the single most extreme one, and its mirror the least.
  assert.equal(o.method, "exact");
  assert.equal(o.permutations, 400);
  close(o.pHigher, 1 / 400);
  close(o.pTwoSided, 2 / 400);
  assert.equal(o.verdict, "higher");
  assert.equal(gate(r, 10), "fail");
  assert.equal(gate(r, 100), "pass");
  close(r.groups[0]!.change!, 0.1 / 0.12);
  assert.equal(r.groups[0]!.base.medianUsd, 0.12);
  assert.equal(r.groups[1]!.head.maxUsd, 0.06);
});

test("one group of 3 against 3 can't reach p < 0.05 two-sided: too few runs, and the gate passes", () => {
  const r = compare(group("a", [1, 2, 3]), group("a", [4, 5, 6]));
  const o = r.overall!;
  close(o.minP, 2 / 20);
  close(o.pHigher, 1 / 20);
  assert.equal(o.verdict, "too few runs");
  // One-sided p is 0.05, not below it: a rise the runs can't show clearly passes.
  assert.equal(gate(r, 10), "unclear");
  assert.match(renderDiffTable(r), /too few runs to tell.*--group-by/s);
});

test("a different mix of groups doesn't pass for a change in cost", () => {
  const r = compare([...group("a", [1]), ...group("b", [2, 2, 2])], [...group("a", [1, 1, 1]), ...group("b", [2])]);
  const o = r.overall!;
  close(r.groups[0]!.weight, 0.25);
  close(o.baseUsd, 1.75);
  close(o.headUsd, 1.75);
  close(o.change!, 0);
  // Pooled, head looks 29% cheaper only because it ran more of the cheap group.
  close(r.base.pooledUsd!, 7 / 4);
  close(r.head.pooledUsd!, 5 / 4);
  assert.match(renderDiffTable(r), /all runs pooled: \$1\.75 → \$1\.25/);
});

test("same runs on both sides: no clear change, p = 1", () => {
  const runs = [...group("a", [0.1, 0.13, 0.11]), ...group("b", [0.5, 0.42, 0.47])];
  const o = compare(runs, runs).overall!;
  close(o.change!, 0);
  close(o.pTwoSided, 1);
  assert.equal(o.verdict, "no clear change");
  assert.ok(o.noise! > 0);
});

test("a run with calls that have no price makes the comparison can't tell, never lower", () => {
  const r = compare(group("a", [1, 1.1, 0.9, 1, 1.2]), [
    ...group("a", [0.1, 0.1, 0.1, 0.1]),
    ...group("a", [0.1], { pricedCalls: 2, unpricedModels: ["new-model"] }),
  ]);
  assert.equal(r.head.unpriced, 1);
  assert.equal(r.overall!.verdict, "can't tell");
  assert.equal(gate(r, 10), "can't tell");
  assert.match(renderDiffTable(r), /no price for model\(s\): new-model/);
});

test("failed runs are counted per side and noted when head has more", () => {
  const r = compare(group("a", [1, 1, 1]), [
    ...group("a", [1, 1]),
    ...group("a", [0.2], { failedCalls: 1, calls: 5 }),
    ...group("a", [0], { failedCalls: 1, pricedCalls: 0, calls: 1 }),
  ]);
  assert.equal(r.head.failed, 2);
  assert.equal(r.head.excluded, 1);
  assert.equal(r.head.counted, 3);
  assert.equal(r.head.unpriced, 0);
  const table = renderDiffTable(r);
  assert.match(table, /base 0 of 3, head 2 of 4\. A failed call has no usage in the trace but may still be billed/);
  assert.match(table, /a failed run usually stops early, so head may look cheaper/);
});

test("under a gate a rise is judged one-sided, so the headline and the gate agree", () => {
  // 2 groups, 3 v 3 (400 relabelings): one-sided p 0.03, two-sided 0.06, a rise of ~14%.
  const base = [...group("a", [1.0, 1.1, 0.9]), ...group("b", [2.0, 2.2, 1.8])];
  const head = [...group("a", [1.1, 1.15, 1.25]), ...group("b", [2.4, 2.0, 2.3])];
  const two = compare(base, head).overall!;
  const rise = compare(base, head, { test: "rise" }).overall!;
  assert.equal(two.pHigher, rise.pHigher);
  assert.equal(two.pTwoSided, rise.pTwoSided);
  // Same data, same p-values; only how the verdict reads them differs.
  assert.ok(rise.pHigher < 0.05 && two.pTwoSided >= 0.05, `${rise.pHigher} ${two.pTwoSided}`);
  assert.equal(two.verdict, "no clear change");
  assert.equal(rise.verdict, "higher");
  assert.equal(gate({ ...compare(base, head, { test: "rise" }) }, 10), "fail");
  assert.match(verdictLine(compare(base, head, { test: "rise" })), /^higher, \+\d+% \(one-sided p=/);
  // Without a gate, p just under 0.10 isn't called noise.
  assert.match(verdictLine(compare(base, head)), /not clearly beyond run-to-run noise \(p=0\.0\d/);
  // A fall is judged two-sided either way.
  const fall = compare(head, base, { test: "rise" }).overall!;
  assert.equal(fall.verdict, "no clear change");
});

test("groups on one side only are listed, not compared", () => {
  const r = compare([...group("a", [1, 2]), ...group("b", [3])], [...group("a", [1, 2]), ...group("c", [3])]);
  assert.deepEqual(r.groups.map((g) => g.name), ["a"]);
  assert.deepEqual(r.onlyBase, ["b"]);
  assert.deepEqual(r.onlyHead, ["c"]);
  close(r.groups[0]!.weight, 1);
});

test("grouping key: default, fallback, missing values and a key no run has", () => {
  assert.equal(compare([runOf(1, { project: "web" })], [runOf(1, { project: "web" })]).groupBy, "project");
  const none = compare([runOf(1)], [runOf(2)]);
  assert.equal(none.groupBy, undefined);
  assert.equal(none.groups[0]!.name, "all runs");
  const r = compare([runOf(1, { task: "x" }), runOf(1)], [runOf(1, { task: "x" }), runOf(1)], { groupBy: "task" });
  assert.deepEqual(r.groups.map((g) => g.name), ["x", "(no task)"]);
  assert.throws(() => compare([runOf(1)], [runOf(1)], { groupBy: "bench.tsak" }), GroupKeyError);
});

test("a Claude Code session and its sub-agents are one run, grouped by the main run's labels", () => {
  const session = (id: string, cost: number) => [
    runOf(cost, { project: "web" }, { id, session: id, source: "claude-code" }),
    runOf(cost, { project: "other" }, { id: `${id}#agent-1`, session: id, source: "claude-code", agent: "agent-1" }),
  ];
  const r = compare([...session("s1", 1), ...session("s2", 2)], session("s3", 3));
  assert.equal(r.base.runs, 2);
  assert.deepEqual(r.groups.map((g) => g.name), ["web"]);
  close(r.groups[0]!.base.meanUsd, 3);
  close(r.groups[0]!.head.meanUsd, 6);
  close(r.groups[0]!.base.calls, 8);
});

test("cache share is unknown when any run's cache usage is", () => {
  const r = compare(group("a", [1, 1]), [...group("a", [1]), ...group("a", [1], { cacheUnknownCalls: 1 })]);
  close(r.groups[0]!.base.cacheShare!, 0.5);
  assert.equal(r.groups[0]!.head.cacheShare, null);
});

test("too many relabelings: sampled with a fixed seed, same p every time", () => {
  const base = group("a", Array.from({ length: 15 }, (_, i) => 1 + i / 100));
  const head = group("a", Array.from({ length: 15 }, (_, i) => 2 + i / 100));
  const a = compare(base, head).overall!;
  const b = compare(base, head).overall!;
  assert.equal(a.method, "sampled");
  assert.equal(a.pHigher, b.pHigher);
  close(a.pHigher, 1 / 20001);
  assert.equal(a.verdict, "higher");
});

test("OTLP runs carry root-span attributes and the agent name as labels, never content", () => {
  const [semconv] = readOtlp(fixture("ai-sdk-v7-semconv.jsonl"));
  assert.deepEqual(semconv!.labels, {
    "bench.task": "review",
    "bench.variant": "normal",
    "bench.rep": "1",
    "bench.batch": "2026-11-13T10-22-05",
    "gen_ai.agent.name": "reviewer-review",
    "service.name": "burnlint-bench-reviewer",
  });
  // ai.* spans name the agent by functionId.
  const [legacy] = readOtlp(fixture("ai-sdk-v7-legacy.jsonl"));
  assert.equal(legacy!.labels!["gen_ai.agent.name"], "reviewer-review");
  assert.equal(legacy!.labels!["ai.telemetry.functionId"], undefined);
});

test("diff on real traces: group means are the runs' audited costs", () => {
  const base = fixture("ai-sdk-v7-semconv.jsonl");
  const head = fixture("ai-sdk-v7-prefix.jsonl");
  const costs = (f: string) => audit([f]).runs.map((r) => [r.labels["bench.variant"], r.labels["bench.task"], r.costUsd] as const);
  const r = run("diff", base, head, "--group-by", "bench.task", "-f", "json");
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  // The fixture's review run failed before any priced call: counted apart, not compared.
  assert.deepEqual(j.onlyBase, []);
  assert.equal(j.base.excluded, 1);
  assert.equal(j.base.failed, 1);
  const explain = j.groups.find((g: { name: string }) => g.name === "explain");
  const baseExplain = costs(base).filter(([, t]) => t === "explain").map(([, , c]) => c);
  close(explain.base.meanUsd, (baseExplain[0]! + baseExplain[1]!) / 2);
  close(explain.head.meanUsd, costs(head)[0]![2]);
  assert.equal(j.overall.verdict, "too few runs");
});

test("diff refuses what it can't use", () => {
  const f = fixture("ai-sdk-v7-semconv.jsonl");
  assert.equal(run("diff", f).status, 2);
  assert.equal(run("diff", f, "/nope").status, 2);
  assert.equal(run("diff", f, f, "--group-by", "bench.tsak").status, 2);
  assert.equal(run("diff", f, f, "--fail-above", "ten").status, 2);
  assert.equal(run("diff", f, f, "-f", "md").status, 2);
  assert.equal(run("diff", f, f, "--rule", "cache-thrash").status, 2);
  assert.equal(run("audit", f, "--fail-above", "10").status, 2);
  // Priced runs on both sides but no group in common: nothing was compared.
  assert.equal(run("diff", fixture("ai-sdk-v7-nocache.jsonl"), fixture("ai-sdk-v7-prefix.jsonl")).status, 2);
  // Same runs on both sides: nothing rose, so the gate passes.
  assert.equal(run("diff", f, f, "--fail-above", "0").status, 0);
});
