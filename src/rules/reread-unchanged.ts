import type { Finding, ToolCall } from "../model.js";
import { callCost, carriedCost } from "../pricing.js";
import { mayBeSameFile } from "../tools.js";
import { severityFor, sumNullable, turnList, type Rule } from "./types.js";

/** A partial overlap shorter than this is a range boundary, not a reread. */
const MIN_OVERLAP_LINES = 10;

/**
 * File content read again with no write to it in between. The second copy
 * sits in context for the rest of the run.
 *
 * When reads return numbered lines (`lineKeys`), any overlap counts: a range
 * inside an earlier one, a whole file after a range, or a partial overlap of
 * at least MIN_OVERLAP_LINES. Only the repeated lines count, and only when
 * every one of them came back as before. Other reads must repeat exactly:
 * same path, same input, and both results known and equal.
 *
 * A call that made only rereads isn't counted: it may still have returned
 * new lines, and moving code to the end of the context can help. Its cost is
 * shown in the details as context.
 *
 * Stays silent when the file may have changed: after a write to a path that
 * could be the same file, after any shell command or write without a target,
 * after a human message or compaction, when a repeated line (or, for other
 * reads, the result) came back different, and when a result is unknown.
 */
export const rereadUnchanged: Rule = {
  id: "reread-unchanged",
  description: "File read again with no change to it in between",
  check(run, ctx) {
    // Exact-match reads, by path and input.
    const lastRead = new Map<string, { turn: number; target: string; resultKey?: string }>();
    // Numbered lines seen per path: content key and the turn that read it.
    const seen = new Map<string, Map<number, { key: string; turn: number }>>();
    const groups = new Map<string, Group>();
    // Reads flagged as repeats, per turn: a turn whose every tool call is one made only rereads.
    const repeatsInTurn = new Map<number, number>();
    const flag = (turn: number) => repeatsInTurn.set(turn, (repeatsInTurn.get(turn) ?? 0) + 1);
    const group = (key: string, target: string) => {
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { target, byLine: false, turns: new Set(), repeats: [] }));
      return g;
    };
    // A write without a target (or a reset) forgets everything.
    const forget = (target?: string) => {
      for (const [k, v] of lastRead) if (target === undefined || mayBeSameFile(v.target, target)) lastRead.delete(k);
      for (const k of seen.keys()) if (target === undefined || mayBeSameFile(k, target)) seen.delete(k);
    };

    for (const turn of run.turns) {
      if (turn.humanInputBefore || turn.contextReplacedBefore) forget();
      for (const tool of turn.tools) {
        if (tool.kind === "write") {
          forget(tool.target);
          continue;
        }
        if (tool.kind === "shell") {
          forget();
          continue;
        }
        if (tool.kind !== "read" || !tool.target || tool.isError) continue;

        if (tool.lineKeys) {
          const lines = seen.get(tool.target);
          const overlap = lines ? compareLines(tool.lineKeys, lines) : null;
          if (!lines || !overlap || overlap.changed) {
            // First read, or something outside the trace changed the file: start over from this read.
            seen.set(tool.target, new Map([...tool.lineKeys].map(([n, key]) => [n, { key, turn: turn.index }])));
            continue;
          }
          const all = overlap.repeated.length === tool.lineKeys.size;
          if (overlap.repeated.length && (all || overlap.repeated.length >= MIN_OVERLAP_LINES)) {
            const g = group(`line\u0000${tool.target}`, tool.target);
            g.byLine = true;
            for (const t of overlap.sources) g.turns.add(t);
            g.turns.add(turn.index);
            g.repeats.push({
              turn: turn.index,
              lines: overlap.repeated,
              of: tool.lineKeys.size,
              tokens: tool.resultTokens == null ? undefined : Math.round((tool.resultTokens * overlap.repeated.length) / tool.lineKeys.size),
            });
            flag(turn.index);
          }
          for (const [n, key] of tool.lineKeys) lines.set(n, { key, turn: turn.index });
          continue;
        }

        const key = `${tool.target}\u0000${tool.inputKey ?? ""}`;
        const prev = lastRead.get(key);
        // Different content means something outside the trace changed the file; unknown content can't show it didn't.
        const same = prev?.resultKey !== undefined && prev.resultKey === tool.resultKey;
        if (prev && same) {
          const g = group(key, tool.target);
          g.turns.add(prev.turn).add(turn.index);
          g.repeats.push({ turn: turn.index, tokens: tool.resultTokens });
          flag(turn.index);
        }
        lastRead.set(key, { turn: turn.index, target: tool.target, resultKey: tool.resultKey });
      }
    }

    const onlyRereads = (turn: number) => {
      const n = run.turns[turn]!.tools.length;
      if (repeatsInTurn.get(turn) !== n) return "";
      const cost = callCost(run.turns[turn]!.call, ctx.prices);
      return `; the call made only rereads (${n})${cost == null ? "" : ` and cost $${cost.toFixed(4)}, not counted`}`;
    };
    const findings: Finding[] = [];
    for (const g of groups.values()) {
      const turns = [...g.turns].sort((a, b) => a - b);
      const tokens = sumNullable(g.repeats.map((r) => r.tokens));
      const cost = sumNullable(
        g.repeats.map((r) => (r.tokens == null ? null : carriedCost(run, r.turn, r.tokens, ctx.prices))),
      );
      const lines = g.repeats.reduce((s, r) => s + (r.lines?.length ?? 0), 0);
      findings.push({
        rule: this.id,
        severity: severityFor("no-loss", cost, ctx.config),
        runId: run.id,
        file: run.file,
        turns,
        message: g.byLine
          ? `${g.target}: ${lines} line${lines === 1 ? "" : "s"} read again with no change in between (turns ${turnList(turns)})`
          : `${g.target} read ${turns.length}x with no change in between (turns ${turnList(turns)})`,
        details: g.repeats.map((r) =>
          g.byLine
            ? `turn ${r.turn + 1}: ${spans(r.lines!)} again, ${r.lines!.length} of ${r.of} lines returned${onlyRereads(r.turn)}`
            : `turn ${r.turn + 1}: same content again${onlyRereads(r.turn)}`,
        ),
        costUsd: cost,
        tokens,
        // The repeated lines hadn't changed, so the second copy added nothing.
        fix: "no-loss",
        avoidableUsd: cost,
      });
    }
    return findings;
  },
};

interface Group {
  target: string;
  byLine: boolean;
  turns: Set<number>;
  repeats: Array<{ turn: number; tokens?: number; lines?: number[]; of?: number }>;
}

/** Lines of `read` already in `seen` with the same content, the turns that read them, and whether any differ. */
function compareLines(read: NonNullable<ToolCall["lineKeys"]>, seen: Map<number, { key: string; turn: number }>) {
  const repeated: number[] = [];
  const sources = new Set<number>();
  for (const [n, key] of read) {
    const s = seen.get(n);
    if (!s) continue;
    if (s.key !== key) return { repeated, sources, changed: true };
    repeated.push(n);
    sources.add(s.turn);
  }
  return { repeated, sources, changed: false };
}

/** Line numbers as ranges: 1–40, 52, 60–98. */
function spans(lines: number[]): string {
  const out: string[] = [];
  for (let i = 0; i < lines.length; ) {
    let j = i;
    while (j + 1 < lines.length && lines[j + 1] === lines[j]! + 1) j++;
    out.push(i === j ? `line ${lines[i]}` : `lines ${lines[i]}–${lines[j]}`);
    i = j + 1;
  }
  return out.join(", ");
}
