import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { audit } from "../src/audit.js";
import { decodeTraceRequest, ProtobufError } from "../src/otlp-protobuf.js";
import { PriceTable } from "../src/pricing.js";
import { startRecorder } from "../src/record.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const outFile = () => join(mkdtempSync(join(tmpdir(), "burnlint-pb-")), "out.jsonl");

// --- a minimal protobuf encoder, for hand-built messages -----------------------

type Bytes = number[];
const varint = (n: number | bigint): Bytes => {
  let v = BigInt.asUintN(64, BigInt(n));
  const out: Bytes = [];
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return out;
};
const tag = (field: number, wire: number) => varint(field * 8 + wire);
const len = (field: number, bytes: Bytes): Bytes => [...tag(field, 2), ...varint(bytes.length), ...bytes];
const str = (field: number, s: string) => len(field, [...Buffer.from(s, "utf8")]);
const vint = (field: number, n: number | bigint) => [...tag(field, 0), ...varint(n)];
const f64 = (field: number, write: (b: Buffer) => void) => {
  const b = Buffer.alloc(8);
  write(b);
  return [...tag(field, 1), ...b];
};
const dbl = (field: number, x: number) => f64(field, (b) => b.writeDoubleLE(x));
const fixed64 = (field: number, n: bigint) => f64(field, (b) => b.writeBigUInt64LE(n));
const fixed32 = (field: number, n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return [...tag(field, 5), ...b];
};
const kv = (key: string, anyValue: Bytes) => [...str(1, key), ...len(2, anyValue)];
const attr = (field: number, key: string, anyValue: Bytes) => len(field, kv(key, anyValue));
/** ExportTraceServiceRequest > ResourceSpans > ScopeSpans > spans. */
const request = (...spans: Bytes[]) => Uint8Array.from(len(1, len(2, spans.flatMap((s) => len(2, s)))));
const spansOf = (req: { resourceSpans: Array<Record<string, any>> }) => req.resourceSpans[0]!.scopeSpans[0].spans;

const TRACE = Array.from({ length: 16 }, (_, i) => i + 1);
const SPAN = [0xaa, 0xbb, 0xcc, 0xdd, 0, 1, 2, 3];

// --- real exports ---------------------------------------------------------------

/** fixtures/otel-js-exports.ndjson: one tracer, two exporters (scripts/gen-protobuf-fixture.mjs). */
function jsExports() {
  const lines = readFileSync(join(root, "fixtures", "otel-js-exports.ndjson"), "utf8").trim().split("\n");
  const all = lines.map((l) => JSON.parse(l) as { contentType: string; body: string });
  return {
    json: all.filter((e) => e.contentType === "application/json").map((e) => e.body),
    protobuf: all.filter((e) => e.contentType === "application/x-protobuf").map((e) => Buffer.from(e.body, "base64")),
  };
}

/** Each span with its resource and scope, by span id. */
function bySpan(requests: Array<{ resourceSpans?: any[] }>): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const req of requests)
    for (const rs of req.resourceSpans ?? [])
      for (const ss of rs.scopeSpans ?? []) for (const s of ss.spans ?? []) out.set(s.spanId, { resource: rs.resource, scope: ss.scope, span: s });
  return out;
}

/** Protobuf leaves default values off the wire; the JSON exporter writes some of them out. */
const DEFAULTS = new Set(["droppedAttributesCount", "droppedEventsCount", "droppedLinksCount", "code"]);
function withoutDefaults(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(withoutDefaults);
  if (!x || typeof x !== "object") return x;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(x)) {
    if (DEFAULTS.has(k) && v === 0) continue;
    if ((k === "events" || k === "links") && Array.isArray(v) && !v.length) continue;
    out[k] = withoutDefaults(v);
  }
  return out;
}

