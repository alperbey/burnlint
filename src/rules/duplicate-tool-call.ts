import type { Finding } from "../model.js";
import { carriedCost } from "../pricing.js";
import { isVolatileTool } from "../tools.js";
import { severityFor, sumNullable, turnList, type Rule } from "./types.js";

/**
 * Same tool called again with identical input and an identical result, with
 * nothing written in between and the earlier call not having failed. File
 * reads with a known target are left to reread-unchanged.
 *
 * Stays silent when it can't tell that the call was redundant:
 * - shell commands are never reported, and reset everything before them
 * - both results must be known and equal (a different result means the call
 *   learned something)
 * - tools that poll by name (status, wait, ...) are never reported
 *
 * The message does not include the input: it can be a query or a command.
 */
export const duplicateToolCall: Rule = {
  id: "duplicate-tool-call",
  description: "Tool called again with identical input and result while nothing changed in between",
  check(run, ctx) {
    const seen = new Map<string, { turn: number; failed: boolean; resultKey?: string }>();
    const groups = new Map<string, { name: string; first: number; repeats: Array<{ turn: number; tokens?: number }> }>();

    for (const turn of run.turns) {
      if (turn.humanInputBefore || turn.contextReplacedBefore) seen.clear();
      for (const tool of turn.tools) {
        if (tool.kind === "write" || tool.kind === "shell") {
          seen.clear();
          continue;
        }
        if (tool.kind === "read" && tool.target) continue;
        if (tool.inputKey === undefined || isVolatileTool(tool.name)) continue;
        const key = `${tool.name}\u0000${tool.inputKey}`;
        const prev = seen.get(key);
        if (prev && !prev.failed && prev.resultKey !== undefined && prev.resultKey === tool.resultKey) {
          let g = groups.get(key);
          if (!g) {
            g = { name: tool.name, first: prev.turn, repeats: [] };
            groups.set(key, g);
          }
          g.repeats.push({ turn: turn.index, tokens: tool.resultTokens });
        }
        seen.set(key, { turn: turn.index, failed: tool.isError === true, resultKey: tool.resultKey });
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
        severity: severityFor("no-loss", cost, ctx.config),
        runId: run.id,
        file: run.file,
        turns,
        message: `${g.name} called ${turns.length}x with identical input and result (turns ${turnList(turns)})`,
        costUsd: cost,
        tokens,
        // The repeat returned what the model already had.
        fix: "no-loss",
        avoidableUsd: cost,
      });
    }
    return findings;
  },
};
