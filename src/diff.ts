import { audit, unitOf, unitsOf, type AuditOptions, type AuditResult, type RunSummary } from "./audit.js";
import { outcomeId, type Outcomes } from "./outcomes.js";

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
  /** Only when an outcomes file was given. */
  success?: SuccessDiff;
  prices: AuditResult["prices"];
}

export interface SuccessCounts {
  /** Units of work, counted for cost or not: a run that failed before any priced call is still a run. */
  runs: number;
  /** Runs with an outcome. */
  known: number;
  passed: number;
}

export interface SuccessGroup {
  name: string;
  /** Share of base's runs (in groups on both sides). */
  weight: number;
  base: SuccessCounts;
  head: SuccessCounts;
}

/**
 * Success rate before and after, from the user's outcomes. Every run counts,
 * including those cost per run leaves out (no priced call): they are the
 * likeliest failures. Tested like cost, on failures (0/1) instead of dollars.
 */
export interface SuccessDiff {
  file: string;
  /** Rows naming no run on either side. */
  unmatchedRows: number;
  base: SuccessCounts;
  head: SuccessCounts;
  /** Groups with runs on both sides, in base order. */
  groups: SuccessGroup[];
  /** Pass rates over runs with an outcome, at base's mix of groups; null with no group on both sides. */
  baseRate: number | null;
  headRate: number | null;
  /** headRate - baseRate, as a share (-0.33 is 33 points lower). */
  change: number | null;
  /**
   * Spend per pass at base's mix: everything spent on runs with an outcome,
   * failed runs included, divided by the passes. null with no passes.
   */
  costPerSuccess: { baseUsd: number | null; headUsd: number | null; lowerBound: boolean };
  test: DiffTest;
  /** One-sided p that head passes less often; two-sided p for any change. */
  pDrop: number;
  pTwoSided: number;
  minP: number;
  method: "exact" | "sampled";
  permutations: number;
  /** "lower" means head succeeds less often. "can't tell" when a compared run has no outcome. */
  verdict: Verdict;
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
   * How a rise is judged: "two-sided" (pTwoSided), or "rise" (pHigher) when a
   * CI gate tests for a rise, so the verdict and the gate agree. A fall is
   * always judged two-sided.
   */
  test: DiffTest;
  /**
   * About two standard errors of the change, as a share of base: changes
   * within it are run-to-run noise. null when a group has one run on both sides.
   */
  noise: number | null;
  verdict: Verdict;
}

export type Verdict = "higher" | "lower" | "no clear change" | "too few runs" | "can't tell";
export type DiffTest = "two-sided" | "rise";

export interface DiffOptions extends AuditOptions {
  /** Label key to group runs by. Default: gen_ai.agent.name, else project, else one group. */
  groupBy?: string;
  /** "rise" when a gate (--fail-above) is set: a rise is then judged one-sided, as the gate judges it. */
  test?: DiffTest;
  /** "rise" when --fail-success-drop is set: a drop in success is then judged one-sided. */
  successTest?: DiffTest;
}

export const DEFAULT_GROUP_KEYS = ["gen_ai.agent.name", "project"];
export const SIGNIFICANCE = 0.05;
const EXACT_LIMIT = 200_000;
const SAMPLES = 20_000;

interface Unit {
  group: string;
  /** What an outcomes file names it by. */
  id: string;
  pass?: boolean;
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
  // A key the user groups by is kept even if its name looks like content (`bench.input_id`).
  const auditOpts = { ...opts, rules: false, allowLabels: opts.groupBy === undefined ? undefined : [opts.groupBy] };
  const a = audit(basePaths, auditOpts);
  const b = audit(headPaths, auditOpts);
  return compare(a.runs, b.runs, { ...opts, basePaths, headPaths, prices: a.prices });
}

/** Thrown for a grouping key no run carries: a typo would otherwise compare everything as one group. */
export class GroupKeyError extends Error {}

