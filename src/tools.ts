import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { ToolKind } from "./model.js";

/** JSON.stringify with sorted keys, so equal inputs produce equal strings. */
export function stableKey(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.keys(v as object)
        .sort()
        .map((k) => [k, sortDeep((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}

const PATH_KEYS = ["file_path", "filePath", "path", "filename", "file", "notebook_path", "uri", "url"];

const READ_NAMES = /^(read|read_file|readfile|view|view_file|open_file|cat|get_file_contents|read_many_files)$/i;
const SHELL_NAMES = /^(bash|shell|sh|exec|run_command|run_terminal_cmd|execute_command|device_bash|terminal)$/i;
const WRITE_NAMES = /^(write|edit|multiedit|notebookedit|write_file|edit_file|create_file|str_replace|str_replace_editor|apply_patch|replace|delete_file|patch)$/i;

/** Strip MCP-style prefixes: mcp__server__tool -> tool. */
export function baseToolName(name: string): string {
  const parts = name.split("__");
  return parts[parts.length - 1] ?? name;
}

export function classifyTool(name: string, input: unknown): { kind: ToolKind; target?: string } {
  const base = baseToolName(name);
  if (SHELL_NAMES.test(base)) return { kind: "shell" };
  const raw = pathOf(input);
  // A remote resource is not a file: the trace can't show whether it changed.
  const remote = raw !== undefined && /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) && !/^file:\/\//i.test(raw);
  const target = raw === undefined || remote ? raw : normalizePath(raw);
  if (READ_NAMES.test(base) && !remote) return { kind: "read", target };
  if (WRITE_NAMES.test(base)) return { kind: "write", target };
  return { kind: "other", target };
}

/** One spelling per path: forward slashes, no "./", no "a/../", no trailing slash, no file:// scheme. */
export function normalizePath(p: string): string {
  const n = posix.normalize(p.replace(/^file:\/\//i, "").replace(/\\/g, "/"));
  return n.length > 1 ? n.replace(/\/$/, "") : n;
}

const isAbsolute = (p: string) => p.startsWith("/") || /^[a-z]:\//i.test(p);

/**
 * True when two normalized targets may name the same file. The working
 * directory is not in the trace, so a relative path is taken to match any
 * absolute path that ends with it.
 */
export function mayBeSameFile(a: string, b: string): boolean {
  if (a === b) return true;
  if (isAbsolute(a) === isAbsolute(b)) return false;
  const [abs, rel] = isAbsolute(a) ? [a, b] : [b, a];
  return abs.endsWith("/" + rel.replace(/^(\.\.\/)+/, ""));
}

const VOLATILE_WORDS = new Set(["status", "poll", "polling", "wait", "sleep", "health", "healthcheck", "ping", "progress"]);

/**
 * Tools whose name says they observe something that changes on its own
 * (get_job_status, wait_for, ping). Calling one again with the same input is
 * how polling works, not a repeat.
 */
export function isVolatileTool(name: string): boolean {
  const words = baseToolName(name)
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/);
  return words.some((w) => VOLATILE_WORDS.has(w));
}

/** Short hash of a tool result, so results can be compared without keeping them. */
export function contentKey(content: unknown): string {
  const text = typeof content === "string" ? content : stableKey(content ?? null);
  return createHash("sha1").update(text).digest("hex").slice(0, 16);
}

function pathOf(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const rec = input as Record<string, unknown>;
  for (const k of PATH_KEYS) {
    const v = rec[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

/** Rough token estimate for text: 4 characters per token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Flattens a tool result payload (string, content blocks, objects) to text. */
export function resultText(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(resultText).join("\n");
  if (typeof content === "object") {
    const rec = content as Record<string, unknown>;
    if (typeof rec.text === "string") return rec.text;
    if (rec.type === "image") return "x".repeat(6000); // ~1.5k tokens, rough image cost
    return JSON.stringify(content);
  }
  return String(content);
}
