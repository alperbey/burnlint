// Reads Claude Code session transcripts (~/.claude/projects/<project>/<session>.jsonl).
//
// Format notes, from real files:
// - One API response can be written as several "assistant" lines (one per
//   content block) sharing message.id and repeating the same usage. Usage is
//   counted once per message.id.
// - Imported or synthetic records can carry usage with all zeros/nulls. Those
//   are treated as "no usage", not as free calls.
// - Tool results arrive in later "user" lines as tool_result blocks keyed by
//   tool_use_id.
// - Sub-agent work is marked isSidechain and grouped into its own run.
// - Compaction writes a system line with subtype "compact_boundary", then a
//   user line with isCompactSummary. Neither is human input.

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { ModelCall, Run, ToolCall, Tokens, Turn } from "../model.js";
import { emptyTokens } from "../model.js";
import { resolveProvider } from "../pricing.js";
import { classifyTool, contentKey, estimateTokens, resultText, stableKey } from "../tools.js";

interface Line {
  type?: string;
  subtype?: string;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  sessionId?: string;
  cwd?: string;
  timestamp?: string;
  isSidechain?: boolean;
  agentId?: string;
  requestId?: string;
  /** A failed API call, written as a `<synthetic>` assistant message with zero usage. */
  isApiErrorMessage?: boolean;
  message?: {
    id?: string;
    model?: string;
    role?: string;
    content?: unknown;
    usage?: Record<string, unknown>;
  };
}

/**
 * Session bookkeeping records that can come before the first message. A
 * session can open with these and a single message line larger than the
 * sniffed head (v2.1.x: queue-operation lines, then a 70KB user line).
 */
const SESSION_RECORD_TYPES = new Set(["user", "assistant", "system", "summary", "attachment", "queue-operation", "last-prompt", "custom-title", "agent-name", "cost-state"]);

export function looksLikeClaudeCode(firstLines: string[]): boolean {
  return firstLines.some((l) => {
    try {
      const d = JSON.parse(l) as Line;
      return typeof d.sessionId === "string" && (SESSION_RECORD_TYPES.has(d.type ?? "") || "parentUuid" in d);
    } catch {
      return false;
    }
  });
}

export function readClaudeCode(file: string): Run[] {
  const lines = readFileSync(file, "utf8").split("\n");
  const groups = new Map<string, { agent?: string; records: Line[] }>();
  let bad = 0;
  let sessionId: string | undefined;
  let cwd: string | undefined;
  for (const raw of lines) {
    if (!raw.trim()) continue;
    let d: Line;
    try {
      d = JSON.parse(raw);
    } catch {
      bad++;
      continue;
    }
    sessionId ??= typeof d.sessionId === "string" ? d.sessionId : undefined;
    cwd ??= typeof d.cwd === "string" && d.cwd ? d.cwd : undefined;
    const compaction = d.type === "system" && d.subtype === "compact_boundary";
    if (d.type !== "assistant" && d.type !== "user" && !compaction) continue;
    const key = d.isSidechain ? `sidechain:${d.agentId ?? "agent"}` : "main";
    if (!groups.has(key)) groups.set(key, { agent: d.isSidechain ? d.agentId ?? "sub-agent" : undefined, records: [] });
    groups.get(key)!.records.push(d);
  }

  const session = basename(file, ".jsonl");
  const runs: Run[] = [];
  for (const [key, g] of groups) {
    const run = buildRun(g.records, file, key === "main" ? session : `${session}#${g.agent}`, g.agent);
    // A sub-agent's log carries its parent's session id.
    run.session = sessionId ?? session;
    if (cwd) run.project = basename(cwd.replace(/[\\/]+$/, "")) || cwd;
    if (bad) run.notes.push(`${bad} unparseable line(s) skipped`);
    if (run.turns.length) runs.push(run);
  }
  return runs;
}

