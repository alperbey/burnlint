import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { looksLikeClaudeCode, readClaudeCode } from "./adapters/claude-code.js";
import { looksLikeOtlp, readOtlp } from "./adapters/otlp.js";
import { cacheWriteTotal, type Finding, type Run, type Severity } from "./model.js";
import { callCost, PriceTable } from "./pricing.js";
import { defaultConfig, rules, type RuleConfig } from "./rules/index.js";

export interface RunSummary {
  id: string;
  file: string;
  source: string;
  agent?: string;
  session?: string;
  project?: string;
  calls: number;
  pricedCalls: number;
  /** Calls that returned an error (not priced). */
  failedCalls: number;
  costUsd: number;
  unpricedModels: string[];
  /** Models of the calls, sorted. */
  models: string[];
  /** Tokens over calls with usage: whole prompts (uncached, cache reads and writes), output, cache reads. */
  promptTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** Calls with usage but no cache information: the run's cache share is unknown. */
  cacheUnknownCalls: number;
  /** What the run was, for grouping (see Run.labels); `project` for Claude Code. */
  labels: Record<string, string>;
  notes: string[];
}

export interface AuditResult {
  files: number;
  /** Files that should have been readable and weren't, with the reason. */
  skippedFiles: string[];
  /** Files found while scanning a folder that aren't traces (an agent's settings, titles, ...). */
  ignoredFiles: string[];
  runs: RunSummary[];
  findings: Finding[];
  totalCostUsd: number;
  /** What the patterns found cost, trade-offs included. */
  findingsCostUsd: number;
  /** What no-loss fixes would have saved, net of their own cost. Trade-offs are not counted. */
  avoidableUsd: number;
  /** Cost per unit of work, over runs with at least one priced call. null when there are none. */
  perRun: PerRun | null;
  /** Runs left out of `perRun` because none of their calls could be priced. */
  excludedRuns: { failed: number; unpriced: number };
  /** Spend and avoidable spend at a stated volume. Only when one was given. */
  projection?: Projection;
  prices: { source: string; retrieved: string };
}

/**
 * A run here is a unit of work: a Claude Code session together with its
 * sub-agents, or one OTLP trace. Sub-agents are part of the task that started
 * them, so they don't count as runs of their own.
 */
export interface PerRun {
  count: number;
  meanUsd: number;
  medianUsd: number;
  /** Nearest-rank 90th percentile. */
  p90Usd: number;
  maxUsd: number;
  avoidableUsd: number;
  /** Avoidable spend as a share of all spend, 0-1. */
  avoidableShare: number;
  /** Counted runs with calls that couldn't be priced (failed or no usage): their cost is a lower bound. */
  incomplete: number;
}

export interface Projection {
  runsPerMonth: number;
  spendUsd: number;
  avoidableUsd: number;
}

export interface AuditOptions {
  prices?: PriceTable;
  config?: Partial<RuleConfig>;
  /** Only run these rule ids. */
  only?: string[];
  /** false: price runs without running any rule. */
  rules?: boolean;
  /** Expected volume, to project spend and avoidable spend to a month. */
  runsPerMonth?: number;
}

const SEVERITY_RANK: Record<Severity, number> = { high: 3, medium: 2, low: 1, info: 0 };
export const severityRank = (s: Severity) => SEVERITY_RANK[s];

/**
 * Trace files under `paths`. A named path that can't be read throws. Inside a
 * scanned folder, a sub-folder or trace file that can't be read (a dangling
 * symlink, no permission) is added to `unreadable` and the scan goes on.
 */
export function collectFiles(paths: string[], unreadable: string[] = []): string[] {
  const out: string[] = [];
  const isTrace = (p: string) => [".jsonl", ".json"].includes(extname(p));
  const reason = (e: unknown) => (e as NodeJS.ErrnoException).code ?? (e as Error).message;
  const walk = (p: string, named: boolean) => {
    let st;
    try {
      st = statSync(p);
    } catch (e) {
      if (named) throw e;
      if (isTrace(p)) unreadable.push(`${p} (${reason(e)})`);
      return;
    }
    if (st.isDirectory()) {
      let names: string[];
      try {
        names = readdirSync(p).sort();
      } catch (e) {
        if (named) throw e;
        unreadable.push(`${p} (${reason(e)})`);
        return;
      }
      for (const name of names) walk(join(p, name), false);
    } else if (isTrace(p)) {
      out.push(p);
    }
  };
  for (const p of paths) walk(p, true);
  return out;
}

