import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { audit, type AuditResult, type RunSummary } from "../src/audit.js";
import type { Finding } from "../src/model.js";
import { renderMarkdown, renderTable } from "../src/report.js";
import { ccAssistant, ccUser, jsonl } from "./helpers.js";

const runOf = (id: string, extra: Partial<RunSummary> = {}): RunSummary => ({
  id, file: `/logs/${id.split("#")[0]}.jsonl`, source: "claude-code", calls: 10, pricedCalls: 10, failedCalls: 0, costUsd: 5, unpricedModels: [], notes: [], ...extra,
});

const finding = (runId: string, extra: Partial<Finding>): Finding => ({
  rule: "cache-thrash", severity: "high", runId, file: `/logs/${runId.split("#")[0]}.jsonl`, turns: [1], message: "m",
  costUsd: 2, tokens: 1000, fix: "no-loss", avoidableUsd: 2, ...extra,
});

function result(): AuditResult {
  const runs = [
    runOf("aaaa1111-x", { project: "web", session: "aaaa1111-x" }),
    runOf("aaaa1111-x#agent-b2c3d4e5f6", { project: "web", session: "aaaa1111-x", agent: "agent-b2c3d4e5f6" }),
    runOf("bbbb2222-y", { project: "api", session: "bbbb2222-y", notes: ["2 of 40 model call(s) have no usage data (not priced)"] }),
  ];
  runs[0]!.notes.push("3 of 90 model call(s) have no usage data (not priced)");
  const findings = [
    finding("bbbb2222-y", { avoidableUsd: 9, costUsd: 12, message: "a long finding message ".repeat(6).trim(), details: ["turn 2 · 91k tokens"] }),
    finding("aaaa1111-x", { avoidableUsd: 1.5, costUsd: 3, message: "short one" }),
    finding("aaaa1111-x#agent-b2c3d4e5f6", { severity: "low", avoidableUsd: 0.05, costUsd: 0.05, message: "sub-agent one" }),
    finding("aaaa1111-x", { severity: "info", fix: "trade-off", avoidableUsd: null, costUsd: 1, message: "model switch" }),
  ];
  return {
    files: 5, skippedFiles: [], ignoredFiles: ["/logs/x.meta.json", "/logs/y.json"], runs, findings,
    totalCostUsd: 15, findingsCostUsd: 16.05, avoidableUsd: 10.55, prices: { source: "test", retrieved: "2026-11-12" },
    perRun: { count: 2, meanUsd: 7.5, medianUsd: 7.5, p90Usd: 10, maxUsd: 10, avoidableUsd: 5.275, avoidableShare: 0.7033, incomplete: 0 },
    excludedRuns: { failed: 0, unpriced: 0 },
  };
}

test("findings are grouped under their run, the run that would save most first", () => {
  const out = renderTable(result());
  const heads = out.split("\n").filter((l) => /^\S/.test(l) && /savable of/.test(l));
  assert.deepEqual(heads, ["api bbbb2222  $9.00 savable of $12.00", "web aaaa1111  $1.50 savable of $4.00", "web aaaa1111 sub-agent b2c3d4e  $0.050 savable of $0.050"]);
  assert.match(out, /info\s+trade-off\s+\$1\.00\s+cache-thrash\s+model switch/);
  // Files that only sit next to traces are not counted as files read, or reported.
  assert.match(out, /2 runs in 3 files/);
  assert.doesNotMatch(out, /x\.meta\.json|ignored/);
});

test("with a width, every line fits it; without one, a finding stays on one line", () => {
  for (const width of [80, 100]) {
    const lines = renderTable(result(), { width }).split("\n");
    assert.ok(lines.every((l) => l.length <= width), lines.find((l) => l.length > width));
  }
  const piped = renderTable(result());
  assert.ok(piped.split("\n").some((l) => l.endsWith("a long finding message a long finding message a long finding message a long finding message a long finding message a long finding message")));
});

