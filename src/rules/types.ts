import type { Finding, FixEffect, Run, Severity } from "../model.js";
import type { PriceTable } from "../pricing.js";

export interface RuleConfig {
  /** USD at or above which a finding is high / medium severity. */
  highUsd: number;
  mediumUsd: number;
  /** cache-thrash: minimum rewritten tokens for a turn to count. */
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
  cacheThrashMinTokens: 20_000,
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
