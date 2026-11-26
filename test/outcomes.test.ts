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
import { costPerSuccessLine, renderDiffTable, renderTable, successVerdictLine } from "../src/report.js";
import { jsonl, otlp, span, tmpFile } from "./helpers.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixture = (name: string) => join(root, "fixtures", name);
const cli = join(root, "dist", "cli.js");
const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
const close = (a: number, b: number, msg?: string) => assert.ok(Math.abs(a - b) < 1e-12, `${msg ?? ""} ${a} != ${b}`);

const EXPLAIN = ["71416a2f7d5e9561c2d933c805b5cd61", "43939ed05cb53cca9bbdbf67f6bd4369", "85b5984ea18bfc4f33d03cf677001d22"];
const CUT_OFF = "69227109187db8b6eb5277e875078c69";

// --- the file ------------------------------------------------------------------

test("outcomes file: base64 trace ids match padded or not, standard or URL-safe; a BOM is skipped", () => {
  // 0xfb 0xef 0xbe is "++++" in base64, "----" URL-safe.
  const hex = "fbefbe".repeat(5) + "fb";
  const std = Buffer.from(hex, "hex").toString("base64");
  assert.match(std, /\+/);
  for (const id of [std, std.replace(/=+$/, ""), std.replace(/\+/g, "-").replace(/\//g, "_"), std.replace(/\+/g, "-").replace(/=+$/, "")])
    assert.equal(normalizeRunId(id), hex, id);
  const o = readOutcomes(tmpFile("o.jsonl", `﻿{"run": "${hex}", "pass": true}\n`));
  assert.deepEqual([...o.rows], [[hex, true]]);
});

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
  // Unpadded and URL-safe base64, as some exporters and tools write ids.
  const ids = ["7de20e3d2fe6c9a8f4a2b8b0c1d0f3ff", "fbff00ff7a5c3e1d0b2c4d6e8f9a1b2c"];
  for (const hex of ids) {
    const std = Buffer.from(hex, "hex").toString("base64");
    const url = Buffer.from(hex, "hex").toString("base64url");
    assert.equal(normalizeRunId(std.replace(/=+$/, "")), hex);
    assert.equal(normalizeRunId(url), hex);
    assert.equal(normalizeRunId(url + "=="), hex);
  }
  assert.match(Buffer.from(ids[1]!, "hex").toString("base64url"), /[-_]/);
  // A 22-character name that isn't a canonical encoding of 16 bytes stays as written.
  assert.equal(normalizeRunId("nightly-run-2026-11-24"), "nightly-run-2026-11-24");
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
  refuse(`${ok}\n\n{"run": "${EXPLAIN[0]!.toUpperCase()}", "pass": false}`, /line 3: this run is listed as both pass and fail \(also on line 1\)$/);
  // The run id is a value from the user's file: never echoed.
  refuse(`{"run": "SECRET", "pass": true}\n{"run": "SECRET", "pass": false}`, /line 2: this run is listed as both pass and fail \(also on line 1\)$/);
  refuse(`\n\n`, /no outcomes in the file/);
  // A byte order mark at the start of the file is not part of the first line.
  assert.equal(readOutcomes(tmpFile("o.jsonl", `\uFEFF${ok}\n`)).rows.get(EXPLAIN[0]!), true);
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
  assert.match(t, /passed 3\/3 → 3\/3\n/);
  assert.match(t, /per success +\$1\.00 → \$1\.00 +no change/);
  assert.equal(r.success!.costPerSuccess.verdict, "no clear change");
  assert.match(t, /cache +passed/);
});

test("diff: without outcomes nothing about success is shown", () => {
  const r = compare(passes("a", true, true, true), passes("a", true, true, true), { groupBy: "task" });
  assert.equal(r.success, undefined);
  assert.doesNotMatch(renderDiffTable(r, { width: 200 }), /success|passed/);
});

test("diff: groups add up, 2 tasks x 3 runs show 6/6 -> 1/6 (one-sided p = 1/20 x 1/5)", () => {
  const r = diffOf([...passes("a", true, true, true), ...passes("b", true, true, true)], [...passes("a", false, false, false), ...passes("b", true, false, false)], "rise");
  close(r.success!.pDrop, 1 / 100);
  assert.equal(r.success!.verdict, "lower");
  assert.equal(successGate(r, 10), "fail");
});

test("diff: by input, the two-sided verdict needs six flips where the gate needs five", () => {
  const flips = (n: number) => {
    const inputs = Array.from({ length: n }, (_, i) => `i${i}`);
    return diffOf(inputs.map((i) => unit(i, true)), inputs.map((i) => unit(i, false)));
  };
  assert.equal(flips(5).success!.verdict, "too few runs");
  close(flips(6).success!.pTwoSided, 2 / 64);
  assert.equal(flips(6).success!.verdict, "lower");
});

test("diff: the pass counts cover the same groups as the rates", () => {
  // Task b is only in base: not compared, so not in the counts either.
  const r = diffOf([...passes("a", true, true, true, true, true), ...passes("b", false, false, false, false, false)], passes("a", true, true, true, true, false));
  const s = r.success!;
  close(s.baseRate!, 1);
  close(s.headRate!, 0.8);
  assert.deepEqual(s.base, { runs: 5, known: 5, passed: 5 });
  assert.deepEqual(s.head, { runs: 5, known: 5, passed: 4 });
  assert.match(renderDiffTable(r, { width: 200 }), /passed 5\/5 → 4\/5/);
});

test("diff: equal rates summed in another order are no change, not a drop of -0.0 points", () => {
  // Per task 3,2,1 passes of 3 -> 2,2,2: 6/9 both sides; the weighted sums differ in the last bits.
  const r = diffOf(
    [...passes("a", true, true, true), ...passes("b", true, true, false), ...passes("c", true, false, false)],
    [...passes("a", true, true, false), ...passes("b", true, true, false), ...passes("c", true, true, false)],
    "rise",
  );
  assert.equal(r.success!.change, 0);
  assert.equal(successVerdictLine(r), "no change");
  assert.equal(successGate(r, 0), "pass");
});

// --- CLI -----------------------------------------------------------------------

// One OTLP trace per input, each a single priced call; head and base share inputs.
const inputsFile = (side: "a" | "b", costs: number[]) => {
  const spans = costs.map((c, i) =>
    span({
      id: "1",
      name: "chat",
      start: 0,
      trace: `${side}${i + 1}`.padEnd(32, "0"),
      attrs: {
        "gen_ai.operation.name": "chat",
        "gen_ai.provider.name": "anthropic",
        "gen_ai.request.model": "claude-sonnet-5-5",
        "gen_ai.usage.input_tokens": c,
        "gen_ai.usage.output_tokens": 1,
        "bench.input_id": `q${i + 1}`,
      },
    }),
  );
  return tmpFile(`${side}.json`, JSON.stringify(otlp(spans)));
};
const traceIds = (side: "a" | "b", n: number) => Array.from({ length: n }, (_, i) => `${side}${i + 1}`.padEnd(32, "0"));

test("cli: --fail-success-drop exits 1 on a clear drop; with both gates, a failure (1) wins over can't tell (2)", () => {
  const base = inputsFile("a", [1000, 1000, 1000, 1000, 1000]);
  const head = inputsFile("b", [2000, 2000, 2000, 2000, 2000]);
  const rows = (headPass: boolean, skipLast = false) =>
    tmpFile("o.jsonl", jsonl([...traceIds("a", 5).map((run) => ({ run, pass: true })), ...traceIds("b", skipLast ? 4 : 5).map((run) => ({ run, pass: headPass }))]));
  const by = ["--group-by", "bench.input_id"];

  const fell = run("diff", base, head, ...by, "--outcomes", rows(false), "--fail-success-drop", "10");
  assert.equal(fell.status, 1, fell.stderr);
  assert.match(fell.stderr, /success fell 100\.0 points \(5\/5 -> 0\/5 passed\), more than 10 points/);

  // Success can't tell (one head run has no outcome) but cost clearly rose: exit 1.
  const both = run("diff", base, head, ...by, "--outcomes", rows(true, true), "--fail-success-drop", "10", "--fail-above", "10");
  assert.equal(both.status, 1, both.stderr);
  // Without the cost gate, can't tell alone exits 2.
  const cant = run("diff", base, head, ...by, "--outcomes", rows(true, true), "--fail-success-drop", "10");
  assert.equal(cant.status, 2, cant.stderr);
});

test("cli: a head whose runs all failed before a priced call still fails the success gate (1, not 2)", () => {
  const base = inputsFile("a", [1000, 1000, 1000, 1000, 1000]);
  // Each head run: one model call that errored, no usage.
  const failed = traceIds("b", 5).map((trace, i) => ({
    ...span({ id: "1", name: "chat", start: 0, trace, attrs: { "gen_ai.operation.name": "chat", "gen_ai.provider.name": "anthropic", "gen_ai.request.model": "claude-sonnet-5-5", "bench.input_id": `q${i + 1}` } }),
    status: { code: 2 },
  }));
  const head = tmpFile("b.json", JSON.stringify(otlp(failed)));
  const rows = tmpFile("o.jsonl", jsonl([...traceIds("a", 5).map((run) => ({ run, pass: true })), ...traceIds("b", 5).map((run) => ({ run, pass: false }))]));
  const out = run("diff", base, head, "--group-by", "bench.input_id", "--outcomes", rows, "--fail-success-drop", "10");
  assert.equal(out.status, 1, out.stderr);
  assert.match(out.stderr, /no priced runs in head .*; cost per run not compared/);
  assert.match(out.stderr, /success fell 100\.0 points \(5\/5 -> 0\/5 passed\)/);
  // Without outcomes it stays "nothing to compare", exit 2.
  const plain = run("diff", base, head, "--group-by", "bench.input_id");
  assert.equal(plain.status, 2);
  assert.match(plain.stderr, /no priced runs in head .*; nothing to compare/);
});

test("diff: a group with no priced run on one side is named in the notes with its passes", () => {
  const dead = (t: string) => unit(t, false, 0, { pricedCalls: 0, failedCalls: 1, calls: 1 });
  const r = diffOf([...passes("a", true, true, true), ...passes("b", true, true, true)], [...passes("a", true, true, true), dead("b"), dead("b"), dead("b")]);
  assert.deepEqual(r.onlyBase, ["b"]);
  const t = renderDiffTable(r, { width: 200 });
  assert.match(t, /b: no priced run in head, so cost leaves it out; success compares it: passed 3\/3 → 0\/3/);
  assert.doesNotMatch(t, /only in base, not compared/);
});

test("audit: traces sharing the first 12 hex of their id stay separate runs, each with its outcome", () => {
  const mk = (trace: string) =>
    span({ id: "1", name: "chat", start: 0, trace, attrs: { "gen_ai.operation.name": "chat", "gen_ai.provider.name": "anthropic", "gen_ai.request.model": "claude-sonnet-5-5", "gen_ai.usage.input_tokens": 1000, "gen_ai.usage.output_tokens": 1 } });
  // Time-prefixed ids: same first 12 hex, different after.
  const ids = ["0190f3a1b2c3" + "1".repeat(20), "0190f3a1b2c3" + "2".repeat(20), "7".repeat(32)];
  const file = tmpFile("t.json", JSON.stringify(otlp(ids.map(mk))));
  const rows = tmpFile("o.jsonl", jsonl([{ run: ids[0], pass: true }, { run: ids[1], pass: false }, { run: ids[2], pass: true }]));
  const r = audit([file], { rules: false, outcomes: readOutcomes(rows) });
  assert.equal(r.runs.length, 3);
  assert.equal(new Set(r.runs.map((x) => x.id)).size, 3);
  assert.deepEqual(r.runs.map((x) => x.pass), [true, false, true]);
  assert.equal(r.outcomes!.known, 3);
  assert.equal(r.outcomes!.passed, 2);
  // A run whose 12 hex are its own keeps the short id.
  assert.equal(r.runs[2]!.id, `t.json#${"7".repeat(12)}`);
});


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

test("traces whose ids share a prefix (time-ordered ids) stay separate runs and keep their own outcomes", () => {
  const a = "019a7c3e5f10" + "7a1b2c3d4e5f60718293";
  const b = "019a7c3e5f10" + "8f9e8d7c6b5a49382716";
  const call = (trace: string, id: string) =>
    span({ trace, id, name: "chat", start: 0, attrs: { "gen_ai.operation.name": "chat", "gen_ai.request.model": "claude-sonnet-5-5", "gen_ai.usage.input_tokens": 1000, "gen_ai.usage.output_tokens": 100 } });
  const file = tmpFile("prefix.json", JSON.stringify(otlp([call(a, "1"), call(b, "2")])));
  const outcomes: Outcomes = { file: "o.jsonl", rows: new Map([[a, true], [b, false]]) };
  const r = audit([file], { outcomes });
  assert.equal(r.runs.length, 2);
  assert.equal(r.perRun!.count, 2);
  assert.equal(r.outcomes!.known, 2);
  assert.equal(r.outcomes!.passed, 1);
  assert.equal(r.outcomes!.unmatchedRows, 0);
});

test("diff: a head whose every run failed before a priced call fails the success gate (exit 1), not just exit 2", () => {
  const trace = (i: number, side: number) => `${side}${i}`.padStart(32, "a");
  const call = (side: number, i: number) => {
    const s = span({
      trace: trace(i, side),
      id: "1",
      name: "chat",
      start: 0,
      attrs: {
        "gen_ai.operation.name": "chat",
        "gen_ai.agent.name": "reviewer",
        "gen_ai.request.model": "claude-sonnet-5-5",
        ...(side === 1 ? { "gen_ai.usage.input_tokens": 1000, "gen_ai.usage.output_tokens": 100 } : {}),
      },
    });
    return side === 1 ? s : { ...s, status: { code: 2 } };
  };
  const ids = [0, 1, 2, 3];
  const base = tmpFile("base.json", JSON.stringify(otlp(ids.map((i) => call(1, i)))));
  const head = tmpFile("head.json", JSON.stringify(otlp(ids.map((i) => call(2, i)))));
  const outcomes = tmpFile(
    "o.jsonl",
    jsonl([...ids.map((i) => ({ run: trace(i, 1), pass: true })), ...ids.map((i) => ({ run: trace(i, 2), pass: false }))]),
  );
  const r = run("diff", base, head, "--outcomes", outcomes, "--fail-success-drop", "10");
  // 4 of 4 -> 0 of 4: one-sided p = 1/C(8,4) = 1/70.
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /no priced runs in head .*cost per run not compared/);
  assert.match(r.stderr, /success fell 100\.0 points \(4\/4 -> 0\/4 passed\)/);
  assert.match(r.stdout, /reviewer\s+base\s+4(\s+–){8}\s+4\/4/);
  assert.match(r.stdout, /head\s+4(\s+–){8}\s+0\/4/);
  assert.match(r.stdout, /reviewer: no priced run in head, so cost leaves it out; success compares it: passed 4\/4 → 0\/4/);
  assert.doesNotMatch(r.stdout, /models:/);
  // Without the success gate, nothing was compared: 2.
  assert.equal(run("diff", base, head, "--outcomes", outcomes).status, 2);
});