function buildRun(records: Line[], file: string, id: string, agent?: string): Run {
  const turns: Turn[] = [];
  const byMessageId = new Map<string, Turn>();
  const toolsById = new Map<string, ToolCall>();
  let noUsage = 0;
  let failed = 0;
  let humanPending = false;
  let compactionPending = false;

  for (const d of records) {
    if ((d.type === "system" && d.subtype === "compact_boundary") || d.isCompactSummary) compactionPending = true;
    const msg = d.message;
    if (!msg) continue;

    if (d.type === "user" && isHumanMessage(d)) humanPending = true;

    if (d.type === "assistant") {
      const mid = msg.id ?? d.requestId ?? `line-${turns.length}`;
      let turn = byMessageId.get(mid);
      if (!turn) {
        const failedCall = d.isApiErrorMessage === true;
        const tokens = failedCall ? null : parseUsage(msg.usage);
        if (failedCall) failed++;
        else if (!tokens) noUsage++;
        const prov = resolveProvider({ model: msg.model });
        const call: ModelCall = {
          id: mid,
          ts: d.timestamp,
          model: msg.model,
          provider: prov.provider,
          providerSource: prov.source,
          tokens,
          failed: failedCall || undefined,
        };
        turn = {
          index: turns.length,
          humanInputBefore: humanPending || undefined,
          contextReplacedBefore: compactionPending || undefined,
          call,
          tools: [],
        };
        humanPending = false;
        compactionPending = false;
        turns.push(turn);
        byMessageId.set(mid, turn);
      }
      for (const block of asBlocks(msg.content)) {
        if (block.type !== "tool_use") continue;
        const name = String(block.name ?? "unknown");
        const input = block.input;
        const { kind, target } = classifyTool(name, input);
        const tool: ToolCall = {
          id: String(block.id ?? `${mid}:${turn.tools.length}`),
          ts: d.timestamp,
          name,
          input,
          inputKey: input === undefined ? undefined : stableKey(input),
          kind,
          target,
        };
        if (!toolsById.has(tool.id)) {
          turn.tools.push(tool);
          toolsById.set(tool.id, tool);
        }
      }
    } else if (d.type === "user") {
      for (const block of asBlocks(msg.content)) {
        if (block.type !== "tool_result") continue;
        const tool = toolsById.get(String(block.tool_use_id));
        if (!tool) continue;
        tool.isError = block.is_error === true;
        tool.resultTokens = estimateTokens(resultText(block.content));
        tool.resultKey = contentKey(block.content);
      }
    }
  }

  const notes: string[] = [];
  if (noUsage) notes.push(`${noUsage} of ${turns.length} model call(s) have no usage data (not priced)`);
  if (failed) notes.push(`${failed} of ${turns.length} model call(s) failed with an API error (not priced)`);
  return { id, source: "claude-code", file, agent, turns, notes };
}

/** A user line typed by a person: text content, no tool results, not injected meta or a compaction summary. */
function isHumanMessage(d: Line): boolean {
  if (d.isMeta || d.isCompactSummary) return false;
  const content = d.message?.content;
  if (typeof content === "string") return content.trim().length > 0;
  const blocks = asBlocks(content);
  if (blocks.some((b) => b.type === "tool_result")) return false;
  return blocks.some((b) => b.type === "text" || b.type === "image");
}

function asBlocks(content: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(content)) return [];
  return content.filter((b): b is Record<string, unknown> => !!b && typeof b === "object");
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Anthropic usage object -> Tokens. Returns null if it carries no usage at all. */
export function parseUsage(u: Record<string, unknown> | undefined): Tokens | null {
  if (!u) return null;
  const t = emptyTokens();
  t.input = num(u.input_tokens);
  t.output = num(u.output_tokens);
  t.cacheRead = num(u.cache_read_input_tokens);
  const created = num(u.cache_creation_input_tokens);
  const split = u.cache_creation as Record<string, unknown> | null | undefined;
  const w5 = num(split?.ephemeral_5m_input_tokens);
  const w1 = num(split?.ephemeral_1h_input_tokens);
  if (w5 != null || w1 != null) {
    t.cacheWrite5m = w5 ?? 0;
    t.cacheWrite1h = w1 ?? 0;
    const rest = (created ?? 0) - (w5 ?? 0) - (w1 ?? 0);
    t.cacheWriteOther = rest > 0 ? rest : 0;
  } else {
    t.cacheWriteOther = created;
  }
  const details = u.output_tokens_details as Record<string, unknown> | undefined;
  t.reasoning = num(details?.thinking_tokens) ?? num(details?.reasoning_tokens);
  t.cacheKnown = t.cacheRead != null || created != null;

  const total = (t.input ?? 0) + (t.output ?? 0) + (t.cacheRead ?? 0) + (created ?? 0);
  if (total === 0) return null;
  return t;
}
