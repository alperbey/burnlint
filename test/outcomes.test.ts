import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { audit, type RunSummary } from "../src/audit.js";
import { compare, successGate } from "../src/diff.js";
import { normalizeRunId, OutcomesError, readOutcomes, type Outcomes } from "../src/outcomes.js";
import { PriceTable } from "../src/pricing.js";
import { renderDiffTable, renderTable, successVerdictLine } from "../src/report.js";
import { jsonl, otlp, span, tmpFile } from "./helpers.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixture = (name: string) => join(root, "fixtures", name);
const cli = join(root, "dist", "cli.js");
const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
const close = (a: number, b: number, msg?: string) => assert.ok(Math.abs(a - b) < 1e-12, `${msg ?? ""} ${a} != ${b}`);

const EXPLAIN = ["71416a2f7d5e9561c2d933c805b5cd61", "43939ed05cb53cca9bbdbf67f6bd4369", "85b5984ea18bfc4f33d03cf677001d22"];
const CUT_OFF = "69227109187db8b6eb5277e875078c69";

// --- the file ------------------------------------------------------------------

test("outcomes file: ids normalized (hex any case, base64 trace ids, UUIDs), extra keys ignored", () => {
  const b64 = Buffer.from(EXPLAIN[0]!, "hex").toString("base64");
  const o = readOutcomes(
    tmpFile(
      "o.jsonl",
      jsonl([
        { run: EXPLAIN[0]!.toUpperCase(), pass: true, score: 0.9, notes: "anything" },
        { run: b64, pass: true },
        { run: "5F3C9A1E-0B7D-4C2E-9A61-2B8E4D0F7C13", pass: false },
      ]) + "\n\n",
    ),
  );
  assert.deepEqual([...o.rows], [
    [EXPLAIN[0], true],
    ["5f3c9a1e-0b7d-4c2e-9a61-2b8e4d0f7c13", false],
  ]);
  assert.equal(normalizeRunId(b64), EXPLAIN[0]);
  // Base64 is case-sensitive: only hex and UUIDs are case-folded.
  assert.equal(normalizeRunId("some-Run-Name"), "some-Run-Name");
});

test("outcomes file: bad lines are refused with their line number, never their values", () => {
  const refuse = (rows: string, want: RegExp) => {
    const file = tmpFile("o.jsonl", rows);
    assert.throws(() => readOutcomes(file), (e: Error) => e instanceof OutcomesError && want.test(e.message) && !/SECRET/.test(e.message));
  };
  const ok = JSON.stringify({ run: EXPLAIN[0], pass: true });
  refuse(`${ok}\n{"run": "x", "pass": true, "notes": "SECRET"`, /line 2: not JSON/);
  refuse(`${ok}\n["SECRET"]`, /line 2: expected an object/);
  refuse(`${ok}\n{"pass": true, "notes": "SECRET"}`, /line 2: "run" must be a run id/);
  refuse(`{"run": "a", "passed": true, "notes": "SECRET"}`, /line 1: no "pass" \(found "passed"; the key must be "pass"\)/);
  refuse(`{"run": "a", "Pass": true}`, /found "Pass"/);
  refuse(`{"run": "a", "score": 1}`, /line 1: no "pass"$/);
  for (const v of [`"true"`, `1`, `null`]) refuse(`{"run": "a", "pass": ${v}}`, /line 1: "pass" must be true or false/);
  refuse(`${ok}\n\n{"run": "${EXPLAIN[0]!.toUpperCase()}", "pass": false}`, new RegExp(`line 3: run ${EXPLAIN[0]} is listed as both pass and fail \\(also on line 1\\)`));
  refuse(`\n\n`, /no outcomes in the file/);
  // The same outcome twice is fine (files get concatenated).
  assert.equal(readOutcomes(tmpFile("o.jsonl", `${ok}\n${ok}\n`)).rows.size, 1);
});

// --- audit ---------------------------------------------------------------------

