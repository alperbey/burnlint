import type { Finding } from "../model.js";
import { carriedCost } from "../pricing.js";
import { mayBeSameFile } from "../tools.js";
import { severityFor, sumNullable, turnList, type Rule } from "./types.js";

/**
 * A file (same path, same range) read again with no write to it in between.
 * The second copy of the content sits in context for the rest of the run.
 *
 * Stays silent when the file may have changed: after a write to a path that
 * could be the same file, after any shell command or write without a target,
 * after a human message or compaction, and when the two reads returned
 * different content.
 */
export const rereadUnchanged: Rule = {
  id: "reread-unchanged",
  description: "File read again with no change to it in between",
  check(run, ctx) {
    const lastRead = new Map<string, { turn: number; target: string; resultKey?: string }>();
    const groups = new Map<string, { target: string; turns: number[]; repeats: Array<{ turn: number; tokens?: number }> }>();

    for (const turn of run.turns) {
      if (turn.humanInputBefore || turn.contextReplacedBefore) lastRead.clear();
      for (const tool of turn.tools) {
        if (tool.kind === "write") {
          if (tool.target) {
            for (const [k, v] of lastRead) if (mayBeSameFile(v.target, tool.target)) lastRead.delete(k);
          } else {
            lastRead.clear();
          }
          continue;
        }
        if (tool.kind === "shell") {
          lastRead.clear();
          continue;
        }
        if (tool.kind !== "read" || !tool.target || tool.isError) continue;
        const key = `${tool.target}\u0000${tool.inputKey ?? ""}`;
        const prev = lastRead.get(key);
        // Different content means something outside the trace changed the file.
        const changed = prev?.resultKey !== undefined && tool.resultKey !== undefined && prev.resultKey !== tool.resultKey;
        if (prev && !changed) {
          let g = groups.get(key);
          if (!g) {
            g = { target: tool.target, turns: [prev.turn], repeats: [] };
            groups.set(key, g);
          }
          g.turns.push(turn.index);
          g.repeats.push({ turn: turn.index, tokens: tool.resultTokens });
        }
        lastRead.set(key, { turn: turn.index, target: tool.target, resultKey: tool.resultKey });
      }
    }

    const findings: Finding[] = [];
    for (const g of groups.values()) {
      const tokens = sumNullable(g.repeats.map((r) => r.tokens));
      const cost = sumNullable(
        g.repeats.map((r) => (r.tokens == null ? null : carriedCost(run, r.turn, r.tokens, ctx.prices))),
      );
      findings.push({
        rule: this.id,
        severity: severityFor(cost, ctx.config),
        runId: run.id,
        file: run.file,
        turns: g.turns,
        message: `${g.target} read ${g.turns.length}x with no change in between (turns ${turnList(g.turns)})`,
        costUsd: cost,
        tokens,
      });
    }
    return findings;
  },
};
