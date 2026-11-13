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
// Used for fixtures/ai-sdk-v7-*.jsonl, from captures of bench/ai-sdk/agent.mjs.

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
        for (const a of s.attributes ?? []) {
          // A list of strings (AI SDK legacy `ai.prompt.tools`): dropped keys lose every item.
          const items = a.value?.arrayValue?.values;
          if (Array.isArray(items) && DROP_KEYS.has(a.key)) {
            a.value = { arrayValue: { values: items.map((x) => ({ stringValue: `[redacted ${String(x?.stringValue ?? "").length} chars]` })) } };
            continue;
          }
          const v = a.value?.stringValue;
          if (typeof v !== "string") continue;
          if (RESULT_KEYS.has(a.key)) a.value = { stringValue: redactResult(v) };
          else if (PROMPT_KEYS.has(a.key)) a.value = { stringValue: redactPrompt(v) };
          else if (DROP_KEYS.has(a.key)) a.value = { stringValue: `[redacted ${v.length} chars]` };
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
