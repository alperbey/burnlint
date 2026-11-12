import type { Finding, Tokens } from "../model.js";
import { cacheWriteTotal } from "../model.js";
import type { Price } from "../pricing.js";
import { severityFor, sumNullable, type Rule } from "./types.js";

/**
 * Turns (after the first) that write more to the prompt cache than they read
 * from it. In a healthy run the cached prefix grows by a small delta per turn;
 * a large rewrite means the prefix changed (edited system prompt, reordered
 * tools, injected timestamps) or the cache expired between calls.
 *
 * Avoidable cost = rewritten tokens priced at the write rate minus the read rate.
 */
export const cacheThrash: Rule = {
  id: "cache-thrash",
  description: "Large prompt-cache rewrites after the first turn",
  check(run, ctx) {
    const events: Array<{ turn: number; written: number; cost: number | null; gapMin?: number }> = [];

    for (let i = 1; i < run.turns.length; i++) {
      const turn = run.turns[i]!;
      const t = turn.call.tokens;
      if (!t || !t.cacheKnown) continue;
      const written = cacheWriteTotal(t);
      const read = t.cacheRead ?? 0;
      if (written < ctx.config.cacheThrashMinTokens || written <= read) continue;
      const price = ctx.prices.lookup(turn.call.model);
      const prevTs = run.turns[i - 1]?.call.ts;
      const gapMin =
        prevTs && turn.call.ts ? (Date.parse(turn.call.ts) - Date.parse(prevTs)) / 60000 : undefined;
      events.push({ turn: i, written, cost: price ? rewriteCost(t, price) : null, gapMin });
    }

    if (!events.length) return [];
    const cost = sumNullable(events.map((e) => e.cost));
    const tokens = events.reduce((s, e) => s + e.written, 0);
    const expired = events.filter((e) => e.gapMin != null && e.gapMin > 5);
    const detail = events
      .slice(0, 5)
      .map((e) => {
        const gap = e.gapMin != null && e.gapMin > 5 ? `, ${formatGap(e.gapMin)} after previous call` : "";
        return `turn ${e.turn + 1}: ${e.written.toLocaleString("en-US")} tokens${gap}`;
      })
      .join("; ");
    const cause =
      expired.length === events.length
        ? "cache likely expired between calls"
        : expired.length
          ? "prefix changed or cache expired"
          : "prompt prefix changed between calls";

    const finding: Finding = {
      rule: this.id,
      severity: severityFor(cost, ctx.config),
      runId: run.id,
      file: run.file,
      turns: events.map((e) => e.turn),
      message: `${events.length} cache rewrite(s), ${tokens.toLocaleString("en-US")} tokens, ${cause} (${detail}${events.length > 5 ? "; …" : ""})`,
      costUsd: cost,
      tokens,
    };
    return [finding];
  },
};

function rewriteCost(t: Tokens, p: Price): number {
  const read = p.cacheRead ?? 0;
  const w5 = p.cacheWrite5m ?? p.input ?? 0;
  const w1 = p.cacheWrite1h ?? w5;
  return (
    ((t.cacheWrite5m ?? 0) * (w5 - read) + (t.cacheWrite1h ?? 0) * (w1 - read) + (t.cacheWriteOther ?? 0) * (w5 - read)) /
    1e6
  );
}

function formatGap(min: number): string {
  if (min < 60) return `${Math.round(min)}m`;
  const h = Math.floor(min / 60);
  return `${h}h${Math.round(min - h * 60)}m`;
}