test("real OTel JS protobuf exports decode to what the JSON exporter sent for the same spans", () => {
  const { json, protobuf } = jsExports();
  assert.equal(json.length, 4);
  assert.equal(protobuf.length, 4);
  const decoded = protobuf.map((b) => decodeTraceRequest(b));
  assert.equal(decoded.reduce((n, d) => n + d.spans, 0), 6);
  const want = bySpan(json.map((b) => JSON.parse(b)));
  const got = bySpan(decoded.map((d) => d.request));
  assert.equal(got.size, 6);
  assert.deepEqual([...got.keys()].sort(), [...want.keys()].sort());
  for (const [id, span] of got) assert.deepEqual(span, withoutDefaults(want.get(id)), id);

  // The capture covers what the JS API can set: check a few values made it through.
  const chat = [...got.values()].map((x: any) => x.span).find((s) => s.status?.code === 2)!;
  const value = (key: string) => chat.attributes.find((a: any) => a.key === key)?.value;
  assert.deepEqual(value("demo.big"), { intValue: 3000000000 });
  assert.deepEqual(value("demo.negative"), { intValue: -42 });
  assert.deepEqual(value("demo.zero"), { intValue: 0 });
  assert.deepEqual(value("demo.empty"), { stringValue: "" });
  assert.deepEqual(value("gen_ai.request.temperature"), { doubleValue: 0.5 });
  assert.equal(chat.status.message, "rate limited, retried");
  assert.equal(chat.links.length, 1);
  assert.equal(chat.events[0].name, "gen_ai.content.prompt");
});

test("recorded from protobuf, a trace audits the same as recorded from JSON", async () => {
  const { json, protobuf } = jsExports();
  const record = async (bodies: Array<string | Buffer>, contentType: string) => {
    const file = outFile();
    const r = await startRecorder({ file, port: 0 });
    try {
      for (const body of bodies) {
        const res = await fetch(`http://127.0.0.1:${r.port}/v1/traces`, {
          method: "POST",
          body: body as RequestInit["body"],
          headers: { "content-type": contentType },
        });
        assert.equal(res.status, 200);
      }
      assert.equal(r.stats.spans, 6);
      assert.equal(r.stats.protobuf, contentType.includes("protobuf") ? 4 : 0);
    } finally {
      await r.close();
    }
    return file;
  };
  const fromJson = audit([await record(json, "application/json")]);
  const fromProtobuf = audit([await record(protobuf, "application/x-protobuf")]);
  assert.equal(fromProtobuf.runs.length, 1);
  assert.equal(fromProtobuf.runs[0]!.calls, 3);
  assert.equal(fromProtobuf.runs[0]!.agent, "protobuf-demo-agent");
  assert.ok(fromProtobuf.totalCostUsd > 0);
  assert.equal(fromProtobuf.totalCostUsd, fromJson.totalCostUsd);
  const shape = (r: typeof fromJson) => ({
    runs: r.runs.map((x) => [x.calls, x.pricedCalls, x.failedCalls, x.costUsd, x.promptTokens, x.outputTokens, x.cacheReadTokens, x.labels]),
    findings: r.findings.map((f) => [f.rule, f.costUsd, f.avoidableUsd, f.message]),
  });
  assert.deepEqual(shape(fromProtobuf), shape(fromJson));
  assert.deepEqual(fromProtobuf.findings.map((f) => f.rule), ["reread-unchanged"]);
});

