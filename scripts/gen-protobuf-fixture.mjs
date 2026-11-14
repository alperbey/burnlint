// Generates fixtures/otel-js-exports.ndjson: the same spans exported twice, by
// the official OpenTelemetry JS OTLP/HTTP JSON exporter and by its protobuf
// exporter, as the raw request bodies they sent. `record`'s protobuf decoder
// is checked against it: decoding each protobuf body must give the spans the
// JSON exporter sent.
//
// What is real: both wire encodings, byte for byte, from one tracer with two
// span processors (so both exporters see the same spans). What is scripted:
// the spans. They use every attribute type the JS API allows (string, int,
// double, bool, arrays), ints above 32 bits and negative, non-ASCII text,
// events, a link, every status code and several span kinds.
//
// Checked with: @opentelemetry/api 1.9.1, sdk-trace-node 2.12.1,
//   resources 2.12.1, exporter-trace-otlp-http 0.223.2,
//   exporter-trace-otlp-proto 0.223.2
// Packages are resolved from the current directory (this repo has no runtime
// dependencies), so run it from a folder where they are installed:
//   node <repo>/scripts/gen-protobuf-fixture.mjs <repo>/fixtures/otel-js-exports.ndjson
//
// Output: one line per export, {"contentType", "body"}; a JSON body is kept
// as text, a protobuf body as base64.

import { createServer } from "node:http";
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const out = process.argv[2];
if (!out) {
  console.error("usage: node gen-protobuf-fixture.mjs <out.ndjson>");
  process.exit(2);
}

const require = createRequire(join(process.cwd(), "noop.js"));
const { trace, context, diag, DiagLogLevel, SpanKind, SpanStatusCode } = require("@opentelemetry/api");
const { NodeTracerProvider, BatchSpanProcessor } = require("@opentelemetry/sdk-trace-node");
const { resourceFromAttributes } = require("@opentelemetry/resources");
const { OTLPTraceExporter: JsonExporter } = require("@opentelemetry/exporter-trace-otlp-http");
const { OTLPTraceExporter: ProtoExporter } = require("@opentelemetry/exporter-trace-otlp-proto");

diag.setLogger({ error: console.error, warn: console.error, info() {}, debug() {}, verbose() {} }, DiagLogLevel.WARN);

// Keeps every request body as received.
const exports = [];
const server = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    const contentType = String(req.headers["content-type"] ?? "");
    if (req.headers["content-encoding"]) throw new Error("unexpected content-encoding; unset OTEL_EXPORTER_OTLP_COMPRESSION");
    const proto = contentType.includes("protobuf");
    exports.push({ contentType, body: proto ? body.toString("base64") : body.toString("utf8") });
    res.writeHead(200, { "content-type": proto ? "application/x-protobuf" : "application/json" });
    res.end(proto ? Buffer.alloc(0) : "{}");
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/v1/traces`;

const provider = new NodeTracerProvider({
  resource: resourceFromAttributes({
    "service.name": "protobuf-demo-agent",
    "service.version": "1.2.3",
    "deployment.environment": "ünïcödé ✓ 🚀",
  }),
  spanProcessors: [
    new BatchSpanProcessor(new JsonExporter({ url })),
    new BatchSpanProcessor(new ProtoExporter({ url })),
  ],
});
const tracer = provider.getTracer("demo-agent", "0.9.0");

const root = tracer.startSpan("invoke_agent demo", {
  kind: SpanKind.INTERNAL,
  attributes: { "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": "demo", "bench.task": "explain" },
});
const ctx = trace.setSpan(context.active(), root);

const FILE_BODY = "x = 1\n".repeat(300);
const STEPS = [
  { input: 1200, output: 40, read: 0, write: 1100 },
  { input: 2600, output: 38, read: 1100, write: 1400 },
  { input: 4000, output: 220, read: 2500, write: 0 },
];
let first;
let n = 0;
for (const step of STEPS) {
  n++;
  const chat = tracer.startSpan(
    "chat claude-sonnet-5-5",
    {
      kind: SpanKind.CLIENT,
      attributes: {
        "gen_ai.operation.name": "chat",
        "gen_ai.provider.name": "anthropic",
        "gen_ai.request.model": "claude-sonnet-5-5",
        "gen_ai.response.id": `msg_${n}`,
        "gen_ai.usage.input_tokens": step.input,
        "gen_ai.usage.output_tokens": step.output,
        "gen_ai.usage.cache_read.input_tokens": step.read,
        "gen_ai.usage.cache_creation.input_tokens": step.write,
        "gen_ai.request.temperature": 0.5,
        "gen_ai.request.stop_sequences": ["\n\nHuman:", "END"],
        "gen_ai.response.finish_reasons": [n < 3 ? "tool_use" : "end_turn"],
        "demo.flags": [true, false],
        "demo.ints": [1, -2, 3000000000],
        "demo.big": 3000000000,
        "demo.negative": -42,
        "demo.zero": 0,
        "demo.empty": "",
        "demo.retry": n === 2,
      },
      links: first ? [{ context: first.spanContext(), attributes: { "link.reason": "previous step" } }] : [],
    },
    ctx,
  );
  chat.addEvent("gen_ai.content.prompt", { "gen_ai.prompt.length": 1234, "demo.ratio": 0.25 });
  if (n === 2) chat.setStatus({ code: SpanStatusCode.ERROR, message: "rate limited, retried" });
  else chat.setStatus({ code: SpanStatusCode.OK });
  chat.end();
  first ??= chat;
  if (n < 3) {
    tracer
      .startSpan(
        "execute_tool read_file",
        {
          kind: SpanKind.INTERNAL,
          attributes: {
            "gen_ai.operation.name": "execute_tool",
            "gen_ai.tool.name": "read_file",
            "gen_ai.tool.call.id": `toolu_${n}`,
            "gen_ai.tool.call.arguments": JSON.stringify({ path: "src/app.py" }),
            "gen_ai.tool.call.result": FILE_BODY,
          },
        },
        ctx,
      )
      .end();
  }
  await provider.forceFlush();
}
root.end();
await provider.forceFlush();
await provider.shutdown();
server.close();

writeFileSync(out, exports.map((e) => JSON.stringify(e)).join("\n") + "\n");
const count = (t) => exports.filter((e) => e.contentType.includes(t)).length;
console.log(`${exports.length} export(s) written to ${out}: ${count("json")} JSON, ${count("protobuf")} protobuf`);
