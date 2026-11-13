import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpFile } from "./helpers.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cli = join(root, "dist", "cli.js");
const fixture = join(root, "fixtures", "otel-deepseek-via-openai.json");

const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });

test("audit prints findings and exits 0 without --fail-on", () => {
  const r = run("audit", fixture);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /reread-unchanged/);
  assert.match(r.stdout, /openai -> deepseek/);
});

test("--fail-on gates on severity", () => {
  assert.equal(run("audit", fixture, "--fail-on", "low").status, 1);
  assert.equal(run("audit", fixture, "--fail-on", "high").status, 0);
});

test("json output parses", () => {
  const r = run("audit", fixture, "-f", "json");
  const j = JSON.parse(r.stdout);
  assert.equal(j.runs.length, 1);
  assert.equal(j.findings[0].rule, "reread-unchanged");
});

test("bad input exits 2", () => {
  assert.equal(run("audit", "/nope").status, 2);
  assert.equal(run("audit", fixture, "--fail-on", "maybe").status, 2);
});

test("a mistyped option is refused, not ignored", () => {
  const rule = run("audit", fixture, "--rule", "reread-unchange", "--fail-on", "low");
  assert.equal(rule.status, 2);
  assert.match(rule.stderr, /unknown rule: reread-unchange .*reread-unchanged/);
  assert.equal(run("audit", fixture, "--rule", "reread-unchanged", "--fail-on", "low").status, 1);

  for (const bad of ["abc", "", "-1", "Infinity"]) assert.equal(run("audit", fixture, "--high-usd", bad).status, 2, bad);
  assert.equal(run("audit", fixture, "--medium-usd", "abc").status, 2);
  assert.match(run("audit", fixture, "--medium-usd", "5").stderr, /must not be above --high-usd/);
  assert.equal(run("audit", fixture, "--high-usd", "0.0001", "--medium-usd", "0.0001", "--fail-on", "high").status, 1);

  assert.equal(run("audit", fixture, "-f", "yaml").status, 2);
  assert.match(run("audit", fixture, "--out", "x.jsonl").stderr, /audit does not take --out/);
  assert.match(run("record", "--fail-on", "low").stderr, /record does not take --fail-on/);
  assert.match(run("rules", "-v").stderr, /rules does not take --verbose/);
});

test("--prices rejects a file that would be silently ignored", () => {
  const prices = (content: string) => run("audit", fixture, "--prices", tmpFile("prices.json", content));
  assert.equal(prices(JSON.stringify({ "deepseek-chat": { input: 1, output: 2, cacheRead: null } })).status, 0);
  assert.match(prices("{oops").stderr, /--prices .*prices\.json/);
  assert.match(prices(JSON.stringify({ "deepseek-chat": { cache_read: 0.1 } })).stderr, /unknown field "cache_read"/);
  assert.match(prices(JSON.stringify({ "deepseek-chat": { input: "1.25" } })).stderr, /must be a number/);
  assert.equal(prices(JSON.stringify([1])).status, 2);
});

test("nothing to audit is an error, not a pass", () => {
  const junk = run("audit", tmpFile("junk.json", JSON.stringify({ a: 1 })), "--fail-on", "low");
  assert.equal(junk.status, 2);
  assert.match(junk.stderr, /no agent runs found.*1 file\(s\) could not be read/);
  // Still a well-formed report on stdout for whoever parses it.
  const asJson = run("audit", tmpFile("junk.json", JSON.stringify({ a: 1 })), "-f", "json");
  assert.equal(asJson.status, 2);
  assert.equal(JSON.parse(asJson.stdout).runs.length, 0);
});

test("--runs-per-month must be a volume above zero", () => {
  assert.equal(run("audit", fixture, "--runs-per-month", "0").status, 2);
  assert.equal(run("audit", fixture, "--runs-per-month", "lots").status, 2);
  const ok = run("audit", fixture, "--runs-per-month", "10,000");
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /per month .* at 10,000 runs/);
});
