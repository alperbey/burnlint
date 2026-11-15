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
//
// Vercel AI SDK `ai.*` spans, checked against ai 7.0.157 with
// LegacyOpenTelemetry from @ai-sdk/otel 1.0.157 (the format AI SDK 6 and
// earlier emit by default is expected to match, not yet checked on a capture):
// - One model call is an `ai.generateText.doGenerate` / `ai.streamText.doStream`
//   (or generateObject / streamObject) span, named in `ai.operationId`. The
//   parent `ai.generateText` sums its steps and carries no gen_ai.usage.
// - gen_ai.usage.input_tokens is the total prompt, as above; cache reads and
//   writes are only in ai.usage.inputTokenDetails.cacheReadTokens and
//   .cacheWriteTokens (5m and 1h writes not split).
// - A failed call is a model span with error status and no usage. Retries
//   inside the SDK are one span: "Failed after 3 attempts" on a single span.
// - Tool calls are `ai.toolCall` spans: ai.toolCall.name/.id/.args/.result.
//
// OpenInference spans, checked against openinference-instrumentation-openai-agents
// 2.8.3 (OpenAI Agents SDK 0.24.0, gpt-5.4-mini over the Responses API):
// - The kind is in `openinference.span.kind`: one model call per LLM span,
//   one tool call per TOOL span; AGENT and CHAIN spans carry no usage.
// - llm.token_count.prompt is the whole prompt, cached tokens included; cache
//   reads in llm.token_count.prompt_details.cache_read (and .cache_write, 0 for
//   OpenAI), reasoning in llm.token_count.completion_details.reasoning.
//   Model in llm.model_name, provider in llm.provider or llm.system.
// - A TOOL span has tool.name, its JSON arguments in input.value and the result
//   as plain text in output.value. No tool call id.
// - Each message is a separate attribute, so a long conversation's LLM span
//   passes the OTel Python SDK's default limit of 128 attributes and the
//   oldest are dropped, token counts included (droppedAttributesCount > 0).

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { ModelCall, PromptKeys, Run, ToolCall, Turn } from "../model.js";
import { emptyTokens } from "../model.js";
import { resolveProvider } from "../pricing.js";
import { classifyTool, contentKey, estimateTokens, lineKeys, stableKey } from "../tools.js";

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
  droppedAttributesCount?: number;
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
  /** Attributes the sender dropped at its attribute limit. */
  dropped: number;
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
            dropped: Number(s.droppedAttributesCount ?? 0) || 0,
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
/** Vercel AI SDK `ai.*` spans that are one model call. */
const AI_SDK_CALL_OPS = new Set(["ai.generateText.doGenerate", "ai.streamText.doStream", "ai.generateObject.doGenerate", "ai.streamObject.doStream"]);

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

const openInferenceKind = (s: Span) => str(s.attrs["openinference.span.kind"]);

function isLlm(s: Span): boolean {
  const oi = openInferenceKind(s);
  if (oi) return oi === "LLM";
  if (AI_SDK_CALL_OPS.has(str(s.attrs["ai.operationId"]) ?? "")) return true;
  const op = str(s.attrs["gen_ai.operation.name"]);
  if (op && LLM_OPS.has(op)) return true;
  if (op === "execute_tool") return false;
  return num(s.attrs["gen_ai.usage.input_tokens"]) != null || num(s.attrs["gen_ai.usage.output_tokens"]) != null;
}