/** fixtures/otel-python-exports.ndjson: protobuf bodies plus the SDK's in-memory spans (scripts/gen-protobuf-fixture-python.py). */
function pythonExports() {
  const lines = readFileSync(join(root, "fixtures", "otel-python-exports.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  return {
    protobuf: lines.filter((l) => l.contentType).map((l) => Buffer.from(l.body, "base64")),
    sdkSpans: lines.find((l) => l.sdkSpans).sdkSpans as Array<{ span: { spanId: string } }>,
  };
}

test("real OTel Python protobuf exports decode to the spans the SDK held in memory", () => {
  const { protobuf, sdkSpans } = pythonExports();
  assert.equal(protobuf.length, 4);
  const got = bySpan(protobuf.map((b) => decodeTraceRequest(b).request));
  assert.equal(got.size, 8);
  // Not in the SDK's view: span flags (the exporter derives them from the context) and an unset status.
  const comparable = (x: any) => {
    const { flags: _f, status, links, ...span } = x.span;
    return {
      ...x,
      span: {
        ...span,
        ...(status && Object.keys(status).length ? { status } : {}),
        ...(links ? { links: links.map(({ flags: _lf, ...l }: any) => l) } : {}),
      },
    };
  };
  for (const want of sdkSpans) assert.deepEqual(comparable(got.get(want.span.spanId)), want, want.span.spanId);

  const chat = [...got.values()].map((x: any) => x.span).find((s) => s.status?.code === 2)!;
  const value = (key: string) => chat.attributes.find((a: any) => a.key === key)?.value;
  assert.deepEqual(value("demo.huge"), { intValue: "4611686018427387905" });
  assert.deepEqual(value("demo.min"), { intValue: "-9223372036854775808" });
  assert.deepEqual(value("demo.max"), { intValue: "9223372036854775807" });
  assert.deepEqual(value("demo.ints"), { arrayValue: { values: [{ intValue: 1 }, { intValue: -2 }, { intValue: "1152921504606846976" }] } });
});

test("recorded from Python protobuf, a trace audits to an independent total", async () => {
  const { protobuf } = pythonExports();
  const file = outFile();
  const r = await startRecorder({ file, port: 0 });
  try {
    for (const body of protobuf) {
      const res = await fetch(`http://127.0.0.1:${r.port}/v1/traces`, {
        method: "POST",
        body: body as RequestInit["body"],
        headers: { "content-type": "application/x-protobuf" },
      });
      assert.equal(res.status, 200);
    }
  } finally {
    await r.close();
  }
  const result = audit([file]);
  assert.equal(result.runs.length, 1);
  assert.equal(result.runs[0]!.agent, "python-demo-agent");
  assert.equal(result.runs[0]!.calls, 3);
  assert.deepEqual(result.findings.map((f) => f.rule), ["reread-unchanged"]);
  // Independent total from the script's usage numbers: input_tokens includes cache reads and writes.
  const p = new PriceTable().lookup("claude-sonnet-5-5")!;
  const [input, read, write, output] = [1200 + 2600 + 4000, 0 + 1100 + 2500, 1100 + 1400 + 0, 40 + 38 + 220];
  const want = ((input - read - write) * p.input! + read * p.cacheRead! + write * p.cacheWrite5m! + output * p.output!) / 1e6;
  assert.ok(Math.abs(result.totalCostUsd - want) < 1e-12, `${result.totalCostUsd} != ${want}`);
});

// --- hand-built messages: what the JS API can't send ------------------------------

test("every attribute type, 64-bit edge values, status, flags and unknown fields", () => {
  const span = [
    ...len(1, TRACE),
    ...len(2, SPAN),
    ...str(3, "vendor=1"),
    ...str(5, "chat"),
    ...vint(6, 3),
    ...fixed64(7, 1_700_000_000_123_456_789n),
    ...fixed64(8, 18_446_744_073_709_551_615n),
    ...attr(9, "s", str(1, "ünï ✓")),
    ...attr(9, "t", vint(2, 1)),
    ...attr(9, "f", vint(2, 0)),
    ...attr(9, "big", vint(3, 2n ** 60n)),
    ...attr(9, "neg", vint(3, -5)),
    ...attr(9, "min", vint(3, -(2n ** 63n))),
    ...attr(9, "d", dbl(4, -1.5)),
    ...attr(9, "nan", dbl(4, NaN)),
    ...attr(9, "arr", len(5, [...len(1, str(1, "a")), ...len(1, vint(3, 7))])),
    ...attr(9, "map", len(6, len(1, kv("inner", len(5, len(1, vint(2, 1))))))),
    ...attr(9, "raw", len(7, [0, 255, 16])),
    ...attr(9, "unset", []),
    ...vint(10, 3),
    ...len(15, [...str(2, "boom"), ...vint(3, 2)]),
    ...fixed32(16, 257),
    // Unknown fields of every wire type: skipped.
    ...vint(90, 1),
    ...fixed64(91, 5n),
    ...str(92, "later"),
    ...fixed32(93, 9),
  ];
  const { request: req, spans } = decodeTraceRequest(request(span));
  assert.equal(spans, 1);
  assert.deepEqual(spansOf(req), [
    {
      traceId: "0102030405060708090a0b0c0d0e0f10",
      spanId: "aabbccdd00010203",
      traceState: "vendor=1",
      name: "chat",
      kind: 3,
      startTimeUnixNano: "1700000000123456789",
      endTimeUnixNano: "18446744073709551615",
      attributes: [
        { key: "s", value: { stringValue: "ünï ✓" } },
        { key: "t", value: { boolValue: true } },
        { key: "f", value: { boolValue: false } },
        { key: "big", value: { intValue: "1152921504606846976" } },
        { key: "neg", value: { intValue: -5 } },
        { key: "min", value: { intValue: "-9223372036854775808" } },
        { key: "d", value: { doubleValue: -1.5 } },
        { key: "nan", value: { doubleValue: "NaN" } },
        { key: "arr", value: { arrayValue: { values: [{ stringValue: "a" }, { intValue: 7 }] } } },
        { key: "map", value: { kvlistValue: { values: [{ key: "inner", value: { arrayValue: { values: [{ boolValue: true }] } } }] } } },
        { key: "raw", value: { bytesValue: "AP8Q" } },
        { key: "unset", value: {} },
      ],
      droppedAttributesCount: 3,
      status: { message: "boom", code: 2 },
      flags: 257,
    },
  ]);
});

test("resource, scope, events, links and schema urls", () => {
  const span = [
    ...len(1, TRACE),
    ...len(2, SPAN),
    ...len(4, [9, 9, 9, 9, 9, 9, 9, 9]),
    ...len(11, [...fixed64(1, 5n), ...str(2, "retry"), ...attr(3, "n", vint(3, 2)), ...vint(4, 1)]),
    ...vint(12, 4),
    ...len(13, [...len(1, TRACE), ...len(2, SPAN), ...str(3, "x=y"), ...attr(4, "why", str(1, "prev")), ...fixed32(6, 1)]),
    ...vint(14, 2),
  ];
  const body = Uint8Array.from(
    len(1, [
      ...len(1, [...attr(1, "service.name", str(1, "svc")), ...vint(2, 1)]),
      ...len(2, [...len(1, [...str(1, "lib"), ...str(2, "1.0"), ...attr(3, "k", str(1, "v"))]), ...len(2, span), ...str(3, "https://scope")]),
      ...str(3, "https://resource"),
    ]),
  );
  const { request: req } = decodeTraceRequest(body);
  assert.deepEqual(req, {
    resourceSpans: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: "svc" } }], droppedAttributesCount: 1 },
        scopeSpans: [
          {
            scope: { name: "lib", version: "1.0", attributes: [{ key: "k", value: { stringValue: "v" } }] },
            spans: [
              {
                traceId: "0102030405060708090a0b0c0d0e0f10",
                spanId: "aabbccdd00010203",
                parentSpanId: "0909090909090909",
                events: [{ timeUnixNano: "5", name: "retry", attributes: [{ key: "n", value: { intValue: 2 } }], droppedAttributesCount: 1 }],
                droppedEventsCount: 4,
                links: [
                  {
                    traceId: "0102030405060708090a0b0c0d0e0f10",
                    spanId: "aabbccdd00010203",
                    traceState: "x=y",
                    attributes: [{ key: "why", value: { stringValue: "prev" } }],
                    flags: 1,
                  },
                ],
                droppedLinksCount: 2,
              },
            ],
            schemaUrl: "https://scope",
          },
        ],
        schemaUrl: "https://resource",
      },
    ],
  });
});

