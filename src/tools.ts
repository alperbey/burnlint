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

const READ_NAMES = /^(read|read_file|readfile|view|view_file|open_file|cat|get_file_contents|fetch|webfetch|read_many_files)$/i;
const WRITE_NAMES = /^(write|edit|multiedit|notebookedit|write_file|edit_file|create_file|str_replace|str_replace_editor|apply_patch|replace|delete_file|patch)$/i;

/** Strip MCP-style prefixes: mcp__server__tool -> tool. */
export function baseToolName(name: string): string {
  const parts = name.split("__");
  return parts[parts.length - 1] ?? name;
}

export function classifyTool(name: string, input: unknown): { kind: ToolKind; target?: string } {
  const base = baseToolName(name);
  const target = pathOf(input);
  if (READ_NAMES.test(base)) return { kind: "read", target };
  if (WRITE_NAMES.test(base)) return { kind: "write", target };
  return { kind: "other", target };
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
