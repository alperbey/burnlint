import type { Finding } from "../model.js";
import { carriedCost } from "../pricing.js";
import { severityFor, sumNullable, turnList, type Rule } from "./types.js";

/**
 * Same tool called again with identical input, with no write in between and
 * the earlier call not having failed. File reads with a known target are left
 * to reread-unchanged.
 */
export const duplicateToolCall: Rule = {
  id: "duplicate-tool-call",
  description: "Tool called again with identical input while nothing changed in between",
  check(run, ctx) {
    const seen = new Map<string, { turn: number; failed: boolean }>();
    const groups = new Map<string, { name: string; input: string; first: number; repeats: Array<{ turn: number; tokens?: number }> }>();

    for (const turn of run.turns) {
      if (turn.humanInputBefore) seen.clear();
      for (const tool of turn.tools) {
        if (tool.kind === "write") {
          seen.clear();
          continue;
        }
        if (tool.kind === "read" && tool.target) continue;
        if (tool.inputKey === undefined) continue;
        const key = `${tool.name}\u0000${tool.inputKey}`;
        const prev = seen.get(key);
        if (prev && !prev.failed) {
          let g = groups.get(key);
          if (!g) {
            g = { name: tool.name, input: tool.inputKey, first: prev.turn, repeats: [] };
            groups.set(key, g);
          }
          g.repeats.push({ turn: turn.index, tokens: tool.resultTokens });
        }
        seen.set(key, { turn: turn.index, failed: tool.isError === true });
      }
    }

    const findings: Finding[] = [];
    for (const g of groups.values()) {
      const tokens = sumNullable(g.repeats.map((r) => r.tokens));
      const cost = sumNullable(
        g.repeats.map((r) => (r.tokens == null ? null : carriedCost(run, r.turn, r.tokens, ctx.prices))),
      );
      const turns = [g.first, ...g.repeats.map((r) => r.turn)];
      findings.push({
        rule: this.id,
        severity: severityFor(cost, ctx.config),
        runId: run.id,
        file: run.file,
        turns,
        message: `${g.name} called ${turns.length}x with identical input ${truncate(g.input, 80)} (turns ${turnList(turns)})`,
        costUsd: cost,
        tokens,
      });
    }
    return findings;
  },
};

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