test("an empty export decodes to no spans", () => {
  assert.deepEqual(decodeTraceRequest(new Uint8Array()), { request: { resourceSpans: [] }, spans: 0 });
});

test("malformed protobuf is refused, never half-read", () => {
  const good = [...request([...len(1, TRACE), ...len(2, SPAN), ...str(5, "chat")])];
  const deep = (n: number): Bytes => (n === 0 ? vint(2, 1) : len(5, len(1, deep(n - 1))));
  const bad: Array<[string, Bytes]> = [
    ["truncated", good.slice(0, -1)],
    ["length past the end", [...tag(1, 2), ...varint(1000), 1, 2, 3]],
    ["known field, wrong wire type", [...request([...vint(5, 1)])]],
    ["group wire type", [...tag(7, 3)]],
    ["varint over 10 bytes", [...tag(90, 0), ...Array(11).fill(0x80), 0]],
    ["field number 0", [0x02, 0x00]],
    ["nested too deep", [...request([...attr(9, "x", deep(100))])]],
  ];
  for (const [why, bytes] of bad) assert.throws(() => decodeTraceRequest(Uint8Array.from(bytes)), ProtobufError, why);
  // Deep but legal nesting decodes.
  assert.equal(decodeTraceRequest(request([...attr(9, "x", deep(40))])).spans, 1);
});

