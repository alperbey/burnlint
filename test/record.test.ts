import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { audit } from "../src/audit.js";
import { PriceTable } from "../src/pricing.js";
import { startRecorder, type Recorder } from "../src/record.js";
import { chatSpan, otlp, tmpFile, toolSpan } from "./helpers.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixture = join(root, "fixtures", "otel-deepseek-via-openai.json");

const outFile = () => join(mkdtempSync(join(tmpdir(), "burnlint-record-")), "out.jsonl");

async function withRecorder(file: string, fn: (r: Recorder, url: string) => Promise<void>) {
  const r = await startRecorder({ file, port: 0 });
  try {
    await fn(r, `http://127.0.0.1:${r.port}`);
  } finally {
    await r.close();
  }
}

const post = (url: string, body: string | Uint8Array, headers: Record<string, string> = {}) =>
  fetch(url, { method: "POST", body: body as RequestInit["body"], headers: { "content-type": "application/json", ...headers } });

const chat = (id: string, start: number, input: number) =>
  chatSpan(id, start, { "gen_ai.request.model": "gpt-5.5", "gen_ai.usage.input_tokens": input, "gen_ai.usage.output_tokens": 10 });

test("a recorded trace audits the same as the original export", async () => {
  const file = outFile();
  await withRecorder(file, async (r, url) => {
    // The fixture is pretty-printed: the recorder has to fold it onto one line.
    const res = await post(`${url}/v1/traces`, readFileSync(fixture, "utf8"));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/json");
    assert.deepEqual(await res.json(), {});
    assert.equal(r.stats.requests, 1);
    assert.equal(r.stats.spans, 6);
  });

  assert.equal(readFileSync(file, "utf8").trimEnd().split("\n").length, 1);
  const recorded = audit([file]);
  const original = audit([fixture]);
  assert.equal(recorded.runs.length, 1);
  assert.equal(recorded.totalCostUsd, original.totalCostUsd);
  assert.deepEqual(
    recorded.findings.map((f) => [f.rule, f.costUsd]),
    original.findings.map((f) => [f.rule, f.costUsd]),
  );
});

test("real OTel JS exporter capture: replays byte for byte and audits to an independent total", async () => {
  // Written by `burnlint record` from @opentelemetry/exporter-trace-otlp-http 0.223.2
  // (scripts/gen-record-fixture.mjs): 4 exports, root span last.
  const captured = join(root, "fixtures", "recorded-otel-js-http-json.jsonl");
  const lines = readFileSync(captured, "utf8").trimEnd().split("\n");
  assert.equal(lines.length, 4);

  const file = outFile();
  await withRecorder(file, async (r, url) => {
    for (const line of lines) assert.equal((await post(`${url}/v1/traces`, line)).status, 200);
    assert.equal(r.stats.spans, 6);
  });
  assert.equal(readFileSync(file, "utf8"), readFileSync(captured, "utf8"));

  const result = audit([file]);
  assert.equal(result.runs.length, 1);
  assert.equal(result.runs[0]!.agent, "record-demo-agent");
  assert.equal(result.runs[0]!.calls, 3);
  assert.deepEqual(result.findings.map((f) => f.rule), ["reread-unchanged"]);
  // Independent total: 1200+2600+4000 input and 40+38+220 output tokens, cache unknown.
  const gpt5 = new PriceTable().lookup("gpt-5")!;
  assert.ok(Math.abs(result.totalCostUsd - (7800 * gpt5.input! + 298 * gpt5.output!) / 1e6) < 1e-12);
});

test("one line per export; spans of a trace split across exports form one run", async () => {
  const file = outFile();
  await withRecorder(file, async (r, url) => {
    await post(`${url}/v1/traces`, JSON.stringify(otlp([chat("1", 0, 100)])));
    await post(`${url}/v1/traces`, JSON.stringify(otlp([toolSpan("2", 3, "read_file", { path: "a.py" })])));
    await post(`${url}/v1/traces`, gzipSync(JSON.stringify(otlp([chat("3", 6, 1200)]))), { "content-encoding": "gzip" });
    assert.equal(r.stats.requests, 3);
    assert.equal(r.stats.spans, 3);
  });
  assert.equal(readFileSync(file, "utf8").trimEnd().split("\n").length, 3);
  const result = audit([file]);
  assert.equal(result.runs.length, 1);
  assert.equal(result.runs[0]!.calls, 2);
});

