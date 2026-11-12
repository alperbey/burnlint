import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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
