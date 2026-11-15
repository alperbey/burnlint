// Turns traces from a `burnlint record` capture into a fixture that can be
// committed: picked traces only, message content removed, everything burnlint
// reads kept.
//
//   node scripts/redact-capture.mjs <capture.jsonl> <out.jsonl> <traceId>...
//
// Kept as captured: span names, ids, times, status, usage, models, providers,
// tool names and tool arguments (paths and search patterns over this repo).
// Tool results are replaced by filler of the same length, equal for equal
// results, so result sizes (token estimates) and repeat detection still work.
// File reads that list numbered lines ("N<TAB>text") keep the numbers and get
// one filler per line, so overlapping reads still compare line by line. The
// filler is keyed with a random secret per invocation: equal where the text
// was equal, but a guess at a short line (a lone brace, a common import)
// can't be checked against it.
// Prompts, system prompts and tool definitions keep their structure for the
// prefix check: each message keeps its role and the type of each part, each
// tool its name, and every part's content becomes keyed filler, equal where
// it was equal. Model output and provider metadata are replaced by a short
// "[redacted N chars]" marker: burnlint doesn't read them. The exception
// message on a failed span is kept.
//
// OpenInference spans (openinference.span.kind): prompts, model output and
// flattened messages, tool definitions and the request's instructions are
// redacted; a TOOL span keeps its arguments (input.value) and gets filler for
// its result (output.value).
//
// Used for fixtures/ai-sdk-v7-*.jsonl, from captures of bench/ai-sdk/agent.mjs,
// and fixtures/openai-agents-*.jsonl, from bench/openai-agents/agent.py.

