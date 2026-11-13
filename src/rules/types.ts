import type { Finding, Run, Severity } from "../model.js";
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

export function severityFor(costUsd: number | null, config: RuleConfig): Severity {
  if (costUsd == null) return "low";
  if (costUsd >= config.highUsd) return "high";
  if (costUsd >= config.mediumUsd) return "medium";
  return "low";
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
