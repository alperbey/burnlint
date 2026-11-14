import { audit, unitOf, unitsOf, type AuditOptions, type AuditResult, type RunSummary } from "./audit.js";

/**
 * Cost per run before and after a change. Runs are compared within groups
 * (the same agent, task or input on both sides), so a different mix of tasks
 * doesn't pass for a change in cost.
 */
export interface DiffResult {
  /** Label key the runs were grouped by; undefined when all runs form one group. */
  groupBy?: string;
  base: Side;
  head: Side;
  /** Groups with counted runs on both sides, in base order. */
  groups: GroupDiff[];
  /** Groups with counted runs on one side only: not in the overall comparison. */
  onlyBase: string[];
  onlyHead: string[];
  overall: Overall | null;
  prices: AuditResult["prices"];
}

export interface Side {
  paths: string[];
  /** Units of work found (a Claude Code session with its sub-agents, or one OTLP trace). */
  runs: number;
  /** Runs with at least one priced call. */
  counted: number;
  /** Runs with a failed call, counted or not. A failed run tends to be cheap, so more of them flatters cost. */
  failed: number;
  /** Counted runs with calls that couldn't be priced (no price or no usage): their cost is unknown. */
  unpriced: number;
  /** Runs left out: no call could be priced. */
  excluded: number;
  unpricedModels: string[];
  models: string[];
  /** Plain mean over all counted runs, what `audit` reports as cost per run. null with none. */
  pooledUsd: number | null;
}

export interface GroupDiff {
  name: string;
  /** Share of base's counted runs (in groups on both sides): the weight in the overall. */
  weight: number;
  base: GroupStats;
  head: GroupStats;
  /** (head - base) / base mean cost; null when base costs nothing. */
  change: number | null;
}

export interface GroupStats {
  runs: number;
  meanUsd: number;
  medianUsd: number;
  minUsd: number;
  maxUsd: number;
  /** Per run, means. */
  calls: number;
  promptTokens: number;
  outputTokens: number;
  /** Cache reads as a share of prompt tokens; null when any run's cache usage is unknown. */
  cacheShare: number | null;
}

export interface Overall {
  /** Group means weighted by base's mix of runs. */
  baseUsd: number;
  headUsd: number;
  change: number | null;
  /** Permutation p-values for the weighted difference: head higher (one-sided) and either way (two-sided). */
  pHigher: number;
  pTwoSided: number;
  /** "exact" over every relabeling within groups, or "sampled" with a fixed seed. */
  method: "exact" | "sampled";
  permutations: number;
  /** Smallest two-sided p these runs can give; at or above 0.05 no change can be shown. */
  minP: number;
  /**
   * About two standard errors of the change, as a share of base: changes
   * within it are run-to-run noise. null when a group has one run on both sides.
   */
  noise: number | null;
  verdict: Verdict;
}

export type Verdict = "higher" | "lower" | "no clear change" | "too few runs" | "can't tell";

export interface DiffOptions extends AuditOptions {
  /** Label key to group runs by. Default: gen_ai.agent.name, else project, else one group. */
  groupBy?: string;
}

export const DEFAULT_GROUP_KEYS = ["gen_ai.agent.name", "project"];
export const SIGNIFICANCE = 0.05;
const EXACT_LIMIT = 200_000;
const SAMPLES = 20_000;

interface Unit {
  group: string;
  cost: number;
  counted: boolean;
  failed: boolean;
  unpriced: boolean;
  calls: number;
  prompt: number;
  output: number;
  cacheRead: number;
  cacheUnknown: boolean;
  models: string[];
  unpricedModels: string[];
}

export function diff(basePaths: string[], headPaths: string[], opts: DiffOptions = {}): DiffResult {
  // Findings aren't compared yet; only the cost of each run is needed.
  const auditOpts = { ...opts, rules: false };
  const a = audit(basePaths, auditOpts);
  const b = audit(headPaths, auditOpts);
  return compare(a.runs, b.runs, { ...opts, basePaths, headPaths, prices: a.prices });
}

/** Thrown for a grouping key no run carries: a typo would otherwise compare everything as one group. */
export class GroupKeyError extends Error {}