test("audit: success rate and cost per successful run on real runs, failed runs' spend included", () => {
  // Real grades from the bench: the three explain runs passed; the review run was cut off at
  // max_output_tokens (the agent's own limit), so it failed.
  const outcomes = readOutcomes(fixture("openai-agents-outcomes.jsonl"));
  const files = [fixture("openai-agents-explain.jsonl"), fixture("openai-agents-incomplete.jsonl")];
  const r = audit(files, { outcomes, rules: false });
  const o = r.outcomes!;
  assert.deepEqual(
    { runs: o.runs, known: o.known, passed: o.passed, failed: o.failed, unmatchedRows: o.unmatchedRows, incomplete: o.incomplete },
    { runs: 4, known: 4, passed: 3, failed: 1, unmatchedRows: 0, incomplete: 1 },
  );
  close(o.successRate!, 0.75);
  // Independent: the explain runs' cost from the Agents SDK's own usage (see openinference.test.ts),
  // the cut-off run's from its spans (checked there against the bench's $0.1221).
  const p = new PriceTable().lookup("gpt-5.4-mini-2026-03-17")!;
  const sdk = [
    { input: 29597, cached: 2816, output: 1744 },
    { input: 34967, cached: 0, output: 2143 },
    { input: 89141, cached: 27008, output: 2355 },
  ];
  const explain = sdk.reduce((s, u) => s + ((u.input - u.cached) * p.input! + u.cached * p.cacheRead! + u.output * p.output!) / 1e6, 0);
  const cutOff = audit([fixture("openai-agents-incomplete.jsonl")], { rules: false }).totalCostUsd;
  assert.ok(Math.abs(cutOff - 0.1221) < 5e-5);
  close(o.costUsd, explain + cutOff);
  close(o.costPerSuccessUsd!, (explain + cutOff) / 3);
  assert.equal(r.runs.find((x) => x.traceId === CUT_OFF)!.pass, false);

  const table = renderTable(r, { width: 200 });
  assert.match(table, /per success +\$0\.082 +3 of 4 runs passed \(75\.0%\) · \$0\.245 on those 4 ÷ 3 passes, failed runs included · lower bound: 1 run priced in part/);
  // Nothing from the file other than ids and pass/fail is shown.
  assert.doesNotMatch(table, /max_output_tokens|ModelBehaviorError/);
});

test("audit: a run with no outcome is unknown, not failed; rows for other runs are counted", () => {
  const outcomes: Outcomes = { file: "o.jsonl", rows: new Map([[EXPLAIN[0]!, true], ["ffffffffffffffffffffffffffffffff", false]]) };
  const o = audit([fixture("openai-agents-explain.jsonl")], { outcomes, rules: false }).outcomes!;
  assert.deepEqual([o.runs, o.known, o.passed, o.failed, o.unmatchedRows], [3, 1, 1, 0, 1]);
  assert.match(renderTable(audit([fixture("openai-agents-explain.jsonl")], { outcomes, rules: false }), { width: 200 }), /no outcome for 2 of 3/);
});

test("audit: a run with no priced call still counts as a failure, and its cost makes the figure a lower bound", () => {
  // The likeliest failures: the only call errored, so the run is left out of cost per run.
  const failedOnly = span({ id: "1", name: "chat", start: 0, trace: "11111111111111111111111111111111", attrs: { "gen_ai.operation.name": "chat", "gen_ai.request.model": "claude-sonnet-5-5" } });
  const ok = span({
    id: "2",
    name: "chat",
    start: 0,
    trace: "22222222222222222222222222222222",
    attrs: { "gen_ai.operation.name": "chat", "gen_ai.provider.name": "anthropic", "gen_ai.request.model": "claude-sonnet-5-5", "gen_ai.usage.input_tokens": 1000, "gen_ai.usage.output_tokens": 100 },
  });
  const file = tmpFile("t.json", JSON.stringify(otlp([{ ...failedOnly, status: { code: 2 } }, ok])));
  const outcomes = readOutcomes(tmpFile("o.jsonl", jsonl([{ run: "1".repeat(32), pass: false }, { run: "2".repeat(32), pass: true }])));
  const r = audit([file], { outcomes, rules: false });
  assert.equal(r.perRun!.count, 1, "cost per run leaves the failed run out");
  const o = r.outcomes!;
  assert.deepEqual([o.known, o.passed, o.failed, o.incomplete], [2, 1, 1, 1]);
  close(o.costPerSuccessUsd!, r.totalCostUsd);
});

test("audit: no passes is not a number", () => {
  const outcomes: Outcomes = { file: "o.jsonl", rows: new Map(EXPLAIN.map((id) => [id, false])) };
  const r = audit([fixture("openai-agents-explain.jsonl")], { outcomes, rules: false });
  assert.equal(r.outcomes!.costPerSuccessUsd, null);
  assert.match(renderTable(r, { width: 200 }), /per success +no passes +0 of 3 runs passed/);
});

// --- diff ----------------------------------------------------------------------

