import type { Finding, FixEffect, Run, Tokens, Turn } from "../model.js";
import { cacheWriteTotal } from "../model.js";
import type { Price } from "../pricing.js";
import {
  compactTokens,
  formatDuration,
  PREFIX_CHANGE_LABEL,
  prefixChange,
  severityFor,
  sumNullable,
  type PrefixChange,
  type Rule,
  type RuleContext,
} from "./types.js";

/**
 * Calls that read back less from the prompt cache than the previous call left
 * in it, and wrote it again. With a stable prefix, each call reads everything
 * the previous one cached (read + written) and writes only what is new since.
 * Reading less means the cache expired between calls, the model changed, or
 * the prefix changed (edited system prompt, reordered tools, injected
 * timestamps). A large write alone is not a rewrite: a big tool result is new
 * content and has to be written once.
 *
 * Only the lost part is waste: min(cached before, written) tokens, at the
 * write rate minus the read rate. New tokens are written either way.
 * Calls without usage (failed) leave the cache state as it was.
 *
 * The first call after compaction is skipped: the context was replaced on
 * purpose and has to be cached again.
 *
 * Expiry is judged against the TTL the call wrote with (1h writes vs 5m). Gaps
 * are measured between response timestamps, so a gap a little under the TTL
 * can still be an expiry; the cause wording stays "likely".
 *
 * Cost = lost tokens that were written again, at the write rate minus the read rate.
 *
 * One finding per cause, because the fixes differ:
 * - expired: no-loss. The fix is a keep-alive, which sends the same prompt.
 *   Nobody knows how long a break will be, so the saving assumes a fixed
 *   policy: re-send the cached prefix just before the TTL runs out (billed as
 *   a cache read), for up to `keepAliveHours`. Breaks longer than that pay for
 *   the pings and the rewrite. Sessions never resumed would also be pinged;
 *   that cost has no turn to attach to and is not included.
 * - prefix changed: no-loss, assuming the changing part can move after the
 *   cached prefix. The whole rewrite counts. When the trace records the
 *   prompt, the hashes name what changed (tools, system prompt, an earlier
 *   message, or 20+ blocks added beyond the lookback); if they show nothing
 *   changed, the cause is unknown and the rewrite isn't counted as savable.
 * - model switched: trade-off. Avoiding it means running the other model.
 */
export const cacheThrash: Rule = {
  id: "cache-thrash",
  description: "Prompt cache lost and written again after the first turn",
  check(run, ctx) {
    const groups: Record<Cause, CacheEvent[]> = { expired: [], "model-switch": [], prefix: [] };

    // The last call with known cache usage, and what it left cached.
    let prev: { turn: Turn; cached: number } | null = null;
    for (let i = 0; i < run.turns.length; i++) {
      const turn = run.turns[i]!;
      const t = turn.call.tokens;
      if (!t) continue; // failed or no usage: the cache is as the last call left it
      if (!t.cacheKnown) {
        prev = null; // can't tell what is cached from here on
        continue;
      }
      const written = cacheWriteTotal(t);
      const read = t.cacheRead ?? 0;
      const before = prev;
      prev = { turn, cached: read + written };
      if (!before || turn.contextReplacedBefore) continue;
      const lost = before.cached - read;
      const rewritten = Math.min(lost, written);
      if (lost < ctx.config.cacheThrashMinTokens || rewritten <= 0) continue;

      const price = ctx.prices.lookup(turn.call.model);
      const pc = before.turn.call;
      const gapMin = pc.ts && turn.call.ts ? (Date.parse(turn.call.ts) - Date.parse(pc.ts)) / 60000 : undefined;
      const ttlMin = (t.cacheWrite1h ?? 0) > written / 2 ? 60 : 5;
      const cause: Cause =
        gapMin != null && gapMin > ttlMin * 0.9
          ? "expired"
          : pc.model && turn.call.model && pc.model !== turn.call.model
            ? "model-switch"
            : "prefix";
      // The call's own write rate (5m and 1h mix), applied to the rewritten part only.
      const cost = price ? (rewriteCost(t, price) * rewritten) / written : null;
      const keepAlive =
        cause === "expired" && price ? keepAliveCost(gapMin!, ttlMin, prefixTokens(pc.tokens) || before.cached, price, ctx) : null;
      const part = cause === "prefix" ? prefixChange(pc.promptKeys, turn.call.promptKeys) : undefined;
      groups[cause].push({ turn: i, written: rewritten, cost, gapMin, keepAlive, part });
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
  /** Prefix cause only: what the prompt hashes show changed; undefined when the prompt isn't recorded. */
  part?: PrefixChange;
}

const FIX: Record<Cause, FixEffect> = { expired: "no-loss", prefix: "no-loss", "model-switch": "trade-off" };

function findingFor(run: Run, ctx: RuleContext, rule: string, cause: Cause, events: CacheEvent[]): Finding {
  const cost = sumNullable(events.map((e) => e.cost));
  const tokens = events.reduce((s, e) => s + e.written, 0);
  const fix = FIX[cause];
  const n = events.length;
  const rewrites = `${n} cache rewrite${n === 1 ? "" : "s"}`;
  const hours = ctx.config.keepAliveHours;

  let avoidable: number | null = null;
  let message: string;
  if (cause === "expired") {
    // Each event: a covered break saves the rewrite and pays for its pings; a longer one pays for both.
    avoidable = sumNullable(
      events.map((e) => (e.keepAlive == null || e.cost == null ? null : (e.keepAlive.covered ? e.cost : 0) - e.keepAlive.spent)),
    );
    const gaps = events.map((e) => e.gapMin!).sort((a, b) => a - b);
    const covered = events.filter((e) => e.keepAlive?.covered).length;
    if (n === 1) {
      message = `${rewrites} after ${formatDuration(gaps[0]!)} idle, ${covered ? "within" : "beyond"} the ${hours}h keep-alive`;
    } else {
      const share = covered === n ? "all" : covered === 0 ? "none" : String(covered);
      message = `${rewrites} after ${formatDuration(gaps[0]!)}–${formatDuration(gaps[n - 1]!)} idle, ${share} within the ${hours}h keep-alive`;
    }
  } else if (cause === "prefix") {
    // A rewrite the hashes say had an unchanged prefix has no known fix.
    const known = events.filter((e) => e.part !== "same");
    avoidable = known.length ? sumNullable(known.map((e) => e.cost)) : 0;
    const parts = new Set(events.map((e) => e.part));
    const only = parts.size === 1 ? [...parts][0] : undefined;
    message =
      only === "same"
        ? `${rewrites} with the prompt prefix unchanged in the trace (cause unknown)`
        : only
          ? `${rewrites}: ${PREFIX_CHANGE_LABEL[only]}`
          : `${rewrites} after the prompt prefix changed`;
  } else {
    message = `${rewrites} after a model switch`;
  }

  return {
    rule,
    severity: severityFor(fix, avoidable, ctx.config),
    runId: run.id,
    file: run.file,
    turns: events.map((e) => e.turn),
    message,
    details: events.map((e) => {
      const parts = [`turn ${e.turn + 1}`, `${compactTokens(e.written)} tokens`];
      if (e.cost != null) parts.push(`$${e.cost.toFixed(2)}`);
      if (e.part) parts.push(e.part === "same" ? "prefix unchanged, cause unknown, not counted" : PREFIX_CHANGE_LABEL[e.part]);
      if (cause === "expired" && e.gapMin != null)
        parts.push(`idle ${formatDuration(e.gapMin)}${e.keepAlive && !e.keepAlive.covered ? `, beyond keep-alive` : ""}`);
      return parts.join(" · ");
    }),
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