// --- cost per success in diff ------------------------------------------------------

/** k-subsets of 0..n-1, written out again here so the check doesn't share code with diff.ts. */
const subsets = (n: number, k: number): number[][] =>
  k === 0 ? [[]] : n < k ? [] : [...subsets(n - 1, k - 1).map((s) => [...s, n - 1]), ...subsets(n - 1, k)];

test("diff: cost per success p-value equals a brute-force count over every relabeling (2 groups x 5 v 5)", () => {
  const spec = {
    a: { base: [[1.0, true], [1.1, true], [0.9, true], [1.2, false], [1.0, true]], head: [[1.5, true], [1.6, false], [1.7, true], [1.5, false], [1.6, true]] },
    b: { base: [[2.0, true], [2.2, true], [1.8, true], [2.1, true], [1.9, false]], head: [[2.8, true], [3.0, false], [2.9, true], [3.1, true], [2.7, false]] },
  } as const;
  const base = Object.entries(spec).flatMap(([t, g]) => g.base.map(([c, p]) => unit(t, p, c)));
  const head = Object.entries(spec).flatMap(([t, g]) => g.head.map(([c, p]) => unit(t, p, c)));
  const r = diffOf(base, head);
  const cps = r.success!.costPerSuccess;

  // Independently: cost per success at base's mix (equal weights) for any labeling.
  type R = readonly [number, boolean];
  const perSuccess = (a: readonly R[], b: readonly R[]) => {
    const m = (xs: readonly R[], f: (x: R) => number) => xs.reduce((s, x) => s + f(x), 0) / xs.length;
    const spend = 0.5 * m(a, (x) => x[0]) + 0.5 * m(b, (x) => x[0]);
    const passed = 0.5 * m(a, (x) => (x[1] ? 1 : 0)) + 0.5 * m(b, (x) => (x[1] ? 1 : 0));
    return spend / passed;
  };
  const obs = perSuccess(spec.a.head, spec.b.head) / perSuccess(spec.a.base, spec.b.base);
  close(cps.baseUsd!, perSuccess(spec.a.base, spec.b.base));
  close(cps.headUsd!, perSuccess(spec.a.head, spec.b.head));
  close(cps.change!, obs - 1);

  const poolA: R[] = [...spec.a.base, ...spec.a.head];
  const poolB: R[] = [...spec.b.base, ...spec.b.head];
  const split = (pool: R[], pick: number[]) => [pick.map((i) => pool[i]!), pool.filter((_, i) => !pick.includes(i))] as const;
  let higher = 0;
  let either = 0;
  let total = 0;
  for (const pa of subsets(10, 5))
    for (const pb of subsets(10, 5)) {
      const [ha, ba] = split(poolA, pa);
      const [hb, bb] = split(poolB, pb);
      const ratio = perSuccess(ha, hb) / perSuccess(ba, bb);
      total++;
      if (ratio >= obs * (1 - 1e-9)) higher++;
      if (Math.abs(Math.log(ratio)) >= Math.abs(Math.log(obs)) * (1 - 1e-9)) either++;
    }
  assert.equal(cps.method, "exact");
  assert.equal(cps.permutations, total);
  close(cps.pHigher, higher / total);
  close(cps.pTwoSided, either / total);
  assert.ok(cps.pTwoSided < 0.05, `${cps.pTwoSided}`);
  assert.equal(cps.verdict, "higher");
  // p is just under 0.05 here: shown with three decimals, never as a misleading "p=0.05".
  assert.match(costPerSuccessLine(r), /^higher, \+96% \(p=0\.04\d\)$/);
});

