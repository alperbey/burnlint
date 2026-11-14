# Generates fixtures/otel-python-exports.ndjson: spans exported by the official
# OpenTelemetry Python OTLP/HTTP protobuf exporter, as the raw request bodies
# it sent, plus the same spans as the Python SDK held them in memory (an
# in-memory exporter on the same tracer), written out as OTLP/JSON by this
# script. `record`'s protobuf decoder is checked against it: decoding the
# bodies must give the in-memory spans. Python has no JSON exporter, so this
# is the independent side.
#
# What is real: the wire encoding (opentelemetry-exporter-otlp-proto-http with
# the protobuf runtime). What is scripted: the spans, with every attribute
# type the Python API allows, ints beyond 2^53 and down to -2^63, events,
# links, statuses and all span kinds.
#
# Checked with Python 3.14.2: opentelemetry-sdk 1.45.2,
#   opentelemetry-exporter-otlp-proto-http 1.45.2, opentelemetry-proto 1.45.2,
#   protobuf 7.36.2
#
#   python3 -m venv .venv && .venv/bin/pip install opentelemetry-sdk==1.45.2 \
#     opentelemetry-exporter-otlp-proto-http==1.45.2 protobuf==7.36.2
#   .venv/bin/python scripts/gen-protobuf-fixture-python.py fixtures/otel-python-exports.ndjson
#
# Output: one line per export, {"contentType", "body" (base64)}, then one line
# {"sdkSpans": [{resource, scope, span}, ...]}.

import base64
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http import Compression
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor, SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import Link, SpanKind, Status, StatusCode

if len(sys.argv) != 2:
    sys.exit("usage: gen-protobuf-fixture-python.py <out.ndjson>")
out = sys.argv[1]

exports = []


class Receiver(BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("content-length", 0)))
        if self.headers.get("content-encoding"):
            raise RuntimeError("unexpected content-encoding")
        exports.append({"contentType": self.headers.get("content-type"), "body": base64.b64encode(body).decode()})
        self.send_response(200)
        self.send_header("content-type", "application/x-protobuf")
        self.send_header("content-length", "0")
        self.end_headers()

    def log_message(self, *args):
        pass


server = HTTPServer(("127.0.0.1", 0), Receiver)
threading.Thread(target=server.serve_forever, daemon=True).start()
url = f"http://127.0.0.1:{server.server_address[1]}/v1/traces"

memory = InMemorySpanExporter()
provider = TracerProvider(
    resource=Resource.create({"service.name": "python-demo-agent", "deployment.environment": "ünïcödé ✓ 🚀"})
)
provider.add_span_processor(SimpleSpanProcessor(memory))
provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(endpoint=url, compression=Compression.NoCompression)))
tracer = provider.get_tracer("demo-agent", "0.9.0")

FILE_BODY = "x = 1\n" * 300
STEPS = [(1200, 40, 0, 1100), (2600, 38, 1100, 1400), (4000, 220, 2500, 0)]