export function compare(
  baseRuns: RunSummary[],
  headRuns: RunSummary[],
  opts: { groupBy?: string; basePaths?: string[]; headPaths?: string[]; prices?: AuditResult["prices"] } = {},
): DiffResult {
  const all = [...baseRuns, ...headRuns];
  let groupBy = opts.groupBy;
  if (groupBy !== undefined && !all.some((r) => label(r, groupBy!) !== undefined)) {
    const known = [...new Set(all.flatMap((r) => Object.keys(r.labels)))].sort();
    throw new GroupKeyError(`no run has "${groupBy}"${known.length ? ` (keys found: ${known.join(", ")})` : ""}`);
  }
  groupBy ??= DEFAULT_GROUP_KEYS.find((k) => all.some((r) => label(r, k) !== undefined));

  const base = units(baseRuns, groupBy);
  const head = units(headRuns, groupBy);
  const countedB = base.filter((u) => u.counted);
  const countedH = head.filter((u) => u.counted);
  const names = (us: Unit[]) => [...new Set(us.map((u) => u.group))];
  const shared = names(countedB).filter((g) => countedH.some((u) => u.group === g));
  const total = countedB.filter((u) => shared.includes(u.group)).length;

  const groups: GroupDiff[] = shared.map((name) => {
    const bs = stats(countedB.filter((u) => u.group === name));
    const hs = stats(countedH.filter((u) => u.group === name));
    return { name, weight: bs.runs / total, base: bs, head: hs, change: bs.meanUsd > 0 ? (hs.meanUsd - bs.meanUsd) / bs.meanUsd : null };
  });

  const result: DiffResult = {
    groupBy,
    base: side(base, opts.basePaths ?? []),
    head: side(head, opts.headPaths ?? []),
    groups,
    onlyBase: names(countedB).filter((g) => !shared.includes(g)),
    onlyHead: names(countedH).filter((g) => !shared.includes(g)),
    overall: null,
    prices: opts.prices ?? { source: "", retrieved: "" },
  };
  if (groups.length) {
    const samples = groups.map((g) => ({
      weight: g.weight,
      base: countedB.filter((u) => u.group === g.name).map((u) => u.cost),
      head: countedH.filter((u) => u.group === g.name).map((u) => u.cost),
    }));
    result.overall = overall(samples, result);
  }
  return result;
}

/** A run's own label, never one inherited from Object (`--group-by constructor`). */
const label = (r: RunSummary, key: string): string | undefined => (Object.hasOwn(r.labels, key) ? r.labels[key] : undefined);

/** Runs summed into units of work (a Claude Code session with its sub-agents), each with its group. */
function units(runs: RunSummary[], groupBy: string | undefined): Unit[] {
  return unitsOf(runs).map((rs) => {
    // The main run's labels name the unit; a sub-agent's may differ.
    const main = rs.find((r) => r.id === unitOf(r)) ?? rs[0]!;
    const sum = (f: (r: RunSummary) => number) => rs.reduce((s, r) => s + f(r), 0);
    const priced = sum((r) => r.pricedCalls);
    const failed = sum((r) => r.failedCalls);
    const calls = sum((r) => r.calls);
    return {
      group: groupBy === undefined ? "all runs" : (label(main, groupBy) ?? `(no ${groupBy})`),
      cost: sum((r) => r.costUsd),
      counted: priced > 0,
      failed: failed > 0,
      unpriced: priced + failed < calls,
      calls,
      prompt: sum((r) => r.promptTokens),
      output: sum((r) => r.outputTokens),
      cacheRead: sum((r) => r.cacheReadTokens),
      cacheUnknown: rs.some((r) => r.cacheUnknownCalls > 0),
      models: [...new Set(rs.flatMap((r) => r.models))],
      unpricedModels: [...new Set(rs.flatMap((r) => r.unpricedModels))],
    };
  });
}

function side(us: Unit[], paths: string[]): Side {
  const counted = us.filter((u) => u.counted);
  return {
    paths,
    runs: us.length,
    counted: counted.length,
    failed: us.filter((u) => u.failed).length,
    unpriced: counted.filter((u) => u.unpriced).length,
    excluded: us.length - counted.length,
    unpricedModels: [...new Set(us.flatMap((u) => u.unpricedModels))].sort(),
    models: [...new Set(counted.flatMap((u) => u.models))].sort(),
    pooledUsd: counted.length ? counted.reduce((s, u) => s + u.cost, 0) / counted.length : null,
  };
}

function stats(us: Unit[]): GroupStats {
  const costs = us.map((u) => u.cost).sort((a, b) => a - b);
  const n = costs.length;
  const mid = n >> 1;
  const mean = (f: (u: Unit) => number) => us.reduce((s, u) => s + f(u), 0) / n;
  const prompt = us.reduce((s, u) => s + u.prompt, 0);
  return {
    runs: n,
    meanUsd: mean((u) => u.cost),
    medianUsd: n % 2 ? costs[mid]! : (costs[mid - 1]! + costs[mid]!) / 2,
    minUsd: costs[0]!,
    maxUsd: costs[n - 1]!,
    calls: mean((u) => u.calls),
    promptTokens: mean((u) => u.prompt),
    outputTokens: mean((u) => u.output),
    cacheShare: us.some((u) => u.cacheUnknown) || prompt === 0 ? null : us.reduce((s, u) => s + u.cacheRead, 0) / prompt,
  };
}

interface Sample {
  weight: number;
  base: number[];
  head: number[];
}

const meanOf = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;

/** Weighted difference of group means, head minus base. */
const statistic = (gs: Sample[]) => gs.reduce((s, g) => s + g.weight * (meanOf(g.head) - meanOf(g.base)), 0);

/**
 * Overall change at base's mix of groups, and a permutation test of it: within
 * each group, runs are relabeled base/head in every way that keeps the group's
 * counts, and the same weighted difference is computed each time.
 */