function head(file: string, bytes = 65536): string {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

export function loadRuns(file: string): Run[] | null {
  const text = head(file);
  if (looksLikeOtlp(text)) return readOtlp(file);
  if (looksLikeClaudeCode(text.split("\n").slice(0, 20))) return readClaudeCode(file);
  return null;
}

export function audit(paths: string[], opts: AuditOptions = {}): AuditResult {
  const prices = opts.prices ?? new PriceTable();
  const config = { ...defaultConfig, ...opts.config };
  const active = opts.rules === false ? [] : opts.only?.length ? rules.filter((r) => opts.only!.includes(r.id)) : rules;

  const skippedFiles: string[] = [];
  const files = collectFiles(paths, skippedFiles);
  const named = new Set(paths.filter((p) => statSync(p).isFile()));
  const ignoredFiles: string[] = [];
  const summaries: RunSummary[] = [];
  const findings: Finding[] = [];

  for (const file of files) {
    let runs: Run[] | null;
    try {
      runs = loadRuns(file);
    } catch (e) {
      skippedFiles.push(`${file} (${(e as Error).message})`);
      continue;
    }
    if (!runs) {
      if (named.has(file)) skippedFiles.push(`${file} (unrecognized format)`);
      else ignoredFiles.push(file);
      continue;
    }
    for (const run of runs) {
      let cost = 0;
      let priced = 0;
      let failed = 0;
      const unpriced = new Set<string>();
      const models = new Set<string>();
      const tok = { prompt: 0, output: 0, cacheRead: 0, cacheUnknown: 0 };
      for (const t of run.turns) {
        if (t.call.model) models.add(t.call.model);
        const k = t.call.tokens;
        if (k) {
          tok.prompt += (k.input ?? 0) + (k.cacheRead ?? 0) + cacheWriteTotal(k);
          tok.output += k.output ?? 0;
          tok.cacheRead += k.cacheRead ?? 0;
          if (!k.cacheKnown) tok.cacheUnknown++;
        }
        const c = callCost(t.call, prices);
        if (c != null) {
          cost += c;
          priced++;
        } else if (t.call.failed) {
          failed++;
        } else if (t.call.tokens && t.call.model) {
          unpriced.add(t.call.model);
        }
      }
      summaries.push({
        id: run.id,
        file: run.file,
        source: run.source,
        agent: run.agent,
        session: run.session,
        project: run.project,
        calls: run.turns.length,
        pricedCalls: priced,
        failedCalls: failed,
        costUsd: cost,
        unpricedModels: [...unpriced],
        models: [...models].sort(),
        promptTokens: tok.prompt,
        outputTokens: tok.output,
        cacheReadTokens: tok.cacheRead,
        cacheUnknownCalls: tok.cacheUnknown,
        labels: { ...run.labels, ...(run.project ? { project: run.project } : {}) },
        notes: run.notes,
      });
      for (const rule of active) findings.push(...rule.check(run, { prices, config }));
    }
  }

  findings.sort(
    (a, b) =>
      severityRank(b.severity) - severityRank(a.severity) ||
      (b.avoidableUsd ?? -Infinity) - (a.avoidableUsd ?? -Infinity) ||
      (b.costUsd ?? -1) - (a.costUsd ?? -1),
  );

  const totalCostUsd = summaries.reduce((s, r) => s + r.costUsd, 0);
  const avoidableUsd = findings.reduce((s, f) => s + (f.avoidableUsd ?? 0), 0);
  const { perRun, excludedRuns } = perRunCosts(summaries, totalCostUsd, avoidableUsd);
  const n = opts.runsPerMonth;
  return {
    files: files.length,
    skippedFiles,
    ignoredFiles,
    runs: summaries,
    findings,
    totalCostUsd,
    findingsCostUsd: findings.reduce((s, f) => s + (f.costUsd ?? 0), 0),
    avoidableUsd,
    perRun,
    excludedRuns,
    ...(n != null && perRun ? { projection: { runsPerMonth: n, spendUsd: perRun.meanUsd * n, avoidableUsd: perRun.avoidableUsd * n } } : {}),
    prices: { source: prices.source, retrieved: prices.retrieved },
  };
}

/** The unit a run summary belongs to: its session (sub-agents share their parent's), else itself. */
export const unitOf = (r: RunSummary) => r.session ?? r.id;

/** Run summaries gathered into units of work, in first-seen order. */
export function unitsOf(summaries: RunSummary[]): RunSummary[][] {
  const units = new Map<string, RunSummary[]>();
  for (const r of summaries) {
    if (!units.has(unitOf(r))) units.set(unitOf(r), []);
    units.get(unitOf(r))!.push(r);
  }
  return [...units.values()];
}

/**
 * Runs with no priced call are left out: a run that failed before its first
 * answer would otherwise count as a $0 run and pull the median down. They are
 * counted separately, as failed (a call returned an error) or unpriced.
 */
function perRunCosts(
  summaries: RunSummary[],
  total: number,
  avoidable: number,
): { perRun: PerRun | null; excludedRuns: AuditResult["excludedRuns"] } {
  const sum = (rs: RunSummary[], f: (r: RunSummary) => number) => rs.reduce((s, r) => s + f(r), 0);
  const all = unitsOf(summaries).map((rs) => ({
    cost: sum(rs, (r) => r.costUsd),
    calls: sum(rs, (r) => r.calls),
    priced: sum(rs, (r) => r.pricedCalls),
    failed: sum(rs, (r) => r.failedCalls),
  }));
  const counted = all.filter((u) => u.priced > 0);
  const excluded = all.filter((u) => u.priced === 0);
  const excludedRuns = { failed: excluded.filter((u) => u.failed > 0).length, unpriced: excluded.filter((u) => u.failed === 0).length };
  if (!counted.length) return { perRun: null, excludedRuns };
  const costs = counted.map((u) => u.cost).sort((a, b) => a - b);
  const count = costs.length;
  const mid = count >> 1;
  return {
    perRun: {
      count,
      meanUsd: total / count,
      medianUsd: count % 2 ? costs[mid]! : (costs[mid - 1]! + costs[mid]!) / 2,
      p90Usd: costs[Math.ceil(0.9 * count) - 1]!,
      maxUsd: costs[count - 1]!,
      avoidableUsd: avoidable / count,
      avoidableShare: total > 0 ? avoidable / total : 0,
      incomplete: counted.filter((u) => u.priced < u.calls).length,
    },
    excludedRuns,
  };
}
