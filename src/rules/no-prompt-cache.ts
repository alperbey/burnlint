import type { Finding, PromptKeys } from "../model.js";
import { cacheWriteTotal } from "../model.js";
import { cachesOnlyWhenAsked, minCacheableTokens } from "../pricing.js";
import { compactTokens, PREFIX_CHANGE_LABEL, prefixChange, severityFor, type PrefixChange, type Rule } from "./types.js";

const TTL_MIN = 5;

/**
 * A run on a provider that caches only when asked (Anthropic) that never
 * cached anything, while its calls re-sent the same growing prompt.
 *
 * Savable is a counterfactual: the same calls with a 5-minute cache breakpoint
 * at the end of each prompt (what top-level `cache_control` does). Each call
 * reads the previous call's prompt and writes the rest; prompts below the
 * model's minimum are not cached. The result is net of the write premium and
 * reported only when positive.
 *
 * Stays silent when it can't tell: cache fields unknown on any call, any
 * cache read or write in the run (then caching is on and `cache-thrash`
 * covers losses), a provider that caches on its own or wasn't checked, a
 * model without a known minimum, or a missing price.
 *
 * A call reads the cache only if its prefix is the previous call's: checked
 * from the prompt hashes when the trace records the prompt (a changed tool
 * list, system prompt or earlier message, or 20+ blocks added in one step, is
 * a miss). Without them the prefix is assumed stable while the prompt doesn't
 * shrink, and the saving is labeled an upper bound: a prefix that changes
 * every call (a timestamp in the system prompt) would make it err high. A
 * shrinking prompt, a context reset, a model change, an unknown timestamp or
 * a gap near the TTL count as a miss either way. Savable is what turning
 * caching on as the app stands would save; a volatile prefix is named in the
 * details, not counted. Checked against real cached runs with their caching
 * stripped (within 0.1%) and a real nocache run.
 */
export const noPromptCache: Rule = {
  id: "no-prompt-cache",
  description: "Prompt caching off while calls re-send the same prefix",
  check(run, ctx) {
    const turns = run.turns.filter((t) => t.call.tokens);
    if (turns.length < 2) return [];
    for (const { call } of turns) {
      const t = call.tokens!;
      if (!t.cacheKnown || (t.cacheRead ?? 0) > 0 || cacheWriteTotal(t) > 0) return [];
      if (!cachesOnlyWhenAsked(call.provider)) return [];
    }

    let state: { cached: number; at: number; model: string; keys?: PromptKeys } | null = null;
    let readTokens = 0;
    let gross = 0; // re-sent tokens at the full rate minus the read rate
    let premium = 0; // writes at the write rate minus the full rate
    let misses = 0;
    let small = 0;
    let assumed = 0; // hits counted without the prompt hashes to check the prefix
    const changed = new Map<Exclude<PrefixChange, "same">, number>();
    const hits: number[] = [];

    for (const turn of turns) {
      const { call } = turn;
      const t = call.tokens!;
      const price = ctx.prices.lookup(call.model);
      const min = minCacheableTokens(call.model);
      if (!price || price.input == null || price.cacheRead == null || price.cacheWrite5m == null || min == null) return [];
      const prompt = t.input ?? 0;
      const at = call.ts ? Date.parse(call.ts) : NaN;
      // A shrinking prompt may start with a different prefix: start over, as after a reset.
      const shrank = state != null && prompt < state.cached;
      if (shrank) misses++;
      if (shrank || turn.contextReplacedBefore || state?.model !== call.model) state = null;
      if (prompt < min) {
        small++;
        continue;
      }
      // Timestamps are span starts (OTLP) or response times (Claude Code), not the
      // request starts the lifetime runs from; a gap near the TTL counts as a miss.
      const change = state ? prefixChange(state.keys, call.promptKeys) : undefined;
      if (change && change !== "same") changed.set(change, (changed.get(change) ?? 0) + 1);
      const inTime = state != null && !Number.isNaN(at) && at - state.at <= TTL_MIN * 60000 * 0.9;
      if (state && !inTime) misses++;
      const warm = inTime && (change === "same" || change === undefined);
      if (warm && change === undefined) assumed++;
      const read = warm ? state!.cached : 0;
      if (warm) hits.push(turn.index);
      readTokens += read;
      gross += (read * (price.input - price.cacheRead)) / 1e6;
      premium += ((prompt - read) * (price.cacheWrite5m - price.input)) / 1e6;
      state = { cached: prompt, at, model: call.model!, keys: call.promptKeys };
    }

    const avoidable = gross - premium;
    if (!hits.length || avoidable <= 0) return [];
    const details = [
      `${hits.length} of ${turns.length} calls would have read the previous prompt from a 5-minute cache`,
      `writing it would have cost $${premium.toFixed(4)} more; net saving $${avoidable.toFixed(4)}`,
    ];
    if (assumed) details.push(`prefix not checked on ${assumed} of these (no prompt content in the trace): the saving is an upper bound`);
    for (const [change, n] of changed) details.push(`${n} call(s) missed: ${PREFIX_CHANGE_LABEL[change]}; caching pays only on a stable prefix`);
    if (misses) details.push(`${misses} call(s) counted as misses: the prompt shrank, or idle near the 5-minute lifetime`);
    if (small) details.push(`${small} call(s) below the model's minimum cacheable prompt`);
    const finding: Finding = {
      rule: this.id,
      severity: severityFor("no-loss", avoidable, ctx.config),
      runId: run.id,
      file: run.file,
      turns: hits,
      message: `prompt caching off: ${assumed ? "up to " : ""}${compactTokens(readTokens)} tokens of repeated prefix sent at the full rate over ${hits.length} calls`,
      details,
      costUsd: gross,
      tokens: readTokens,
      // Caching changes the price, not what the model sees.
      fix: "no-loss",
      avoidableUsd: avoidable,
    };
    return [finding];
  },
};