import { createHmac, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const [src, out, ...ids] = process.argv.slice(2);
if (!src || !out || !ids.length) {
  console.error("usage: node scripts/redact-capture.mjs <capture.jsonl> <out.jsonl> <traceId>...");
  process.exit(2);
}
const keep = new Set(ids.map((s) => s.toLowerCase()));

// Same length, same filler for the same content.
const RESULT_KEYS = new Set(["gen_ai.tool.call.result", "ai.toolCall.result"]);
const PROMPT_KEYS = new Set(["gen_ai.input.messages", "gen_ai.system_instructions", "gen_ai.tool.definitions"]);
const DROP_KEYS = new Set([
  "gen_ai.output.messages",
  "ai.prompt",
  "ai.prompt.messages",
  "ai.prompt.tools",
  "ai.response.text",
  "ai.response.toolCalls",
  "ai.response.providerMetadata",
]);

// OpenInference: generic keys whose meaning depends on the span kind, and
// flattened message attributes (llm.input_messages.0.message.content, ...).
const OI_DROP_PREFIXES = ["llm.input_messages.", "llm.output_messages.", "llm.tools."];

/** "result" | "prompt" | "drop" | undefined (keep) for one attribute of a span. */
function treatment(key, oiKind) {
  if (RESULT_KEYS.has(key)) return "result";
  if (PROMPT_KEYS.has(key)) return "prompt";
  if (DROP_KEYS.has(key)) return "drop";
  if (!oiKind) return undefined;
  // On a TOOL span, input.value is the tool's arguments (kept, like gen_ai tool
  // arguments) and output.value its result. On any other span they are the
  // prompt and the model's output.
  if (key === "output.value") return oiKind === "TOOL" ? "result" : "drop";
  if (key === "input.value") return oiKind === "TOOL" ? undefined : "drop";
  // The request's parameters, including `instructions` (the system prompt).
  if (key === "llm.invocation_parameters") return "params";
  // The tool's definition (docstring, JSON schema), like gen_ai.tool.definitions.
  if (key === "tool.description" || key === "tool.parameters") return "drop";
  if (OI_DROP_PREFIXES.some((p) => key.startsWith(p))) return "drop";
  return undefined;
}

const SECRET = randomBytes(32);

function filler(text, length = text.length) {
  const seed = createHmac("sha256", SECRET).update(text).digest("hex");
  let s = "";
  while (s.length < length) s += seed;
  return s.slice(0, length);
}

// A JSON list of messages (role + parts), system parts or tool definitions.
// Anything else, or a value that doesn't parse, is dropped like other content.
function redactPrompt(v) {
  let list;
  try {
    list = JSON.parse(v);
  } catch {}
  if (!Array.isArray(list)) return `[redacted ${v.length} chars]`;
  const part = (p) => ({ type: p?.type, k: filler(JSON.stringify(p), 16) });
  return JSON.stringify(
    list.map((item) =>
      Array.isArray(item?.parts) ? { role: item.role, parts: item.parts.map(part) } : { ...part(item), name: item?.name },
    ),
  );
}

// The AI SDK records a string result JSON-encoded. Each line's filler takes the
// line's encoded length, so the attribute keeps its length exactly.
function redactResult(v) {
  let text = v;
  let encoded = false;
  if (v.startsWith('"')) {
    try {
      const d = JSON.parse(v);
      if (typeof d === "string") [text, encoded] = [d, true];
    } catch {}
  }
  if (!/^\s*\d+\t/.test(text)) return filler(v);
  const len = (t) => (encoded ? JSON.stringify(t).length - 2 : t.length);
  const out = text
    .split("\n")
    .map((line) => {
      const m = /^(\s*\d+\t)(.*)$/.exec(line);
      return m ? m[1] + filler(m[2], len(m[2])) : filler(line, len(line));
    })
    .join("\n");
  return encoded ? JSON.stringify(out) : out;
}

// Request parameters: only settings that shape cost are kept (an allowlist).
// The rest (instructions, response ids, cache keys, billing, metadata) is
// dropped with its key. Anything that doesn't parse is dropped whole.
const PARAM_KEEP = new Set([
  "model",
  "reasoning",
  "max_output_tokens",
  "max_tokens",
  "temperature",
  "top_p",
  "tool_choice",
  "parallel_tool_calls",
  "truncation",
  "service_tier",
  "prompt_cache_retention",
]);
function redactParams(v) {
  let p;
  try {
    p = JSON.parse(v);
  } catch {}
  if (!p || typeof p !== "object" || Array.isArray(p)) return `[redacted ${v.length} chars]`;
  return JSON.stringify(Object.fromEntries(Object.entries(p).filter(([k]) => PARAM_KEEP.has(k))));
}

let spans = 0;
const lines = [];
for (const line of readFileSync(src, "utf8").split("\n")) {
  if (!line.trim()) continue;
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    continue;
  }
  for (const rs of req.resourceSpans ?? []) {
    for (const ss of rs.scopeSpans ?? []) {
      ss.spans = (ss.spans ?? []).filter((s) => keep.has(String(s.traceId).toLowerCase()));
      for (const s of ss.spans) {
        spans++;
        const oiKind = s.attributes?.find((a) => a.key === "openinference.span.kind")?.value?.stringValue;
        for (const a of s.attributes ?? []) {
          // A list of strings (AI SDK legacy `ai.prompt.tools`): dropped keys lose every item.
          const items = a.value?.arrayValue?.values;
          if (Array.isArray(items) && treatment(a.key, oiKind) === "drop") {
            a.value = { arrayValue: { values: items.map((x) => ({ stringValue: `[redacted ${String(x?.stringValue ?? "").length} chars]` })) } };
            continue;
          }
          const v = a.value?.stringValue;
          if (typeof v !== "string") continue;
          const t = treatment(a.key, oiKind);
          if (t === "result") a.value = { stringValue: redactResult(v) };
          else if (t === "prompt") a.value = { stringValue: redactPrompt(v) };
          else if (t === "drop") a.value = { stringValue: `[redacted ${v.length} chars]` };
          else if (t === "params") a.value = { stringValue: redactParams(v) };
        }
        // Span events can carry exception stacks with local paths: keep only their names.
        if (s.events) s.events = s.events.map((e) => ({ timeUnixNano: e.timeUnixNano, name: e.name, attributes: [] }));
      }
    }
    rs.scopeSpans = (rs.scopeSpans ?? []).filter((ss) => ss.spans.length);
  }
  req.resourceSpans = (req.resourceSpans ?? []).filter((rs) => rs.scopeSpans.length);
  if (req.resourceSpans.length) lines.push(JSON.stringify(req));
}
writeFileSync(out, lines.join("\n") + "\n");
console.log(`${spans} span(s) from ${keep.size} trace(s) written to ${out}`);
