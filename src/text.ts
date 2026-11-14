// Strings from a trace (tool paths, agent, model and label names) are written
// by whoever produced the trace, often a model. Before they reach a terminal or
// a Markdown comment they are made inert. Rules and grouping keep the raw
// strings; only what is printed is cleaned.

/**
 * C0 and C1 control characters (ESC starts terminal escape sequences), DEL,
 * and the bidirectional marks and overrides that reorder what a terminal or
 * an editor shows.
 */
const CONTROL = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;

/** Tabs and line breaks become spaces; other control characters are dropped. */
export function plainText(s: string): string {
  return s.replace(CONTROL, (ch) => (ch === "\t" || ch === "\n" || ch === "\r" ? " " : ""));
}

/** A copy of `x` with `plainText` applied to every string in it, keys included. */
export function plainDeep<T>(x: T): T {
  if (typeof x === "string") return plainText(x) as T;
  if (Array.isArray(x)) return x.map(plainDeep) as T;
  if (x && typeof x === "object") {
    const out: Record<string, unknown> = Object.create(null);
    for (const [k, v] of Object.entries(x)) out[plainText(k)] = plainDeep(v);
    return out as T;
  }
  return x;
}

/**
 * Text for a Markdown table cell or list item: inert in GitHub Markdown. No
 * HTML, links, images, emphasis, code spans or entities, no cell breaks, and
 * no @mentions (a zero-width space after `@` keeps GitHub from linking it).
 */
export function escapeMd(s: string): string {
  return plainText(s)
    .replace(/[\\`*_[\]<>#!~&|]/g, "\\$&")
    .replace(/@/g, "@​");
}
