import type { Finding, FixEffect, PromptKeys, Run, Severity } from "../model.js";
import type { PriceTable } from "../pricing.js";

export interface RuleConfig {
  /** USD at or above which a finding is high / medium severity. */
  highUsd: number;
  mediumUsd: number;
  /** cache-thrash: minimum cached tokens a call must lose for it to count. */
  cacheThrashMinTokens: number;
  /**
   * cache-thrash: how long the assumed keep-alive keeps an idle cache warm
   * before giving up. Nobody knows in advance how long a break will be, so
   * the saving is judged against this fixed policy, not against hindsight.
   */
  keepAliveHours: number;
}

export const defaultConfig: RuleConfig = {
  highUsd: 1,
  mediumUsd: 0.1,
  cacheThrashMinTokens: 1024,
  keepAliveHours: 12,
};

export interface RuleContext {
  prices: PriceTable;
  config: RuleConfig;
}

export interface Rule {
  id: string;
  description: string;
  check(run: Run, ctx: RuleContext): Finding[];
}

/**
 * Severity follows what fixing the finding would save, not what it cost:
 * a trade-off, or a fix that would save nothing, is "info".
 */
export function severityFor(fix: FixEffect, avoidableUsd: number | null, config: RuleConfig): Severity {
  if (fix === "trade-off") return "info";
  if (avoidableUsd == null) return "low";
  if (avoidableUsd <= 0) return "info";
  if (avoidableUsd >= config.highUsd) return "high";
  if (avoidableUsd >= config.mediumUsd) return "medium";
  return "low";
}

/** Compact token count: 940, 56k, 8.6M. */
export function compactTokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e4) return `${Math.round(n / 1e3)}k`;
  return n.toLocaleString("en-US");
}

/** Idle time for humans: 16m, 2h30m, 39h43m, 6d20h, 89d. */
export function formatDuration(min: number): string {
  if (min < 60) return `${Math.round(min)}m`;
  if (min < 48 * 60) {
    const h = Math.floor(min / 60);
    const m = Math.round(min - h * 60);
    return m ? `${h}h${m}m` : `${h}h`;
  }
  const d = Math.floor(min / 1440);
  const h = Math.round((min - d * 1440) / 60);
  return d >= 10 || !h ? `${d}d` : `${d}d${h}h`;
}

/** Turns are shown 1-based to humans. */
export const turnList = (idx: number[]) => idx.map((i) => i + 1).join(", ");

export function sumNullable(values: Array<number | null | undefined>): number | null {
  let total = 0;
  let any = false;
  for (const v of values) {
    if (v == null) continue;
    total += v;
    any = true;
  }
  return any ? total : null;
}

/**
 * What kept a prompt cache written at the end of `prev` from being read by
 * `cur`, from the prompt hashes: "same" when nothing did. Anthropic renders
 * tools, then system, then messages, so a change in an earlier part loses
 * everything after it. A breakpoint finds an earlier cache entry at most 20
 * blocks back, itself included, so a step that adds 20 or more blocks misses
 * too. undefined when either prompt isn't recorded.
 */
export type PrefixChange = "same" | "tools" | "system" | "messages" | "lookback";

export function prefixChange(prev: PromptKeys | undefined, cur: PromptKeys | undefined): PrefixChange | undefined {
  if (!prev || !cur) return undefined;
  if (prev.tools !== cur.tools) return "tools";
  if (prev.system !== cur.system) return "system";
  if (cur.messages.length < prev.messages.length || prev.messages.some((m, i) => cur.messages[i] !== m)) return "messages";
  const added = cur.blocks.slice(prev.messages.length).reduce((s, n) => s + n, 0);
  return added >= 20 ? "lookback" : "same";
}

export const PREFIX_CHANGE_LABEL: Record<Exclude<PrefixChange, "same">, string> = {
  tools: "tool definitions changed",
  system: "system prompt changed",
  messages: "an earlier message changed",
  lookback: "20+ blocks added in one step, beyond the cache lookback",
};
