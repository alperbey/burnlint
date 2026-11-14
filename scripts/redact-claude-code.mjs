// Turns a Claude Code session log into a fixture that can be committed:
// everything burnlint reads is kept, everything else is dropped.
//
//   node scripts/redact-claude-code.mjs <session.jsonl> <out.jsonl>
//
// An allowlist: only user and assistant records and compaction boundaries
// are kept, and only the fields the reader uses (ids, session, sidechain and
// meta flags, timestamps, model, message id, usage, content block types).
// The home folder in paths is replaced by /home/user, and the user name by
// "user" wherever else it appears in a path or URL.
// - Text is emptied and thinking blocks dropped: burnlint takes output size
//   from usage, never from text.
// - Tool calls keep their name and input keys. Path inputs are kept (the
//   reread rule needs them), URLs only up to the host; every other string input becomes keyed filler of
//   the same length, equal where it was equal; numbers and booleans are kept.
// - Tool results become filler of the same length, equal for equal results.
//   Numbered file lines ("N<TAB>text") keep their numbers and get one filler
//   per line. Images keep only their type.
// The filler is keyed with a random secret per invocation, so a guess at a
// short line can't be checked against it.
//
// Used for fixtures/claude-code-session.jsonl.

import { createHmac, randomBytes } from "node:crypto";
import { homedir, userInfo } from "node:os";
import { readFileSync, writeFileSync } from "node:fs";

const [src, out] = process.argv.slice(2);
if (!src || !out) {
  console.error("usage: node scripts/redact-claude-code.mjs <session.jsonl> <out.jsonl>");
  process.exit(2);
}

const SECRET = randomBytes(32);
const HOME = homedir();

function filler(text, length = text.length) {
  const seed = createHmac("sha256", SECRET).update(text).digest("hex");
  let s = "";
  while (s.length < length) s += seed;
  return s.slice(0, length);
}

// Also inside URLs, where the home folder may be percent-encoded.
const USER = userInfo().username;
const path = (p) => (typeof p === "string" ? p.split(HOME).join("/home/user").split(USER).join("user") : p);
// The keys src/tools.ts reads a target from, plus cwd.
const PATH_KEYS = new Set(["file_path", "filePath", "path", "filename", "file", "notebook_path", "uri", "url", "cwd"]);

// A remote resource is never a file to burnlint: keep where it is, not what.
function url(v) {
  const m = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)(.*)$/i.exec(v);
  return m ? m[1] + filler(m[2]) : filler(v);
}

function redactInput(v, key) {
  if (typeof v === "string") return PATH_KEYS.has(key) ? (/^[a-z][a-z0-9+.-]*:\/\/(?!\/)/i.test(v) && !/^file:/i.test(v) ? url(v) : path(v)) : filler(v);
  if (Array.isArray(v)) return v.map((x) => redactInput(x));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactInput(x, k)]));
  return v;
}

function redactText(text) {
  if (!/^\s*\d+\t/.test(text)) return filler(text);
  return text
    .split("\n")
    .map((line) => {
      const m = /^(\s*\d+\t)(.*)$/.exec(line);
      return m ? m[1] + filler(m[2]) : filler(line);
    })
    .join("\n");
}

function redactResult(content) {
  if (typeof content === "string") return redactText(content);
  if (!Array.isArray(content)) return content == null ? content : filler(JSON.stringify(content));
  return content.map((b) =>
    b?.type === "text" ? { type: "text", text: redactText(String(b.text ?? "")) } : b?.type === "image" ? { type: "image" } : { type: b?.type },
  );
}

function redactBlock(b) {
  switch (b?.type) {
    case "text":
      return { type: "text", text: "" };
    case "image":
      return { type: "image" };
    case "tool_use":
      return { type: "tool_use", id: b.id, name: b.name, input: redactInput(b.input) };
    case "tool_result":
      return { type: "tool_result", tool_use_id: b.tool_use_id, ...(b.is_error ? { is_error: true } : {}), content: redactResult(b.content) };
    default:
      return null; // thinking, redacted_thinking, server tool blocks: not read
  }
}

const RECORD_KEYS = [
  "type", "subtype", "uuid", "parentUuid", "sessionId", "isSidechain", "agentId", "isMeta",
  "isCompactSummary", "isApiErrorMessage", "timestamp", "requestId", "cwd",
];

let kept = 0;
const lines = [];
for (const line of readFileSync(src, "utf8").split("\n")) {
  if (!line.trim()) continue;
  const d = JSON.parse(line);
  const compaction = d.type === "system" && d.subtype === "compact_boundary";
  if (d.type !== "user" && d.type !== "assistant" && !compaction) continue;
  const r = {};
  for (const k of RECORD_KEYS) if (d[k] !== undefined) r[k] = k === "cwd" ? path(d[k]) : d[k];
  const m = d.message;
  if (m) {
    const content = typeof m.content === "string" ? [{ type: "text", text: "" }] : (m.content ?? []).map(redactBlock).filter(Boolean);
    r.message = { role: m.role, ...(m.id ? { id: m.id } : {}), ...(m.model ? { model: m.model } : {}), content, ...(m.usage ? { usage: m.usage } : {}) };
  }
  lines.push(JSON.stringify(r));
  kept++;
}
writeFileSync(out, lines.join("\n") + "\n");
console.error(`${kept} records -> ${out}`);
