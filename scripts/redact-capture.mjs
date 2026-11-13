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
// Prompts, system prompts, tool definitions, model output and provider
// metadata are replaced by a short "[redacted N chars]" marker: burnlint
// doesn't read them. The exception message on a failed span is kept.
//
// Used for fixtures/ai-sdk-v7-*.jsonl, from captures of bench/ai-sdk/agent.mjs.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const [src, out, ...ids] = process.argv.slice(2);
if (!src || !out || !ids.length) {
  console.error("usage: node scripts/redact-capture.mjs <capture.jsonl> <out.jsonl> <traceId>...");
  process.exit(2);
}
const keep = new Set(ids.map((s) => s.toLowerCase()));

// Same length, same filler for the same content.
const RESULT_KEYS = new Set(["gen_ai.tool.call.result", "ai.toolCall.result"]);
const DROP_KEYS = new Set([
  "gen_ai.input.messages",
  "gen_ai.output.messages",
  "gen_ai.system_instructions",
  "gen_ai.tool.definitions",
  "ai.prompt",
  "ai.prompt.messages",
  "ai.prompt.tools",
  "ai.response.text",
  "ai.response.toolCalls",
  "ai.response.providerMetadata",
]);

function filler(text) {
  const seed = createHash("sha256").update(text).digest("hex");
  let s = "";
  while (s.length < text.length) s += seed;
  return s.slice(0, text.length);
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
          const v = a.value?.stringValue;
          if (typeof v !== "string") continue;
          if (RESULT_KEYS.has(a.key)) a.value = { stringValue: filler(v) };
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