test("the same note from several runs is shown once unless verbose", () => {
  assert.match(renderTable(result()), /no usage data \(not priced\), and the same in 1 more run \(-v lists them\)/);
  const verbose = renderTable(result(), { verbose: true });
  assert.match(verbose, /web aaaa1111: 3 of 90/);
  assert.match(verbose, /api bbbb2222: 2 of 40/);
  assert.match(verbose, /· turn 2 · 91k tokens/);
  assert.match(verbose, /2 files in the scanned folders are not traces/);
});

test("color is off unless asked for", () => {
  assert.doesNotMatch(renderTable(result()), /\x1b\[/);
  assert.match(renderTable(result(), { color: true }), /\x1b\[/);
});

test("markdown lists runs and savings per finding", () => {
  const md = renderMarkdown(result());
  assert.match(md, /\| high \| \$9\.00 \| \$12\.00 \| `cache-thrash` \| api bbbb2222 \|/);
  assert.match(md, /\| info \| trade-off \|/);
});

test("a Claude Code run carries its project folder and session; a sub-agent's session is its parent's", () => {
  const dir = mkdtempSync(join(tmpdir(), "burnlint-report-"));
  const withCwd = (o: object) => ({ ...o, cwd: "/home/me/projects/web/" });
  writeFileSync(join(dir, "s1.jsonl"), jsonl([withCwd(ccUser("hi")), withCwd(ccAssistant({ id: "m1" })), withCwd(ccAssistant({ id: "m2", sidechain: true }))]));
  writeFileSync(join(dir, "s1.meta.json"), JSON.stringify({ agentType: "general-purpose" }));
  const r = audit([dir]);
  assert.deepEqual(r.runs.map((x) => [x.project, x.session, x.agent ?? null]), [["web", "s1", null], ["web", "s1", "agent-1"]]);
  assert.deepEqual(r.skippedFiles, []);
  assert.equal(r.ignoredFiles.length, 1);
  // Named on the command line, the same file is reported.
  assert.equal(audit([join(dir, "s1.meta.json")]).skippedFiles.length, 1);
});

test("cost per run: sub-agents count toward the session that started them", () => {
  const dir = mkdtempSync(join(tmpdir(), "burnlint-perrun-"));
  // No cache fields: each call is 1000 input + 100 output tokens at sonnet-4-6's $3 / $15 per 1M.
  const usage = { input_tokens: 1000, output_tokens: 100 };
  const call = (session: string, id: string, sidechain = false) => ({ ...ccAssistant({ id, usage, sidechain }), sessionId: session });
  writeFileSync(join(dir, "a.jsonl"), jsonl([{ ...ccUser("go"), sessionId: "a" }, call("a", "a1"), call("a", "a2", true)]));
  writeFileSync(join(dir, "b.jsonl"), jsonl([{ ...ccUser("go"), sessionId: "b" }, call("b", "b1")]));
  writeFileSync(join(dir, "c.jsonl"), jsonl([{ ...ccUser("go"), sessionId: "c" }, call("c", "c1"), call("c", "c2"), call("c", "c3")]));
  const one = (1000 * 3 + 100 * 15) / 1e6;
  const r = audit([dir], { runsPerMonth: 1000 });
  assert.equal(r.runs.length, 4); // a, a's sub-agent, b, c
  const p = r.perRun!;
  assert.equal(p.count, 3);
  const near = (x: number, want: number) => assert.ok(Math.abs(x - want) < 1e-12, `${x} vs ${want}`);
  near(p.meanUsd, 2 * one);
  near(p.medianUsd, 2 * one);
  near(p.p90Usd, 3 * one);
  near(p.maxUsd, 3 * one);
  assert.equal(p.incomplete, 0);
  near(r.projection!.spendUsd, 2 * one * 1000);
  assert.equal(audit([dir]).projection, undefined);
});

test("cost per run: median of an even count, and runs with unpriced calls are counted", () => {
  const dir = mkdtempSync(join(tmpdir(), "burnlint-perrun-"));
  const usage = { input_tokens: 1000, output_tokens: 100 };
  const call = (session: string, id: string, u: object = usage) => ({ ...ccAssistant({ id, usage: u }), sessionId: session });
  writeFileSync(join(dir, "a.jsonl"), jsonl([{ ...ccUser("go"), sessionId: "a" }, call("a", "a1")]));
  writeFileSync(join(dir, "b.jsonl"), jsonl([{ ...ccUser("go"), sessionId: "b" }, call("b", "b1"), call("b", "b2"), call("b", "b3", { input_tokens: 0, output_tokens: 0 })]));
  const one = (1000 * 3 + 100 * 15) / 1e6;
  const p = audit([dir]).perRun!;
  assert.ok(Math.abs(p.medianUsd - 1.5 * one) < 1e-12);
  assert.equal(p.incomplete, 1);
});

test("the header shows cost per run and, with a volume, per month", () => {
  const r = result();
  r.projection = { runsPerMonth: 10000, spendUsd: 75000, avoidableUsd: 52750 };
  const out = renderTable(r);
  assert.match(out, /spent\s+\$15\.00\s+\$7\.50 per run · median \$7\.50 · p90 \$10\.00 · max \$10\.00/);
  assert.match(out, /avoidable\s+\$10\.55\s+\$5\.28 per run, 70\.3% of spend/);
  assert.match(out, /per month\s+\$75,000\.00\s+at 10,000 runs, \$52,750\.00 of it avoidable/);
  assert.match(renderMarkdown(r), /\| per month \| \*\*\$75,000\.00\*\* \|/);
});

test("runs with no priced call are left out of cost per run and counted as failed or unpriced", () => {
  const dir = mkdtempSync(join(tmpdir(), "burnlint-failed-"));
  const usage = { input_tokens: 1000, output_tokens: 100 };
  const ok = (session: string, id: string) => ({ ...ccAssistant({ id, usage }), sessionId: session });
  // Claude Code writes a failed API call as a <synthetic> assistant message with zero usage.
  const apiError = (session: string, id: string) => ({
    ...ccAssistant({ id, model: "<synthetic>", usage: { input_tokens: 0, output_tokens: 0 } }),
    sessionId: session,
    isApiErrorMessage: true,
  });
  writeFileSync(join(dir, "a.jsonl"), jsonl([{ ...ccUser("go"), sessionId: "a" }, ok("a", "a1")]));
  writeFileSync(join(dir, "b.jsonl"), jsonl([{ ...ccUser("go"), sessionId: "b" }, ok("b", "b1"), ok("b", "b2"), apiError("b", "b3")]));
  writeFileSync(join(dir, "c.jsonl"), jsonl([{ ...ccUser("go"), sessionId: "c" }, apiError("c", "c1")]));
  writeFileSync(join(dir, "d.jsonl"), jsonl([{ ...ccUser("go"), sessionId: "d" }, { ...ccAssistant({ id: "d1", usage: { input_tokens: 0, output_tokens: 0 } }), sessionId: "d" }]));
  const r = audit([dir]);
  const one = (1000 * 3 + 100 * 15) / 1e6;
  assert.equal(r.runs.length, 4);
  assert.equal(r.perRun!.count, 2);
  assert.ok(Math.abs(r.perRun!.medianUsd - 1.5 * one) < 1e-12);
  assert.equal(r.perRun!.incomplete, 1); // b: priced, with one failed call
  assert.deepEqual(r.excludedRuns, { failed: 1, unpriced: 1 });
  const b = r.runs.find((x) => x.session === "b")!;
  assert.equal(b.failedCalls, 1);
  assert.match(b.notes.join("\n"), /1 of 3 model call\(s\) failed with an API error/);
  assert.doesNotMatch(b.notes.join("\n"), /no usage data/);
  assert.match(renderTable(r), /2 runs in 4 files · not counted: 1 failed, 1 with no usage data · 1 run priced in part \(lower bound\)/);
});

test("nothing priced at all: no cost per run, and the header says why", () => {
  const dir = mkdtempSync(join(tmpdir(), "burnlint-failed-"));
  writeFileSync(
    join(dir, "c.jsonl"),
    jsonl([{ ...ccUser("go"), sessionId: "c" }, { ...ccAssistant({ id: "c1", model: "<synthetic>", usage: { input_tokens: 0, output_tokens: 0 } }), sessionId: "c", isApiErrorMessage: true }]),
  );
  const r = audit([dir]);
  assert.equal(r.perRun, null);
  assert.match(renderTable(r), /0 runs in 1 file · not counted: 1 failed/);
});
