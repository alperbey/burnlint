// Generates fixtures/recorded-otel-js-http-json.jsonl by sending spans through
// the official OpenTelemetry JS OTLP exporter to a running `burnlint record`.
//
// What is real: the wire format (OTLP/HTTP as @opentelemetry/exporter-trace-
// otlp-http encodes it) and the file, which is exactly what `record` wrote.
// What is scripted: the spans. They follow the gen_ai conventions the reader
// already handles; this fixture checks the receiver, not a new mapper.
//
// The scripted agent reads the same file twice, so reread-unchanged should
// fire. It flushes after every step, so the trace arrives as several exports
// and the root span arrives last.
//
// Checked with: @opentelemetry/api 1.9.1, sdk-trace-node 2.12.1,
//   resources 2.12.1, exporter-trace-otlp-http 0.223.2,
//   exporter-trace-otlp-proto 0.223.2
// Packages are resolved from the current directory, so run it from a folder
// where they are installed (not this repo: it has no runtime dependencies).
//
// Usage:
//   node dist/cli.js record -o fixtures/recorded-otel-js-http-json.jsonl
//   OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 \
//     node <repo>/scripts/gen-record-fixture.mjs [json|proto]
//
// `proto` sends protobuf instead, which `record` refuses (415). Set
// OTEL_EXPORTER_OTLP_COMPRESSION=gzip to exercise gzip request bodies.

import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(join(process.cwd(), "noop.js"));
const { trace, context, diag, DiagLogLevel } = require("@opentelemetry/api");
const { NodeTracerProvider, BatchSpanProcessor } = require("@opentelemetry/sdk-trace-node");
const { resourceFromAttributes } = require("@opentelemetry/resources");

const mode = process.argv[2] ?? "json";
const { OTLPTraceExporter } = require(
  mode === "proto" ? "@opentelemetry/exporter-trace-otlp-proto" : "@opentelemetry/exporter-trace-otlp-http",
);

// Print what the exporter itself reports, so a refused export is visible.
diag.setLogger(
  { error: console.error, warn: console.error, info() {}, debug() {}, verbose() {} },
  DiagLogLevel.WARN,
);

const provider = new NodeTracerProvider({
  resource: resourceFromAttributes({ "service.name": "record-demo-agent" }),
  spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())],
});
const tracer = provider.getTracer("demo-agent");

const FILE_BODY = "x = 1\n".repeat(900); // ~5.4k chars, ~1.35k tokens
const STEPS = [
  { input: 1200, output: 40, tool: true },
  { input: 2600, output: 38, tool: true },
  { input: 4000, output: 220, tool: false },
];

const root = tracer.startSpan("invoke_agent demo", {
  attributes: { "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": "demo" },
});
const ctx = trace.setSpan(context.active(), root);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

let n = 0;
for (const step of STEPS) {
  n++;
  tracer
    .startSpan(
      "chat gpt-5",
      {
        attributes: {
          "gen_ai.operation.name": "chat",
          "gen_ai.provider.name": "openai",
          "gen_ai.request.model": "gpt-5",
          "gen_ai.response.id": `chatcmpl-${n}`,
          "gen_ai.usage.input_tokens": step.input,
          "gen_ai.usage.output_tokens": step.output,
        },
      },
      ctx,
    )
    .end();
  await pause(5);
  if (step.tool) {
    tracer
      .startSpan(
        "execute_tool read_file",
        {
          attributes: {
            "gen_ai.operation.name": "execute_tool",
            "gen_ai.tool.name": "read_file",
            "gen_ai.tool.call.id": `call_${n}`,
            "gen_ai.tool.call.arguments": JSON.stringify({ path: "src/app.py" }),
            "gen_ai.tool.call.result": FILE_BODY,
          },
        },
        ctx,
      )
      .end();
    await pause(5);
  }
  await provider.forceFlush();
}
root.end();
await provider.shutdown();
console.log(`sent ${STEPS.length} chat span(s) as ${mode}`);