test("diff: one group of 3 v 3 can't show cost per success doubling: too few runs", () => {
  const r = diffOf(passes("a", true, true, true), [true, true, true].map((p) => unit("a", p, 2)));
  const cps = r.success!.costPerSuccess;
  close(cps.change!, 1);
  // Head holding the three $2 runs, or base holding them: 2 of C(6,3) = 20.
  close(cps.pTwoSided, 2 / 20);
  close(cps.minP, 2 / 20);
  assert.equal(cps.verdict, "too few runs");
});

test("diff: a head with no passes is an infinite cost per success; six inputs flipping show it", () => {
  const inputs = ["i1", "i2", "i3", "i4", "i5", "i6"];
  const r = diffOf(inputs.map((i) => unit(i, true)), inputs.map((i) => unit(i, false)));
  const cps = r.success!.costPerSuccess;
  assert.equal(cps.headUsd, null);
  assert.equal(cps.change, null);
  // Only the observed labeling and its mirror image have a side with no passes: 2 of 2^6.
  close(cps.pTwoSided, 2 / 64);
  assert.equal(cps.verdict, "higher");
  assert.match(costPerSuccessLine(r), /^higher, head has no passes \(p=/);
  assert.match(renderDiffTable(r, { width: 200 }), /per success +\$1\.00 → no passes +higher/);
});

test("diff: cost per success is can't tell with unknown spend or a missing outcome, a lower bound with a failed call", () => {
  const partly = unit("a", true, 1, { pricedCalls: 3 });
  const r1 = diffOf(passes("a", true, true, true), [...passes("a", true, true), partly]);
  assert.equal(r1.success!.costPerSuccess.verdict, "can't tell");
  assert.match(costPerSuccessLine(r1), /no price or no usage/);

  const r2 = diffOf([...passes("a", true, true), unit("a", undefined)], passes("a", true, true, true));
  assert.equal(r2.success!.costPerSuccess.verdict, "can't tell");
  assert.match(costPerSuccessLine(r2), /compared runs with no outcome/);

  const dead = unit("a", false, 0, { pricedCalls: 0, failedCalls: 1, calls: 1 });
  const r3 = diffOf(passes("a", true, true, true), [...passes("a", true, true), dead]);
  const cps = r3.success!.costPerSuccess;
  assert.equal(cps.lowerBound, true);
  assert.notEqual(cps.verdict, "can't tell");
  assert.match(renderDiffTable(r3, { width: 200 }), /lower bound: some runs have calls whose spend is unknown/);
});

test("diff: a clear p just under 0.05 never prints as p=0.050 (review repro: 396 of 8,000)", () => {
  const costs = {
    base: [[1.4541, 1.1015, 1.5044], [1.2054, 1.8874, 1.7986], [1.2137, 1.6314, 1.8821]],
    head: [[1.501, 2.0337, 1.9305], [1.9402, 1.6783, 1.5401], [1.8571, 1.865, 1.744]],
  };
  const side = (cs: number[][]) => cs.flatMap((g, i) => g.map((c) => unit(`t${i}`, true, c)));
  const r = diffOf(side(costs.base), side(costs.head));
  close(r.success!.costPerSuccess.pTwoSided, 396 / 8000);
  assert.equal(r.success!.costPerSuccess.verdict, "higher");
  assert.match(costPerSuccessLine(r), /\(p<0\.05\)$/);
  const t = renderDiffTable(r, { width: 200 });
  assert.doesNotMatch(t, /p=0\.050/);
});

test("diff: base spending $0 with passes is not \"no passes\"", () => {
  const r = diffOf(passes("a", true, true, true, true, true).map((u) => ({ ...u, costUsd: 0 })), passes("a", true, true, true, true, true));
  assert.equal(r.success!.costPerSuccess.baseUsd, 0);
  assert.doesNotMatch(costPerSuccessLine(r), /no passes/);
});

test("diff: under --fail-above the per-success line says its p is two-sided", () => {
  const base = passes("a", true, true, true, true, true);
  const head = [true, true, true, true, true].map((p) => unit("a", p, 2));
  const o = rowsOf(...base, ...head);
  const r = compare(base, head, { groupBy: "task", outcomes: o, test: "rise" });
  assert.match(costPerSuccessLine(r), /two-sided p=/);
  assert.doesNotMatch(costPerSuccessLine(diffOf(base, head)), /two-sided/);
});
