// Reads OTLP/JSON trace exports and maps OpenTelemetry GenAI spans to runs.
//
// Accepts a single ExportTraceServiceRequest ({ resourceSpans: [...] }), an
// array of them, or JSONL with one request per line (the OTel Collector file
// exporter format, and what `burnlint record` writes).
//
// gen_ai mapping notes, checked against opentelemetry-instrumentation-openai-v2:
// - Older instrumentations report the provider in gen_ai.system, newer ones in
//   gen_ai.provider.name. Both are read.
// - Calls through an OpenAI-compatible client to another vendor (DeepSeek,
//   Qwen, ...) are labeled "openai". The real provider is inferred from the
//   server address or model name.
// - gen_ai.usage.input_tokens is the total prompt, including cached tokens.
//   When cache attributes are absent, cache usage is unknown (not zero) and
//   the call is priced as if nothing was cached, which is an upper bound.

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { ModelCall, Run, ToolCall, Turn } from "../model.js";
import { emptyTokens } from "../model.js";
import { resolveProvider } from "../pricing.js";
import { classifyTool, contentKey, estimateTokens, stableKey } from "../tools.js";

type AnyValue = {
  stringValue?: string;
  intValue?: string | number;
  doubleValue?: number;
  boolValue?: boolean;
  arrayValue?: { values?: AnyValue[] };
  kvlistValue?: { values?: KeyValue[] };
};
type KeyValue = { key: string; value?: AnyValue };

interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeUnixNano?: string | number;
  attributes?: KeyValue[];
  status?: { code?: number | string };
}

interface ExportRequest {
  resourceSpans?: Array<{
    resource?: { attributes?: KeyValue[] };
    scopeSpans?: Array<{ spans?: OtlpSpan[] }>;
  }>;
}

interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  start: bigint;
  attrs: Record<string, unknown>;
  service?: string;
  /** Span status is ERROR. */
  error: boolean;
}

export function looksLikeOtlp(text: string): boolean {
  return /"resourceSpans"\s*:/.test(text.slice(0, 20000));
}

function decode(v: AnyValue | undefined): unknown {
  if (!v) return undefined;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.intValue !== undefined) return Number(v.intValue);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.boolValue !== undefined) return v.boolValue;
  if (v.arrayValue) return (v.arrayValue.values ?? []).map(decode);
  if (v.kvlistValue) return attrsOf(v.kvlistValue.values);
  return undefined;
}

function attrsOf(kvs: KeyValue[] | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const kv of kvs ?? []) out[kv.key] = decode(kv.value);
  return out;
}

function parseRequests(text: string): { requests: ExportRequest[]; badLines: number } {
  const trimmed = text.trim();
  try {
    const whole = JSON.parse(trimmed);
    return { requests: Array.isArray(whole) ? whole : [whole], badLines: 0 };
  } catch {
    // JSONL. A line cut short (recorder killed mid-write) costs that line, not the file.
    const requests: ExportRequest[] = [];
    let badLines = 0;
    for (const line of trimmed.split("\n")) {
      if (!line.trim()) continue;
      try {
        requests.push(JSON.parse(line) as ExportRequest);
      } catch {
        badLines++;
      }
    }
    if (!requests.length) throw new Error("not valid JSON or JSONL");
    return { requests, badLines };
  }
}

export function readOtlp(file: string): Run[] {
  const spans: Span[] = [];
  const { requests, badLines } = parseRequests(readFileSync(file, "utf8"));
  for (const req of requests) {
    for (const rs of req.resourceSpans ?? []) {
      const res = attrsOf(rs.resource?.attributes);
      for (const ss of rs.scopeSpans ?? []) {
        for (const s of ss.spans ?? []) {
          spans.push({
            traceId: hexId(s.traceId),
            spanId: hexId(s.spanId),
            parentSpanId: s.parentSpanId ? hexId(s.parentSpanId) : undefined,
            name: s.name,
            start: BigInt(s.startTimeUnixNano ?? 0),
            attrs: attrsOf(s.attributes),
            service: typeof res["service.name"] === "string" ? (res["service.name"] as string) : undefined,
            error: s.status?.code === 2 || s.status?.code === "STATUS_CODE_ERROR",
          });
        }
      }
    }
  }

  const byTrace = new Map<string, Span[]>();
  for (const s of spans) {
    if (!byTrace.has(s.traceId)) byTrace.set(s.traceId, []);
    byTrace.get(s.traceId)!.push(s);
  }

  const runs: Run[] = [];
  for (const [traceId, list] of byTrace) {
    const run = buildRun(list, file, traceId);
    if (badLines) run.notes.push(`${badLines} unparseable line(s) skipped`);
    if (run.turns.length) runs.push(run);
  }
  return runs;
}

const LLM_OPS = new Set(["chat", "generate_content", "text_completion", "responses", "inference"]);

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

function isLlm(s: Span): boolean {
  const op = str(s.attrs["gen_ai.operation.name"]);
  if (op && LLM_OPS.has(op)) return true;
  if (op === "execute_tool") return false;
  return num(s.attrs["gen_ai.usage.input_tokens"]) != null || num(s.attrs["gen_ai.usage.output_tokens"]) != null;
}

function isTool(s: Span): boolean {
  return str(s.attrs["gen_ai.operation.name"]) === "execute_tool" || str(s.attrs["gen_ai.tool.name"]) != null;
}