let seq = 0;
const unit = (task: string, pass: boolean | undefined, costUsd = 1, extra: Partial<RunSummary> = {}): RunSummary => {
  const traceId = (++seq).toString(16).padStart(32, "0");
  return {
    id: `r${seq}`, traceId, file: "/t/a.jsonl", source: "otlp", calls: 4, pricedCalls: 4, failedCalls: 0, costUsd,
    unpricedModels: [], models: ["m"], promptTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheUnknownCalls: 0,
    labels: { task }, notes: [], ...(pass === undefined ? {} : { pass }), ...extra,
  };
};
const passes = (task: string, ...ps: boolean[]) => ps.map((p) => unit(task, p));
const rowsOf = (...runs: RunSummary[]): Outcomes => ({
  file: "o.jsonl",
  rows: new Map(runs.filter((r) => r.pass !== undefined).map((r) => [r.traceId!, r.pass!])),
});
const diffOf = (base: RunSummary[], head: RunSummary[], test: "two-sided" | "rise" = "two-sided", extraRows = 0) => {
  const o = rowsOf(...base, ...head);
  for (let i = 0; i < extraRows; i++) o.rows.set(`extra${i}`, true);
  return compare(base, head, { groupBy: "task", outcomes: o, successTest: test });
};

test("diff: 3 runs a group can't show a success drop, even 3/3 -> 0/3; the gate passes with a warning", () => {
  const r = diffOf(passes("a", true, true, true), passes("a", false, false, false), "rise");
  const s = r.success!;
  close(s.change!, -1);
  // One-sided, 3/3 -> 0/3 is exactly 1 in C(6,3) = 20 relabelings: p = 0.05, not below it.
  close(s.pDrop, 1 / 20);
  assert.equal(s.verdict, "too few runs");
  assert.equal(successGate(r, 10), "too few runs");
  assert.match(successVerdictLine(r), /^too few runs to tell \(-100 points\)/);
});

test("diff: grouped by input, five inputs flipping pass -> fail is a clear drop (a sign test)", () => {
  const inputs = ["i1", "i2", "i3", "i4", "i5"];
  const base = inputs.map((i) => unit(i, true));
  const head = inputs.map((i) => unit(i, false));
  const r = diffOf(base, head, "rise");
  close(r.success!.pDrop, 1 / 32);
  assert.equal(r.success!.verdict, "lower");
  assert.equal(successGate(r, 10), "fail");
  assert.equal(successGate(r, 100), "pass", "a drop at or under the threshold passes");
});

test("diff: 3 tasks x 5 runs, 15/15 -> 10/15 is a clear one-sided drop; cost per success at base's mix", () => {
  const base = ["a", "b", "c"].flatMap((t) => [1, 2, 3, 4, 5].map(() => unit(t, true, 1)));
  // Head: each task loses some passes and costs a little more.
  const head = [
    ...[true, true, true, false, false].map((p) => unit("a", p, 1.2)),
    ...[true, true, true, true, false].map((p) => unit("b", p, 1.2)),
    ...[true, true, true, false, false].map((p) => unit("c", p, 1.2)),
  ];
  const r = diffOf(base, head, "rise");
  const s = r.success!;
  close(s.baseRate!, 1);
  close(s.headRate!, 10 / 15);
  assert.ok(s.pDrop < 0.05, `${s.pDrop}`);
  assert.equal(s.verdict, "lower");
  assert.equal(successGate(r, 20), "fail");
  close(s.costPerSuccess.baseUsd!, 1);
  close(s.costPerSuccess.headUsd!, 1.2 / (10 / 15));
  assert.equal(s.costPerSuccess.lowerBound, false);
});