export function compare(
  baseRuns: RunSummary[],
  headRuns: RunSummary[],
  opts: {
    groupBy?: string;
    test?: DiffTest;
    successTest?: DiffTest;
    outcomes?: Outcomes;
    basePaths?: string[];
    headPaths?: string[];
    prices?: AuditResult["prices"];
  } = {},
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
    result.overall = overall(samples, result.base.unpriced + result.head.unpriced > 0, opts.test);
  }
  if (opts.outcomes) result.success = success(base, head, opts.outcomes, opts.successTest);
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
    const pass = rs.find((r) => r.pass !== undefined)?.pass;
    return {
      group: groupBy === undefined ? "all runs" : (label(main, groupBy) ?? `(no ${groupBy})`),
      id: outcomeId(main),
      ...(pass === undefined ? {} : { pass }),
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
export function overall(gs: Sample[], cantTell: boolean, test: DiffTest = "two-sided"): Overall {
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
  const pHigher = p(higher);
  // One-sided, the smallest p is the share of relabelings at the top alone.
  const top = values.reduce((m, v) => Math.max(m, v), -Infinity);
  const minPRise = method === "exact" ? values.filter((v) => v >= top - eps).length / values.length : 1 / (SAMPLES + 1);
  const rise = test === "rise";

  let verdict: Verdict;
  if (cantTell) verdict = "can't tell";
  else if ((rise ? Math.min(minP, minPRise) : minP) >= SIGNIFICANCE) verdict = "too few runs";
  else if (observed > 0 && (rise ? pHigher : pTwoSided) < SIGNIFICANCE) verdict = "higher";
  else if (observed < 0 && pTwoSided < SIGNIFICANCE) verdict = "lower";
  else verdict = "no clear change";

  return {
    baseUsd,
    headUsd,
    change,
    pHigher,
    pTwoSided,
    method,
    permutations,
    minP,
    test,
    noise: noise(gs, baseUsd),
    verdict,
  };
}

/**
 * Success before and after. Groups are those with runs on both sides (counted
 * for cost or not), weighted by base's runs. The test runs on failures, so a
 * rise in failures is the one-sided case, as for cost.
 */
function success(base: Unit[], head: Unit[], o: Outcomes, test: DiffTest = "two-sided"): SuccessDiff {
  const counts = (us: Unit[]): SuccessCounts => ({
    runs: us.length,
    known: us.filter((u) => u.pass !== undefined).length,
    passed: us.filter((u) => u.pass).length,
  });
  const ids = new Set([...base, ...head].filter((u) => u.pass !== undefined).map((u) => u.id));
  const names = [...new Set(base.map((u) => u.group))].filter((g) => head.some((u) => u.group === g));
  const inGroup = (us: Unit[], g: string) => us.filter((u) => u.group === g);
  const total = base.filter((u) => names.includes(u.group)).length;
  const groups: SuccessGroup[] = names.map((name) => ({
    name,
    weight: inGroup(base, name).length / total,
    base: counts(inGroup(base, name)),
    head: counts(inGroup(head, name)),
  }));
  const compared = [...base, ...head].filter((u) => names.includes(u.group));
  const unknown = compared.some((u) => u.pass === undefined);
  const known = (us: Unit[]) => us.filter((u) => u.pass !== undefined);
  // Every group needs a run with an outcome on both sides to have a rate.
  const rated = groups.every((g) => g.base.known && g.head.known) && groups.length > 0;

  const rate = (side: "base" | "head") =>
    rated ? groups.reduce((s, g) => s + g.weight * (g[side].passed / g[side].known), 0) : null;
  const baseRate = rate("base");
  const headRate = rate("head");
  const perSuccess = (us: Unit[]) => {
    if (!rated) return null;
    let spend = 0;
    let passes = 0;
    for (const g of groups) {
      const k = known(inGroup(us, g.name));
      spend += (g.weight * k.reduce((s, u) => s + u.cost, 0)) / k.length;
      passes += (g.weight * k.filter((u) => u.pass).length) / k.length;
    }
    return passes > 0 ? spend / passes : null;
  };

  const samples = rated
    ? groups.map((g) => ({
        weight: g.weight,
        base: known(inGroup(base, g.name)).map((u) => (u.pass ? 0 : 1)),
        head: known(inGroup(head, g.name)).map((u) => (u.pass ? 0 : 1)),
      }))
    : [];
  const t = samples.length ? overall(samples, unknown, test) : null;
  const flip: Record<Verdict, Verdict> = { higher: "lower", lower: "higher", "no clear change": "no clear change", "too few runs": "too few runs", "can't tell": "can't tell" };
  const change = baseRate != null && headRate != null ? headRate - baseRate : null;
  let verdict: Verdict = t ? flip[t.verdict] : "can't tell";
  // Nothing moved: don't call that "too few runs".
  if (change === 0 && verdict === "too few runs") verdict = "no clear change";
  return {
    file: o.file,
    unmatchedRows: [...o.rows.keys()].filter((id) => !ids.has(id)).length,
    base: counts(base),
    head: counts(head),
    groups,
    baseRate,
    headRate,
    change,
    costPerSuccess: {
      baseUsd: perSuccess(base),
      headUsd: perSuccess(head),
      lowerBound: known(compared).some((u) => u.failed || u.unpriced),
    },
    test,
    pDrop: t?.pHigher ?? 1,
    pTwoSided: t?.pTwoSided ?? 1,
    minP: t?.minP ?? 1,
    method: t?.method ?? "exact",
    permutations: t?.permutations ?? 0,
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

/**
 * The success gate: fail when success fell more than `points` percentage
 * points and the runs show a drop clearly (one-sided p < 0.05). "too few runs"
 * when no drop these runs could show would be clear: passing, with a warning,
 * since 3 runs a group can never show one.
 */
export function successGate(r: DiffResult, points: number): "fail" | "pass" | "unclear" | "too few runs" | "can't tell" {
  const s = r.success;
  if (!s || s.verdict === "can't tell" || s.change === null) return "can't tell";
  if (-s.change * 100 <= points) return "pass";
  if (s.pDrop < SIGNIFICANCE) return "fail";
  return s.verdict === "too few runs" ? "too few runs" : "unclear";
}