test("the trace file is private to the user", { skip: process.platform === "win32" }, async () => {
  const file = outFile();
  await withRecorder(file, async (_r, url) => {
    await post(`${url}/v1/traces`, JSON.stringify(otlp([chat("1", 0, 100)])));
  });
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("protobuf trace exports are refused with 415 and a hint, nothing is written", async () => {
  const file = outFile();
  await withRecorder(file, async (r, url) => {
    const res = await post(`${url}/v1/traces`, new Uint8Array([0x0a, 0x00]), { "content-type": "application/x-protobuf" });
    assert.equal(res.status, 415);
    assert.equal(res.headers.get("content-type"), "application/x-protobuf");
    // google.rpc.Status: field 2 (message), length-delimited.
    const body = Buffer.from(await res.arrayBuffer());
    assert.equal(body[0], 0x12);
    assert.equal(body[1], body.length - 2);
    assert.match(body.subarray(2).toString("utf8"), /OTEL_EXPORTER_OTLP_PROTOCOL=http\/json/);
    assert.equal(r.stats.protobufRefused, 1);
  });
  assert.equal(existsSync(file), false);
});

test("log and metric exports are acknowledged and dropped", async () => {
  const file = outFile();
  await withRecorder(file, async (r, url) => {
    assert.equal((await post(`${url}/v1/logs`, JSON.stringify({ resourceLogs: [{}] }))).status, 200);
    const res = await post(`${url}/v1/metrics`, new Uint8Array([0x0a, 0x00]), { "content-type": "application/x-protobuf" });
    assert.equal(res.status, 200);
    assert.equal((await res.arrayBuffer()).byteLength, 0);
    assert.equal(r.stats.logsDropped, 1);
    assert.equal(r.stats.metricsDropped, 1);
  });
  assert.equal(existsSync(file), false);
});

test("unreadable, mistyped and empty exports are refused or skipped", async () => {
  const file = outFile();
  await withRecorder(file, async (r, url) => {
    assert.equal((await post(`${url}/v1/traces`, "{not json")).status, 400);
    assert.equal((await post(`${url}/v1/traces`, "[]")).status, 400);
    assert.equal((await post(`${url}/v1/traces`, "abc", { "content-encoding": "gzip" })).status, 400);
    assert.equal((await post(`${url}/v1/traces`, "{}", { "content-encoding": "br" })).status, 415);
    // What a web page could send cross-origin without a preflight.
    const span = JSON.stringify(otlp([chat("1", 0, 100)]));
    assert.equal((await post(`${url}/v1/traces`, span, { "content-type": "text/plain" })).status, 415);
    assert.equal((await post(`${url}/v1/traces`, span, { "content-type": "application/json; charset=utf-8" })).status, 200);
    assert.equal(r.stats.invalid, 5);
    // Valid but empty: accepted, not written.
    assert.equal((await post(`${url}/v1/traces`, "{}")).status, 200);
    assert.equal((await post(`${url}/v1/traces`, JSON.stringify(otlp([])))).status, 200);
    assert.equal((await post(`${url}/nope`, "{}")).status, 404);
    assert.equal((await fetch(`${url}/v1/traces`)).status, 405);
    assert.equal(r.stats.requests, 1);
  });
  assert.equal(readFileSync(file, "utf8").trimEnd().split("\n").length, 1);
});

test("appends to an existing trace file, refuses any other existing file", async () => {
  // Existing export without a trailing newline: the new line must not be glued to it.
  const file = tmpFile("out.jsonl", JSON.stringify(otlp([chat("1", 0, 100)])));
  await withRecorder(file, async (_r, url) => {
    await post(`${url}/v1/traces`, JSON.stringify(otlp([chat("2", 5, 200)])));
  });
  assert.equal(audit([file]).runs[0]!.calls, 2);

  const other = tmpFile("session.jsonl", JSON.stringify({ type: "user", sessionId: "s1" }) + "\n");
  await assert.rejects(startRecorder({ file: other, port: 0 }), /not an OTLP trace file/);
  assert.equal(readFileSync(other, "utf8"), JSON.stringify({ type: "user", sessionId: "s1" }) + "\n");
});

test("a port that is taken is reported with a way out", async () => {
  await withRecorder(outFile(), async (r) => {
    await assert.rejects(startRecorder({ file: outFile(), port: r.port }), /already in use.*--port/);
  });
});

test("cli: record until SIGINT, then audit the file", { skip: process.platform === "win32" }, async () => {
  const cli = join(root, "dist", "cli.js");
  const file = outFile();
  const child = spawn(process.execPath, [cli, "record", "--port", "0", "-o", file], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  const url = await new Promise<string>((resolve, reject) => {
    child.stderr.on("data", (d: string) => {
      stderr += d;
      const m = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(stderr);
      if (m) resolve(m[1]!);
    });
    child.on("exit", () => reject(new Error(`record exited early: ${stderr}`)));
  });
  assert.equal((await post(`${url}/v1/traces`, readFileSync(fixture, "utf8"))).status, 200);

  const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
  child.kill("SIGINT");
  assert.equal(await exited, 0, stderr);
  assert.match(stderr, /recorded 6 span\(s\) from 1 export\(s\)/);
  assert.equal(audit([file]).findings[0]!.rule, "reread-unchanged");
});

test("cli: record rejects bad arguments", async () => {
  const cli = join(root, "dist", "cli.js");
  const run = (...args: string[]) =>
    new Promise<number | null>((resolve) => spawn(process.execPath, [cli, "record", ...args]).on("exit", resolve));
  assert.equal(await run("-o", "trace.txt"), 2);
  assert.equal(await run("--port", "http"), 2);
  assert.equal(await run("extra-path"), 2);
});