function isTool(s: Span): boolean {
  const oi = openInferenceKind(s);
  if (oi) return oi === "TOOL";
  return (
    str(s.attrs["gen_ai.operation.name"]) === "execute_tool" ||
    str(s.attrs["gen_ai.tool.name"]) != null ||
    str(s.attrs["ai.operationId"]) === "ai.toolCall"
  );
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
  let lostToLimit = 0;
  let failed = 0;
  const relabels = new Set<string>();

  const turns: Turn[] = llm.map((s, index) => {
    const a = s.attrs;
    const model =
      str(a["gen_ai.response.model"]) ?? str(a["gen_ai.request.model"]) ?? str(a["ai.model.id"]) ?? str(a["llm.model_name"]);
    const prov = resolveProvider({
      reported:
        str(a["gen_ai.provider.name"]) ??
        str(a["gen_ai.system"]) ??
        str(a["ai.model.provider"]) ??
        str(a["llm.provider"]) ??
        str(a["llm.system"]),
      model,
      host: str(a["server.address"]),
    });
    if (prov.source === "relabeled") {
      relabeled++;
      relabels.add(`${prov.reported} -> ${prov.provider}`);
    }

    const total = num(a["gen_ai.usage.input_tokens"]) ?? num(a["llm.token_count.prompt"]);
    const output = num(a["gen_ai.usage.output_tokens"]) ?? num(a["llm.token_count.completion"]);
    let tokens: ModelCall["tokens"] = null;
    // At the sender's attribute limit the oldest attributes go first, and
    // OpenInference writes the output count before the prompt's: a span can keep
    // one count and lose the other. Priced on what survived, the call would look
    // cheaper than it was, so it counts as lost unless both are there.
    const partial = s.dropped > 0 && (total == null || output == null);
    if ((total != null || output != null) && !partial) {
      const t = emptyTokens();
      const cacheRead =
        num(a["gen_ai.usage.cache_read.input_tokens"]) ??
        num(a["gen_ai.usage.cache_read_input_tokens"]) ??
        num(a["deepseek.prompt_cache_hit_tokens"]) ??
        num(a["ai.usage.inputTokenDetails.cacheReadTokens"]) ??
        num(a["llm.token_count.prompt_details.cache_read"]);
      const cacheWrite =
        num(a["gen_ai.usage.cache_creation.input_tokens"]) ??
        num(a["gen_ai.usage.cache_creation_input_tokens"]) ??
        num(a["ai.usage.inputTokenDetails.cacheWriteTokens"]) ??
        num(a["llm.token_count.prompt_details.cache_write"]);
      t.cacheKnown = cacheRead != null || cacheWrite != null;
      t.cacheRead = cacheRead;
      t.cacheWriteOther = cacheWrite;
      t.input = total == null ? null : Math.max(0, total - (cacheRead ?? 0) - (cacheWrite ?? 0));
      t.output = output;
      t.reasoning =
        num(a["gen_ai.usage.reasoning.output_tokens"]) ??
        num(a["ai.usage.outputTokenDetails.reasoningTokens"]) ??
        num(a["llm.token_count.completion_details.reasoning"]);
      if (!t.cacheKnown) cacheUnknown++;
      tokens = t;
    } else if (s.error && !partial) {
      failed++;
    } else if (s.dropped > 0) {
      lostToLimit++;
    } else {
      noUsage++;
    }

    const call: ModelCall = {
      id: str(a["gen_ai.response.id"]) ?? str(a["ai.response.id"]) ?? s.spanId,
      ts: nanoToIso(s.start),
      model,
      provider: prov.provider,
      providerSource: prov.source,
      reportedProvider: prov.source === "relabeled" ? prov.reported : undefined,
      tokens,
      failed: (s.error && !tokens) || undefined,
      promptKeys: promptKeysOf(a),
    };
    return { index, call, tools: [] };
  });

  // A prompt that shrinks means the context was replaced: a new conversation in
  // the same trace (a second agent call, a sub-agent, history dropped or
  // summarized). Results from before it are not in the model's context any more.
  const resets = markContextResets(turns);

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
  if (lostToLimit)
    notes.push(
      `${lostToLimit} model call(s) lost their usage to the sender's span attribute limit (not priced); ` +
        `raise it, e.g. OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT=10000`,
    );
  if (failed)
    notes.push(
      `${failed} model call(s) failed with an error status and have no usage in the trace (not priced; the provider may still bill them, e.g. a response cut off at its output limit)`,
    );
  if (aggregates) notes.push(`${aggregates} aggregate span(s) skipped to avoid double counting`);
  if (resets) notes.push(`${resets} context reset(s): the prompt shrank, so repeat and cache rules start over there`);
  if (orphanTools) notes.push(`${orphanTools} tool span(s) started before any model call`);

  const service = list.find((s) => s.service)?.service;
  return {
    id: `${basename(file)}#${traceId.slice(0, 12)}`,
    source: "otlp",
    dialect: list.some((s) => openInferenceKind(s))
      ? "openinference"
      : list.some((s) => str(s.attrs["ai.operationId"])?.startsWith("ai."))
        ? "ai-sdk"
        : "gen_ai",
    file,
    agent: service,
    labels: labelsOf(list),
    turns,
    notes,
  };
}

/** Attributes that may hold prompts, outputs or tool data; never kept as labels. */
const CONTENT_KEY = /messages|prompt|instructions|definitions|arguments|result|response|content|input|output|text/i;
const MAX_LABEL_LENGTH = 200;

/**
 * Labels of a run: short scalar attributes of its root spans (where callers put
 * what the run was: a task, a branch, an input id), the agent name and the
 * service name.
 */
function labelsOf(list: Span[]): Record<string, string> {
  const ids = new Set(list.map((s) => s.spanId));
  // No prototype, so an attribute named "constructor" or "__proto__" is an ordinary key.
  const labels: Record<string, string> = Object.create(null);
  const keep = (key: string, value: unknown) => {
    if (Object.hasOwn(labels, key) || CONTENT_KEY.test(key)) return;
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return;
    const v = String(value);
    if (v && v.length <= MAX_LABEL_LENGTH) labels[key] = v;
  };
  for (const s of list) {
    if (s.parentSpanId && ids.has(s.parentSpanId)) continue;
    for (const [key, value] of Object.entries(s.attrs)) keep(key, value);
  }
  // The AI SDK's ai.* spans name the agent by functionId; its semconv spans put the same value in gen_ai.agent.name.
  for (const s of list) keep("gen_ai.agent.name", s.attrs["gen_ai.agent.name"]);
  for (const s of list) keep("gen_ai.agent.name", s.attrs["ai.telemetry.functionId"]);
  // OpenInference names the agent on its AGENT spans.
  for (const s of list) if (openInferenceKind(s) === "AGENT") keep("gen_ai.agent.name", s.attrs["agent.name"]);
  const service = list.find((s) => s.service)?.service;
  if (service) keep("service.name", service);
  // A plain object again; spreading defines "__proto__" as an own key, it never sets the prototype.
  return { ...labels };
}