with tracer.start_as_current_span(
    "invoke_agent demo",
    kind=SpanKind.SERVER,
    attributes={"gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": "demo"},
):
    first = None
    for n, (inp, outp, read, write) in enumerate(STEPS, 1):
        links = [Link(first.get_span_context(), {"link.reason": "previous step"})] if first else []
        with tracer.start_as_current_span(
            "chat claude-sonnet-5-5",
            kind=SpanKind.CLIENT,
            links=links,
            attributes={
                "gen_ai.operation.name": "chat",
                "gen_ai.provider.name": "anthropic",
                "gen_ai.request.model": "claude-sonnet-5-5",
                "gen_ai.response.id": f"msg_{n}",
                "gen_ai.usage.input_tokens": inp,
                "gen_ai.usage.output_tokens": outp,
                "gen_ai.usage.cache_read.input_tokens": read,
                "gen_ai.usage.cache_creation.input_tokens": write,
                "gen_ai.request.temperature": 0.5,
                "gen_ai.request.stop_sequences": ("\n\nHuman:", "END"),
                "demo.flags": [True, False],
                "demo.ints": [1, -2, 2**60],
                "demo.floats": [0.25, -1.5],
                "demo.huge": 2**62 + 1,
                "demo.min": -(2**63),
                "demo.max": 2**63 - 1,
                "demo.negative": -42,
                "demo.zero": 0,
                "demo.empty": "",
                "demo.retry": n == 2,
            },
            record_exception=False,
            set_status_on_exception=False,
        ) as chat:
            chat.add_event("gen_ai.content.prompt", {"gen_ai.prompt.length": 1234, "demo.ratio": 0.25})
            chat.set_status(Status(StatusCode.ERROR, "rate limited, retried") if n == 2 else Status(StatusCode.OK))
            first = first or chat
        if n < 3:
            with tracer.start_as_current_span(
                "execute_tool read_file",
                kind=SpanKind.INTERNAL,
                attributes={
                    "gen_ai.operation.name": "execute_tool",
                    "gen_ai.tool.name": "read_file",
                    "gen_ai.tool.call.id": f"toolu_{n}",
                    "gen_ai.tool.call.arguments": json.dumps({"path": "src/app.py"}),
                    "gen_ai.tool.call.result": FILE_BODY,
                },
            ):
                pass
        provider.force_flush()
    for kind in (SpanKind.PRODUCER, SpanKind.CONSUMER):
        with tracer.start_as_current_span(f"queue {kind.name.lower()}", kind=kind):
            pass

provider.force_flush()
provider.shutdown()
server.shutdown()


# The in-memory spans in OTLP/JSON form. Ints follow burnlint's JSON form:
# numbers up to 2^53, decimal strings beyond. Span flags are left out: the
# exporter derives them from the context (sampled, is-remote bits).
def any_value(v):
    if isinstance(v, bool):
        return {"boolValue": v}
    if isinstance(v, int):
        return {"intValue": v if abs(v) <= 2**53 - 1 else str(v)}
    if isinstance(v, float):
        return {"doubleValue": v}
    if isinstance(v, str):
        return {"stringValue": v}
    if isinstance(v, (list, tuple)):
        return {"arrayValue": {"values": [any_value(x) for x in v]}}
    raise TypeError(type(v))


def attributes(a):
    return [{"key": k, "value": any_value(v)} for k, v in (a or {}).items()]


def drop_empty(d):
    return {k: v for k, v in d.items() if v not in ("", [], None, 0, {})}


def span_json(s):
    status = drop_empty({"message": s.status.description or "", "code": s.status.status_code.value})
    return drop_empty(
        {
            "traceId": format(s.context.trace_id, "032x"),
            "spanId": format(s.context.span_id, "016x"),
            "parentSpanId": format(s.parent.span_id, "016x") if s.parent else "",
            "name": s.name,
            "kind": s.kind.value + 1,  # the API counts from INTERNAL = 0, OTLP from UNSPECIFIED = 0
            "startTimeUnixNano": str(s.start_time),
            "endTimeUnixNano": str(s.end_time),
            "attributes": attributes(s.attributes),
            "events": [
                drop_empty({"timeUnixNano": str(e.timestamp), "name": e.name, "attributes": attributes(e.attributes)})
                for e in s.events
            ],
            "links": [
                drop_empty(
                    {
                        "traceId": format(l.context.trace_id, "032x"),
                        "spanId": format(l.context.span_id, "016x"),
                        "attributes": attributes(l.attributes),
                    }
                )
                for l in s.links
            ],
            "status": status,
        }
    )


sdk_spans = [
    {
        "resource": {"attributes": attributes(s.resource.attributes)},
        "scope": drop_empty({"name": s.instrumentation_scope.name, "version": s.instrumentation_scope.version or ""}),
        "span": span_json(s),
    }
    for s in memory.get_finished_spans()
]

with open(out, "w", encoding="utf-8") as f:
    for e in exports:
        f.write(json.dumps(e) + "\n")
    f.write(json.dumps({"sdkSpans": sdk_spans}, ensure_ascii=False) + "\n")
print(f"{len(exports)} export(s) and {len(sdk_spans)} in-memory span(s) written to {out}")