// --- through the recorder -----------------------------------------------------------

test("record: protobuf accepted plain or gzipped, answered in protobuf; malformed refused with a Status", async () => {
  const file = outFile();
  const r = await startRecorder({ file, port: 0 });
  const post = (body: Uint8Array, headers: Record<string, string>) =>
    fetch(`http://127.0.0.1:${r.port}/v1/traces`, { method: "POST", body: body as RequestInit["body"], headers });
  try {
    const span = (id: number) => request([...len(1, TRACE), ...len(2, [...SPAN.slice(0, 7), id]), ...str(5, "chat"), ...fixed64(7, BigInt(id))]);
    const ok = await post(span(1), { "content-type": "application/x-protobuf" });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("content-type"), "application/x-protobuf");
    assert.equal((await ok.arrayBuffer()).byteLength, 0);
    assert.equal((await post(gzipSync(span(2)), { "content-type": "application/x-protobuf", "content-encoding": "gzip" })).status, 200);
    assert.equal((await post(span(3), { "content-type": "application/protobuf" })).status, 200);

    const refused = await post(Uint8Array.from([0x0a, 0x05, 0x01]), { "content-type": "application/x-protobuf" });
    assert.equal(refused.status, 400);
    assert.equal(refused.headers.get("content-type"), "application/x-protobuf");
    const status = Buffer.from(await refused.arrayBuffer());
    assert.equal(status[0], 0x12); // google.rpc.Status.message
    assert.match(status.subarray(2).toString("utf8"), /not a valid protobuf trace export: truncated/);
    // A content type a web page could send without a preflight is refused.
    assert.equal((await post(span(4), { "content-type": "text/protobuf" })).status, 415);
    assert.deepEqual([r.stats.requests, r.stats.protobuf, r.stats.spans, r.stats.invalid], [3, 3, 3, 2]);
  } finally {
    await r.close();
  }
  const lines = readFileSync(file, "utf8").trimEnd().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => spansOf(l)[0].startTimeUnixNano), ["1", "2", "3"]);
});

test("record: a protobuf export with no spans writes nothing", async () => {
  const file = outFile();
  const r = await startRecorder({ file, port: 0 });
  try {
    const res = await fetch(`http://127.0.0.1:${r.port}/v1/traces`, {
      method: "POST",
      body: new Uint8Array([0x0a, 0x00]),
      headers: { "content-type": "application/x-protobuf" },
    });
    assert.equal(res.status, 200);
  } finally {
    await r.close();
  }
  assert.equal(existsSync(file), false);
});