test("diff: a compared run with no outcome makes success can't tell; rows matching no run are counted", () => {
  const r = diffOf([...passes("a", true, true), unit("a", undefined)], passes("a", true, false, true), "rise", 2);
  assert.equal(r.success!.verdict, "can't tell");
  assert.equal(successGate(r, 10), "can't tell");
  assert.equal(r.success!.unmatchedRows, 2);
  assert.match(successVerdictLine(r), /can't tell: 1 compared run with no outcome in o\.jsonl/);
  assert.deepEqual(r.success!.base, { runs: 3, known: 2, passed: 2 });
});

test("diff: success counts runs that cost per run leaves out (no priced call)", () => {
  const dead = unit("a", false, 0, { pricedCalls: 0, failedCalls: 1, calls: 1 });
  const r = diffOf(passes("a", true, true, true), [...passes("a", true, true), dead]);
  assert.equal(r.groups[0]!.head.runs, 2, "cost compares the 2 priced runs");
  assert.deepEqual(r.success!.groups[0]!.head, { runs: 3, known: 3, passed: 2 });
  assert.equal(r.success!.costPerSuccess.lowerBound, true);
});

test("diff: nothing moved is no change, not too few runs; the table shows passes per group", () => {
  const r = diffOf(passes("a", true, true, true), passes("a", true, true, true));
  assert.equal(r.success!.verdict, "no clear change");
  assert.equal(successVerdictLine(r), "no change");
  const t = renderDiffTable(r, { width: 200 });
  assert.match(t, /success +100\.0% → 100\.0% +no change/);
  assert.match(t, /passed 3\/3 → 3\/3 · per success \$1\.00 → \$1\.00/);
  assert.match(t, /cache +passed/);
});

test("diff: without outcomes nothing about success is shown", () => {
  const r = compare(passes("a", true, true, true), passes("a", true, true, true), { groupBy: "task" });
  assert.equal(r.success, undefined);
  assert.doesNotMatch(renderDiffTable(r, { width: 200 }), /success|passed/);
});

// --- CLI -----------------------------------------------------------------------

test("cli: --outcomes on audit; a file naming no run here exits 2; a bad file exits 2 with its line", () => {
  const ok = run("audit", fixture("openai-agents-explain.jsonl"), "--outcomes", fixture("openai-agents-outcomes.jsonl"));
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /per success .* 3 of 3 runs passed/);
  assert.match(ok.stdout, /1 row in .*openai-agents-outcomes\.jsonl name no run here/);

  const none = run("audit", fixture("openai-agents-explain.jsonl"), "--outcomes", tmpFile("o.jsonl", jsonl([{ run: "f".repeat(32), pass: true }])));
  assert.equal(none.status, 2);
  assert.match(none.stderr, /none of its 1 run id\(s\) match a run here .*runs here have ids like [0-9a-f]{32}/);

  const bad = run("audit", fixture("openai-agents-explain.jsonl"), "--outcomes", tmpFile("o.jsonl", `{"run": "a", "passed": true}\n`));
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /line 1: no "pass" \(found "passed"/);
});

test("cli: --fail-success-drop needs --outcomes and a number of points", () => {
  const a = fixture("openai-agents-explain.jsonl");
  assert.match(run("diff", a, a, "--fail-success-drop", "10").stderr, /needs --outcomes/);
  assert.match(run("diff", a, a, "--fail-success-drop", "ten", "--outcomes", fixture("openai-agents-outcomes.jsonl")).stderr, /percentage points from 0 to 100/);
  assert.match(run("audit", a, "--fail-success-drop", "10").stderr, /audit does not take --fail-success-drop/);
  // Same runs on both sides: no change, exit 0.
  const same = run("diff", a, a, "--outcomes", fixture("openai-agents-outcomes.jsonl"), "--fail-success-drop", "10");
  assert.equal(same.status, 0, same.stderr);
  assert.match(same.stdout, /success +100\.0% → 100\.0% +no change/);
});

test("--group-by keeps a label whose name looks like content when the user names it", () => {
  // `bench.input_id` contains "input", so the content filter drops it unless asked for.
  const mk = (trace: string, input: string, cost: number) =>
    span({
      id: "1",
      name: "chat",
      start: 0,
      trace,
      attrs: {
        "gen_ai.operation.name": "chat",
        "gen_ai.provider.name": "anthropic",
        "gen_ai.request.model": "claude-sonnet-5-5",
        "gen_ai.usage.input_tokens": cost,
        "gen_ai.usage.output_tokens": 1,
        "bench.input_id": input,
      },
    });
  const file = tmpFile("t.json", JSON.stringify(otlp([mk("a".repeat(32), "q1", 1000), mk("b".repeat(32), "q2", 2000)])));
  assert.equal(audit([file], { rules: false }).runs[0]!.labels["bench.input_id"], undefined);
  assert.equal(audit([file], { rules: false, allowLabels: ["bench.input_id"] }).runs[0]!.labels["bench.input_id"], "q1");
  const out = run("diff", file, file, "--group-by", "bench.input_id");
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /grouped by bench\.input_id/);
  assert.match(out.stdout, /^ {2}q1 /m);
  // Other content-like keys stay out.
  assert.equal(audit([file], { rules: false, allowLabels: ["bench.input_id"] }).runs[0]!.labels["gen_ai.usage.input_tokens"], undefined);
});

test("fixture outcomes are the bench's grades for the committed traces", () => {
  const rows = readFileSync(fixture("openai-agents-outcomes.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(rows.map((r) => [r.run, r.pass]), [...EXPLAIN.map((id) => [id, true]), [CUT_OFF, false]]);
});
