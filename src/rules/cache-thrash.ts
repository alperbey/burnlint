import type { Finding, FixEffect, Run, Tokens } from "../model.js";
import { cacheWriteTotal } from "../model.js";
import type { Price } from "../pricing.js";
import { severityFor, sumNullable, type Rule, type RuleContext } from "./types.js";

/**
 * Turns (after the first) that write more to the prompt cache than they read
 * from it. In a healthy run the cached prefix grows by a small delta per turn;
 * a large rewrite means the cache expired between calls, the model changed, or
 * the prefix changed (edited system prompt, reordered tools, injected
 * timestamps).
 *
 * The first call after compaction is skipped: the context was replaced on
 * purpose and has to be cached again.
 *
 * Expiry is judged against the TTL the call wrote with (1h writes vs 5m). Gaps
 * are measured between response timestamps, so a gap a little under the TTL
 * can still be an expiry; the cause wording stays "likely".
 *
 * Cost = rewritten tokens priced at the write rate minus the read rate.
 *
 * One finding per cause, because the fixes differ:
 * - expired: no-loss. The fix is a keep-alive, which sends the same prompt.
 *   Nobody knows how long a break will be, so the saving assumes a fixed
 *   policy: re-send the cached prefix just before the TTL runs out (billed as
 *   a cache read), for up to `keepAliveHours`. Breaks longer than that pay for
 *   the pings and the rewrite. Sessions never resumed would also be pinged;
 *   that cost has no turn to attach to and is not included.
 * - prefix changed: no-loss, assuming the changing part can move after the
 *   cached prefix. The whole rewrite counts.
 * - model switched: trade-off. Avoiding it means running the other model.
 */
export const cacheThrash: Rule = {
  id: "cache-thrash",
  description: "Large prompt-cache rewrites after the first turn",
  check(run, ctx) {
    const groups: Record<Cause, CacheEvent[]> = { expired: [], "model-switch": [], prefix: [] };

    for (let i = 1; i < run.turns.length; i++) {
      const turn = run.turns[i]!;
      const prev = run.turns[i - 1]!;
      const t = turn.call.tokens;
      if (!t || !t.cacheKnown || turn.contextReplacedBefore) continue;
      const written = cacheWriteTotal(t);
      const read = t.cacheRead ?? 0;
      if (written < ctx.config.cacheThrashMinTokens || written <= read) continue;
      const price = ctx.prices.lookup(turn.call.model);
      const gapMin =
        prev.call.ts && turn.call.ts ? (Date.parse(turn.call.ts) - Date.parse(prev.call.ts)) / 60000 : undefined;
      const ttlMin = (t.cacheWrite1h ?? 0) > written / 2 ? 60 : 5;
      const cause: Cause =
        gapMin != null && gapMin > ttlMin * 0.9
          ? "expired"
          : prev.call.model && turn.call.model && prev.call.model !== turn.call.model
            ? "model-switch"
            : "prefix";
      const cost = price ? rewriteCost(t, price) : null;
      const keepAlive =
        cause === "expired" && price ? keepAliveCost(gapMin!, ttlMin, prefixTokens(prev.call.tokens) || read + written, price, ctx) : null;
      groups[cause].push({ turn: i, written, cost, gapMin, keepAlive });
    }

    const findings: Finding[] = [];
    for (const cause of ["expired", "prefix", "model-switch"] as const) {
      const events = groups[cause];
      if (events.length) findings.push(findingFor(run, ctx, this.id, cause, events));
    }
    return findings;
  },
};

type Cause = "expired" | "model-switch" | "prefix";

interface CacheEvent {
  turn: number;
  written: number;
  cost: number | null;
  gapMin?: number;
  /** Expired only: what the keep-alive would have spent; `covered` = the break was short enough for it. */
  keepAlive: { spent: number; covered: boolean } | null;
}

const CAUSES: Record<Cause, { text: string; fix: FixEffect }> = {
  expired: { text: "cache likely expired between calls", fix: "no-loss" },
  prefix: { text: "prompt prefix changed between calls", fix: "no-loss" },
  "model-switch": { text: "model switched between calls", fix: "trade-off" },
};

function findingFor(run: Run, ctx: RuleContext, rule: string, cause: Cause, events: CacheEvent[]): Finding {
  const cost = sumNullable(events.map((e) => e.cost));
  const tokens = events.reduce((s, e) => s + e.written, 0);
  const detail = events
    .slice(0, 5)
    .map((e) => {
      const gap = cause === "expired" && e.gapMin != null ? `, ${formatGap(e.gapMin)} after previous call` : "";
      return `turn ${e.turn + 1}: ${e.written.toLocaleString("en-US")} tokens${gap}`;
    })
    .join("; ");
  const { text, fix } = CAUSES[cause];

  let avoidable: number | null = null;
  let note = "";
  if (cause === "prefix") avoidable = cost;
  if (cause === "expired") {
    // Each event: a covered break saves the rewrite and pays for its pings; a longer one pays for both.
    avoidable = sumNullable(
      events.map((e) => (e.keepAlive == null || e.cost == null ? null : (e.keepAlive.covered ? e.cost : 0) - e.keepAlive.spent)),
    );
    if (avoidable != null) {
      const covered = events.filter((e) => e.keepAlive?.covered).length;
      note =
        `; keeping the cache warm for up to ${ctx.config.keepAliveHours}h would have covered ${covered} of ${events.length} ` +
        (avoidable > 0 ? `and saved $${avoidable.toFixed(2)}` : `but cost more than it saved`);
    }
  }

  return {
    rule,
    severity: severityFor(cost, ctx.config),
    runId: run.id,
    file: run.file,
    turns: events.map((e) => e.turn),
    message: `${events.length} cache rewrite(s), ${tokens.toLocaleString("en-US")} tokens, ${text} (${detail}${events.length > 5 ? "; …" : ""})${note}`,
    costUsd: cost,
    tokens,
    fix,
    avoidableUsd: avoidable,
  };
}

/** Tokens a keep-alive re-sends: the previous call's whole prompt. 0 when unknown. */
function prefixTokens(t: Tokens | null): number {
  return t ? (t.input ?? 0) + (t.cacheRead ?? 0) + cacheWriteTotal(t) : 0;
}

/**
 * The assumed keep-alive: a cache read of the whole prefix every 55/60 of the
 * TTL, while the session is idle, for at most `keepAliveHours`.
 */
function keepAliveCost(gapMin: number, ttlMin: number, tokens: number, p: Price, ctx: RuleContext) {
  if (p.cacheRead == null) return null;
  const every = (ttlMin * 55) / 60;
  const maxMin = ctx.config.keepAliveHours * 60;
  const covered = gapMin <= maxMin;
  const pings = Math.floor((covered ? gapMin : maxMin) / every);
  return { spent: (pings * tokens * p.cacheRead) / 1e6, covered };
}

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