function buildRun(list: Span[], file: string, traceId: string): Run {
  list.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  const parent = new Map(list.map((s) => [s.spanId, s.parentSpanId]));

  let llm = list.filter(isLlm);
  // Drop aggregate spans: a usage-carrying span that is an ancestor of another
  // usage-carrying span (e.g. an agent span summing its children).
  const llmIds = new Set(llm.map((s) => s.spanId));
  const ancestors = new Set<string>();
  for (const s of llm) {
    let p = s.parentSpanId;
    while (p) {
      if (llmIds.has(p)) ancestors.add(p);
      p = parent.get(p);
    }
  }
  const aggregates = ancestors.size;
  llm = llm.filter((s) => !ancestors.has(s.spanId));

  const notes: string[] = [];
  let relabeled = 0;
  let cacheUnknown = 0;
  let noUsage = 0;
  let failed = 0;
  const relabels = new Set<string>();

  const turns: Turn[] = llm.map((s, index) => {
    const a = s.attrs;
    const model = str(a["gen_ai.response.model"]) ?? str(a["gen_ai.request.model"]);
    const prov = resolveProvider({
      reported: str(a["gen_ai.provider.name"]) ?? str(a["gen_ai.system"]),
      model,
      host: str(a["server.address"]),
    });
    if (prov.source === "relabeled") {
      relabeled++;
      relabels.add(`${prov.reported} -> ${prov.provider}`);
    }

    const total = num(a["gen_ai.usage.input_tokens"]);
    const output = num(a["gen_ai.usage.output_tokens"]);
    let tokens: ModelCall["tokens"] = null;
    if (total != null || output != null) {
      const t = emptyTokens();
      const cacheRead =
        num(a["gen_ai.usage.cache_read.input_tokens"]) ??
        num(a["gen_ai.usage.cache_read_input_tokens"]) ??
        num(a["deepseek.prompt_cache_hit_tokens"]);
      const cacheWrite =
        num(a["gen_ai.usage.cache_creation.input_tokens"]) ?? num(a["gen_ai.usage.cache_creation_input_tokens"]);
      t.cacheKnown = cacheRead != null || cacheWrite != null;
      t.cacheRead = cacheRead;
      t.cacheWriteOther = cacheWrite;
      t.input = total == null ? null : Math.max(0, total - (cacheRead ?? 0) - (cacheWrite ?? 0));
      t.output = output;
      t.reasoning = num(a["gen_ai.usage.reasoning.output_tokens"]);
      if (!t.cacheKnown) cacheUnknown++;
      tokens = t;
    } else if (s.error) {
      failed++;
    } else {
      noUsage++;
    }

    const call: ModelCall = {
      id: str(a["gen_ai.response.id"]) ?? s.spanId,
      ts: nanoToIso(s.start),
      model,
      provider: prov.provider,
      providerSource: prov.source,
      reportedProvider: prov.source === "relabeled" ? prov.reported : undefined,
      tokens,
      failed: (s.error && !tokens) || undefined,
    };
    return { index, call, tools: [] };
  });

  // Attach each tool span to the latest model call that started before it.
  let orphanTools = 0;
  for (const s of list.filter(isTool)) {
    let owner: Turn | undefined;
    for (let i = llm.length - 1; i >= 0; i--) {
      if (llm[i]!.start <= s.start) {
        owner = turns[i];
        break;
      }
    }
    if (!owner) {
      orphanTools++;
      owner = turns[0];
    }
    if (!owner) continue;
    owner.tools.push(toolFromSpan(s));
  }

  if (relabeled) notes.push(`${relabeled} call(s) relabeled by model/server: ${[...relabels].join(", ")}`);
  if (cacheUnknown)
    notes.push(`${cacheUnknown} call(s) report no cache usage; their cost is an upper bound (cached tokens priced at full rate)`);
  if (noUsage) notes.push(`${noUsage} model call(s) have no usage data (not priced)`);
  if (failed) notes.push(`${failed} model call(s) failed with an error status (not priced)`);
  if (aggregates) notes.push(`${aggregates} aggregate span(s) skipped to avoid double counting`);
  if (orphanTools) notes.push(`${orphanTools} tool span(s) started before any model call`);

  const service = list.find((s) => s.service)?.service;
  return {
    id: `${basename(file)}#${traceId.slice(0, 12)}`,
    source: "otlp",
    dialect: "gen_ai",
    file,
    agent: service,
    turns,
    notes,
  };
}

function toolFromSpan(s: Span): ToolCall {
  const a = s.attrs;
  const name = str(a["gen_ai.tool.name"]) ?? s.name.replace(/^execute_tool\s+/, "");
  const rawArgs = a["gen_ai.tool.call.arguments"];
  let input: unknown = rawArgs;
  if (typeof rawArgs === "string") {
    try {
      input = JSON.parse(rawArgs);
    } catch {
      input = rawArgs;
    }
  }
  const { kind, target } = classifyTool(name, input);
  const result = a["gen_ai.tool.call.result"];
  return {
    id: str(a["gen_ai.tool.call.id"]) ?? s.spanId,
    ts: nanoToIso(s.start),
    name,
    input,
    inputKey: input === undefined ? undefined : stableKey(input),
    kind,
    target,
    isError: s.attrs["error.type"] != null ? true : undefined,
    resultTokens:
      result === undefined ? undefined : estimateTokens(typeof result === "string" ? result : JSON.stringify(result)),
    resultKey: result === undefined ? undefined : contentKey(result),
  };
}

/**
 * OTLP/JSON specifies hex ids, but protobuf's generic JSON mapping (used by
 * some SDK exporters) emits base64. Normalize to hex.
 */
function hexId(id: string): string {
  if (/^[0-9a-f]+$/i.test(id) && (id.length === 32 || id.length === 16)) return id.toLowerCase();
  try {
    const hex = Buffer.from(id, "base64").toString("hex");
    if (hex.length === 32 || hex.length === 16) return hex;
  } catch {
    // fall through
  }
  return id;
}

function nanoToIso(n: bigint): string | undefined {
  if (n === 0n) return undefined;
  return new Date(Number(n / 1_000_000n)).toISOString();
}
