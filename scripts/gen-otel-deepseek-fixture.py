"""Generates fixtures/otel-deepseek-via-openai.json.

Runs the official OpenTelemetry OpenAI instrumentation (opentelemetry-
instrumentation-openai-v2) against a local mock server that answers like
DeepSeek's OpenAI-compatible API, including DeepSeek's own cache fields
(prompt_cache_hit_tokens / prompt_cache_miss_tokens). Tool execution spans are
added by hand following the gen_ai execute_tool convention, as an agent
framework would.

The scripted agent reads the same file twice, so duplicate-tool-call /
reread-unchanged should fire on the output.

Requires: openai opentelemetry-sdk opentelemetry-instrumentation-openai-v2
          opentelemetry-exporter-otlp-proto-common
Usage:   python scripts/gen-otel-deepseek-fixture.py fixtures/otel-deepseek-via-openai.json
"""

import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

from google.protobuf.json_format import MessageToDict
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.common.trace_encoder import encode_spans
from opentelemetry.instrumentation.openai_v2 import OpenAIInstrumentor
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

# Scripted responses: two identical read_file calls, then a final answer.
SCRIPT = [
    {"tool": ("read_file", {"path": "src/app.py"}), "usage": (1200, 40, 0)},
    {"tool": ("read_file", {"path": "src/app.py"}), "usage": (2100, 38, 1152)},
    {"tool": None, "usage": (3000, 220, 2048)},
]
FILE_BODY = "x = 1\n" * 900  # ~5.4k chars, ~1.35k tokens


class Mock(BaseHTTPRequestHandler):
    step = 0

    def log_message(self, *a):
        pass

    def do_POST(self):
        self.rfile.read(int(self.headers.get("content-length", 0)))
        s = SCRIPT[min(Mock.step, len(SCRIPT) - 1)]
        Mock.step += 1
        prompt, completion, hit = s["usage"]
        msg = {"role": "assistant", "content": None if s["tool"] else "Done."}
        finish = "stop"
        if s["tool"]:
            name, args = s["tool"]
            msg["tool_calls"] = [
                {"id": f"call_{Mock.step}", "type": "function",
                 "function": {"name": name, "arguments": json.dumps(args)}}
            ]
            finish = "tool_calls"
        body = {
            "id": f"chatcmpl-{Mock.step}",
            "object": "chat.completion",
            "created": 1763000000 + Mock.step,
            "model": "deepseek-chat",
            "choices": [{"index": 0, "message": msg, "finish_reason": finish}],
            "usage": {
                "prompt_tokens": prompt,
                "completion_tokens": completion,
                "total_tokens": prompt + completion,
                "prompt_cache_hit_tokens": hit,
                "prompt_cache_miss_tokens": prompt - hit,
            },
        }
        data = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main(out):
    server = HTTPServer(("127.0.0.1", 0), Mock)
    threading.Thread(target=server.serve_forever, daemon=True).start()

    exporter = InMemorySpanExporter()
    provider = TracerProvider(resource=Resource.create({"service.name": "deepseek-demo-agent"}))
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    OpenAIInstrumentor().instrument(tracer_provider=provider)
    tracer = provider.get_tracer("demo-agent")

    from openai import OpenAI

    client = OpenAI(api_key="test", base_url=f"http://127.0.0.1:{server.server_port}/v1")
    tools = [{"type": "function", "function": {"name": "read_file", "parameters": {
        "type": "object", "properties": {"path": {"type": "string"}}}}}]
    messages = [{"role": "user", "content": "What does src/app.py do?"}]

    with tracer.start_as_current_span("invoke_agent demo", attributes={
        "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": "demo"}):
        for _ in range(len(SCRIPT)):
            r = client.chat.completions.create(model="deepseek-chat", messages=messages, tools=tools)
            m = r.choices[0].message
            if not m.tool_calls:
                break
            messages.append(m.model_dump(exclude_none=True))
            for tc in m.tool_calls:
                with tracer.start_as_current_span(f"execute_tool {tc.function.name}", attributes={
                    "gen_ai.operation.name": "execute_tool",
                    "gen_ai.tool.name": tc.function.name,
                    "gen_ai.tool.call.id": tc.id,
                    "gen_ai.tool.call.arguments": tc.function.arguments,
                    "gen_ai.tool.call.result": FILE_BODY,
                }):
                    pass
                messages.append({"role": "tool", "tool_call_id": tc.id, "content": FILE_BODY})

    provider.force_flush()
    req = encode_spans(exporter.get_finished_spans())
    with open(out, "w") as f:
        json.dump(MessageToDict(req), f, indent=1)
    server.shutdown()
    print(f"wrote {out}: {len(exporter.get_finished_spans())} spans")


if __name__ == "__main__":
    main(sys.argv[1])
