import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function tmpFile(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "burnlint-test-"));
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}

// --- Claude Code transcript builders ---------------------------------------

let seq = 0;
const base = (extra: object) => ({ sessionId: "s1", parentUuid: null, uuid: `u${++seq}`, isSidechain: false, ...extra });

export function ccUser(text: string, ts = "2026-11-01T10:00:00Z") {
  return base({ type: "user", timestamp: ts, message: { role: "user", content: text } });
}

export function ccToolResult(toolUseId: string, content: string, isError = false, ts = "2026-11-01T10:00:01Z") {
  return base({
    type: "user",
    timestamp: ts,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content, is_error: isError }] },
  });
}

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
}

export function ccAssistant(opts: {
  id: string;
  model?: string;
  usage?: Usage;
  tools?: Array<{ id: string; name: string; input: unknown }>;
  text?: string;
  ts?: string;
  sidechain?: boolean;
}) {
  const content: unknown[] = [];
  if (opts.text) content.push({ type: "text", text: opts.text });
  for (const t of opts.tools ?? []) content.push({ type: "tool_use", id: t.id, name: t.name, input: t.input });
  return base({
    type: "assistant",
    timestamp: opts.ts ?? "2026-11-01T10:00:00Z",
    isSidechain: opts.sidechain ?? false,
    agentId: opts.sidechain ? "agent-1" : undefined,
    message: {
      id: opts.id,
      role: "assistant",
      model: opts.model ?? "claude-sonnet-4-6",
      content,
      usage: opts.usage ?? { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50 },
    },
  });
}

export const jsonl = (lines: object[]) => lines.map((l) => JSON.stringify(l)).join("\n") + "\n";

// --- OTLP builders -----------------------------------------------------------

type Attr = string | number | boolean;

const toAny = (v: Attr) =>
  typeof v === "string" ? { stringValue: v } : typeof v === "boolean" ? { boolValue: v } : Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };

export function span(opts: { id: string; parent?: string; name: string; start: number; attrs: Record<string, Attr>; trace?: string }) {
  return {
    traceId: opts.trace ?? "0af7651916cd43dd8448eb211c80319c",
    spanId: opts.id.padStart(16, "0"),
    parentSpanId: opts.parent ? opts.parent.padStart(16, "0") : undefined,
    name: opts.name,
    startTimeUnixNano: String(BigInt(1763000000000 + opts.start) * 1_000_000n),
    attributes: Object.entries(opts.attrs).map(([key, v]) => ({ key, value: toAny(v) })),
  };
}

export function otlp(spans: object[], service = "test-agent") {
  return {
    resourceSpans: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: service } }] },
        scopeSpans: [{ spans }],
      },
    ],
  };
}

export function chatSpan(id: string, start: number, attrs: Record<string, Attr>, parent?: string) {
  return span({ id, parent, name: "chat", start, attrs: { "gen_ai.operation.name": "chat", ...attrs } });
}

export function toolSpan(id: string, start: number, name: string, args: object, result = "x".repeat(4000), parent?: string) {
  return span({
    id,
    parent,
    name: `execute_tool ${name}`,
    start,
    attrs: {
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": name,
      "gen_ai.tool.call.id": `call_${id}`,
      "gen_ai.tool.call.arguments": JSON.stringify(args),
      "gen_ai.tool.call.result": result,
    },
  });
}
