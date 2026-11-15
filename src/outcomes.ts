import { readFileSync } from "node:fs";
import { hexId } from "./adapters/otlp.js";

/**
 * Pass/fail per run, supplied by the user (tests, an eval harness, CI).
 * burnlint never judges output itself; it joins these to cost.
 *
 * JSONL, one object per line: {"run": "<id>", "pass": true|false}. The id is
 * an OTLP trace id (hex, or base64 as some exporters write it) or a Claude
 * Code session id. Other keys are ignored and never printed: an eval harness
 * may add scores or notes, and notes may hold model output.
 */
export interface Outcomes {
  file: string;
  /** Normalized run id -> passed. */
  rows: Map<string, boolean>;
}

/** A bad outcomes file: refused, with the line number. Never carries values. */
export class OutcomesError extends Error {}

/** Keys that look like a misspelled "pass". Named in the error when "pass" is missing. */
const NEAR_PASS = ["Pass", "PASS", "passed", "Passed", "passes", "passing", "success", "succeeded", "ok", "outcome", "result"];

/**
 * One form per id: hex trace ids and UUIDs (Claude Code sessions) in lowercase,
 * base64 trace ids as hex. Anything else is matched exactly.
 */
export function normalizeRunId(id: string): string {
  const s = id.trim();
  if (/^[0-9a-f]{32}$/i.test(s)) return s.toLowerCase();
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return s.toLowerCase();
  // 16 bytes in base64: 22 characters and "==".
  if (/^[A-Za-z0-9+/]{22}==$/.test(s)) return hexId(s);
  return s;
}

export function readOutcomes(file: string): Outcomes {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    throw new OutcomesError(`--outcomes ${file}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
  }
  const bad = (line: number, why: string) => new OutcomesError(`--outcomes ${file}, line ${line}: ${why}`);
  const rows = new Map<string, boolean>();
  const lineOf = new Map<string, number>();
  text.split("\n").forEach((raw, i) => {
    const n = i + 1;
    if (!raw.trim()) return;
    let row: unknown;
    try {
      row = JSON.parse(raw);
    } catch {
      throw bad(n, `not JSON (expected {"run": "<trace or session id>", "pass": true})`);
    }
    if (typeof row !== "object" || row === null || Array.isArray(row)) throw bad(n, `expected an object with "run" and "pass"`);
    const o = row as Record<string, unknown>;
    if (typeof o.run !== "string" || !o.run.trim()) throw bad(n, `"run" must be a run id: an OTLP trace id or a Claude Code session id`);
    if (!Object.hasOwn(o, "pass")) {
      const near = NEAR_PASS.find((k) => Object.hasOwn(o, k));
      throw bad(n, `no "pass"${near ? ` (found "${near}"; the key must be "pass")` : ""}`);
    }
    if (typeof o.pass !== "boolean") throw bad(n, `"pass" must be true or false`);
    const id = normalizeRunId(o.run);
    const seen = rows.get(id);
    if (seen !== undefined && seen !== o.pass) throw bad(n, `this run is listed as both pass and fail (also on line ${lineOf.get(id)})`);
    rows.set(id, o.pass);
    if (!lineOf.has(id)) lineOf.set(id, n);
  });
  if (!rows.size) throw new OutcomesError(`--outcomes ${file}: no outcomes in the file`);
  return { file, rows };
}

/** The id an outcomes file names a run's unit of work by: its trace id, else its Claude Code session. */
export function outcomeId(r: { traceId?: string; session?: string; id: string }): string {
  return normalizeRunId(r.traceId ?? r.session ?? r.id);
}