/** Whole prompt of a call: uncached input plus cache reads and writes. null when unknown. */
function promptTokens(t: ModelCall["tokens"]): number | null {
  if (!t || t.input == null) return null;
  return t.input + (t.cacheRead ?? 0) + (t.cacheWriteOther ?? 0) + (t.cacheWrite5m ?? 0) + (t.cacheWrite1h ?? 0);
}

/**
 * In one conversation the prompt only grows. A call whose prompt is under 80%
 * of the previous known prompt, and at least 1,024 tokens smaller, starts a new
 * context. Calls without usage are skipped over.
 */
function markContextResets(turns: Turn[]): number {
  let prev: number | null = null;
  let resets = 0;
  for (const t of turns) {
    const p = promptTokens(t.call.tokens);
    if (p == null) continue;
    if (prev != null && p < prev * 0.8 && prev - p >= 1024) {
      t.contextReplacedBefore = true;
      resets++;
    }
    prev = p;
  }
  return resets;
}

function toolFromSpan(s: Span): ToolCall {
  const a = s.attrs;
  const oi = openInferenceKind(s) === "TOOL";
  const name =
    str(a["gen_ai.tool.name"]) ?? str(a["ai.toolCall.name"]) ?? str(a["tool.name"]) ?? s.name.replace(/^execute_tool\s+/, "");
  // OpenInference's generic input.value / output.value are a tool's arguments and result only on TOOL spans.
  const rawArgs = a["gen_ai.tool.call.arguments"] ?? a["ai.toolCall.args"] ?? (oi ? a["input.value"] : undefined);
  let input: unknown = rawArgs;
  if (typeof rawArgs === "string") {
    try {
      input = JSON.parse(rawArgs);
    } catch {
      input = rawArgs;
    }
  }
  const { kind, target } = classifyTool(name, input);
  const result = a["gen_ai.tool.call.result"] ?? a["ai.toolCall.result"] ?? (oi ? a["output.value"] : undefined);
  return {
    id: str(a["gen_ai.tool.call.id"]) ?? str(a["ai.toolCall.id"]) ?? s.spanId,
    ts: nanoToIso(s.start),
    name,
    input,
    inputKey: input === undefined ? undefined : stableKey(input),
    kind,
    target,
    isError: s.attrs["error.type"] != null || s.error ? true : undefined,
    resultTokens:
      result === undefined ? undefined : estimateTokens(typeof result === "string" ? result : JSON.stringify(result)),
    resultKey: result === undefined ? undefined : contentKey(result),
    lineKeys: kind === "read" && typeof result === "string" ? lineKeys(decodedText(result)) : undefined,
  };
}

/**
 * Hashes of the prompt a call sent, from the semconv content attributes
 * (Vercel AI SDK 7 records them by default). undefined when the messages aren't
 * recorded or any attribute doesn't parse: a value cut off by an attribute
 * length limit must read as "not checked", never as "changed".
 */
function promptKeysOf(a: Record<string, unknown>): PromptKeys | undefined {
  const raw = str(a["gen_ai.input.messages"]);
  if (!raw) return undefined;
  const parse = (v: unknown): unknown => {
    if (v === undefined) return null; // not sent: no tools, or no system prompt
    if (typeof v !== "string") return undefined;
    try {
      return JSON.parse(v);
    } catch {
      return undefined;
    }
  };
  const messages = parse(raw);
  const tools = parse(a["gen_ai.tool.definitions"]);
  const system = parse(a["gen_ai.system_instructions"]);
  if (!Array.isArray(messages) || tools === undefined || system === undefined) return undefined;
  return {
    tools: contentKey(stableKey(tools)),
    system: contentKey(stableKey(system)),
    messages: messages.map((m) => contentKey(stableKey(m))),
    blocks: messages.map((m) => {
      const parts = (m as { parts?: unknown })?.parts;
      return Array.isArray(parts) ? parts.length : 1;
    }),
  };
}

/** The AI SDK records a string result JSON-encoded ("\"1\\tfoo\""); plain text otherwise. */
function decodedText(result: string): string {
  if (!result.startsWith('"')) return result;
  try {
    const v: unknown = JSON.parse(result);
    return typeof v === "string" ? v : result;
  } catch {
    return result;
  }
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