export function overall(gs: Sample[], r: Pick<DiffResult, "base" | "head">): Overall {
  const baseUsd = gs.reduce((s, g) => s + g.weight * meanOf(g.base), 0);
  const headUsd = gs.reduce((s, g) => s + g.weight * meanOf(g.head), 0);
  const observed = headUsd - baseUsd;
  const { values, method } = permutationDistribution(gs);
  // Sums of the same values in another order can differ in the last bits.
  const eps = 1e-12 * Math.max(1, Math.abs(observed));
  const higher = values.filter((v) => v >= observed - eps).length;
  const either = values.filter((v) => Math.abs(v) >= Math.abs(observed) - eps).length;
  const p = (hits: number) => (method === "exact" ? hits / values.length : (hits + 1) / (values.length + 1));
  const permutations = method === "exact" ? values.length : SAMPLES;
  // The most extreme relabeling either way is the smallest p any outcome could give.
  const most = values.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  const minP = method === "exact" ? values.filter((v) => Math.abs(v) >= most - eps).length / values.length : 1 / (SAMPLES + 1);
  const change = baseUsd > 0 ? observed / baseUsd : null;
  const pTwoSided = p(either);

  let verdict: Verdict;
  if (r.base.unpriced || r.head.unpriced) verdict = "can't tell";
  else if (minP >= SIGNIFICANCE) verdict = "too few runs";
  else if (pTwoSided < SIGNIFICANCE) verdict = observed > 0 ? "higher" : "lower";
  else verdict = "no clear change";

  return {
    baseUsd,
    headUsd,
    change,
    pHigher: p(higher),
    pTwoSided,
    method,
    permutations,
    minP,
    noise: noise(gs, baseUsd),
    verdict,
  };
}

/**
 * Two standard errors of the weighted difference, relative to base, from the
 * variance within each group (both sides pooled). null when a group has a
 * single run in all.
 */
function noise(gs: Sample[], baseUsd: number): number | null {
  if (baseUsd <= 0) return null;
  let v = 0;
  for (const g of gs) {
    const n = g.base.length + g.head.length;
    if (n < 3) return null;
    const ss = [g.base, g.head].reduce((s, xs) => {
      const m = meanOf(xs);
      return s + xs.reduce((t, x) => t + (x - m) ** 2, 0);
    }, 0);
    const variance = ss / (n - 2);
    v += g.weight ** 2 * variance * (1 / g.base.length + 1 / g.head.length);
  }
  return (2 * Math.sqrt(v)) / baseUsd;
}

/** Every value of the statistic over relabelings, or SAMPLES random ones (fixed seed) when there are too many. */
function permutationDistribution(gs: Sample[]): { values: number[]; method: "exact" | "sampled" } {
  let count = 1;
  for (const g of gs) {
    count *= binomial(g.base.length + g.head.length, g.head.length);
    if (count > EXACT_LIMIT) break;
  }
  if (count <= EXACT_LIMIT) {
    // Each group's relabelings contribute independently: combine their values.
    let values = [0];
    for (const g of gs) {
      const pool = [...g.base, ...g.head];
      const sum = pool.reduce((s, x) => s + x, 0);
      const k = g.head.length;
      const parts: number[] = [];
      for (const pick of combinations(pool.length, k)) {
        const headSum = pick.reduce((s, i) => s + pool[i]!, 0);
        parts.push(g.weight * (headSum / k - (sum - headSum) / (pool.length - k)));
      }
      const next: number[] = [];
      for (const v of values) for (const p of parts) next.push(v + p);
      values = next;
    }
    return { values, method: "exact" };
  }
  const random = mulberry32(0x6275726e);
  const values: number[] = [];
  for (let s = 0; s < SAMPLES; s++) {
    const shuffled = gs.map((g) => {
      const pool = [...g.base, ...g.head];
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [pool[i], pool[j]] = [pool[j]!, pool[i]!];
      }
      return { weight: g.weight, head: pool.slice(0, g.head.length), base: pool.slice(g.head.length) };
    });
    values.push(statistic(shuffled));
  }
  return { values, method: "sampled" };
}

function binomial(n: number, k: number): number {
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return Math.round(r);
}

/** Index sets of size k from 0..n-1. */
function* combinations(n: number, k: number): Generator<number[]> {
  const idx = Array.from({ length: k }, (_, i) => i);
  while (true) {
    yield idx.slice();
    let i = k - 1;
    while (i >= 0 && idx[i] === n - k + i) i--;
    if (i < 0) return;
    idx[i]!++;
    for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1]! + 1;
  }
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The CI gate: fail when the measured rise is above the threshold and the runs
 * show a rise clearly (one-sided p for any rise). It doesn't test that the
 * rise exceeds the threshold: with many runs, a measured 10.5% with a wide
 * spread fails a 10% gate. A rise the runs can't separate from noise passes.
 */
export function gate(r: DiffResult, failAbovePct: number): "fail" | "pass" | "unclear" | "can't tell" {
  const o = r.overall;
  if (!o || o.verdict === "can't tell") return "can't tell";
  if (o.change === null || o.change * 100 <= failAbovePct) return "pass";
  return o.pHigher < SIGNIFICANCE ? "fail" : "unclear";
}
