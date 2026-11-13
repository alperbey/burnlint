import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { looksLikeClaudeCode, readClaudeCode } from "./adapters/claude-code.js";
import { looksLikeOtlp, readOtlp } from "./adapters/otlp.js";
import type { Finding, Run, Severity } from "./model.js";
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
  /** Expected volume, to project spend and avoidable spend to a month. */
  runsPerMonth?: number;
}

const SEVERITY_RANK: Record<Severity, number> = { high: 3, medium: 2, low: 1, info: 0 };
export const severityRank = (s: Severity) => SEVERITY_RANK[s];

export function collectFiles(paths: string[]): string[] {
  const out: string[] = [];
  const walk = (p: string) => {
    const st = statSync(p);
    if (st.isDirectory()) {
      for (const name of readdirSync(p).sort()) walk(join(p, name));
    } else if ([".jsonl", ".json"].includes(extname(p))) {
      out.push(p);
    }
  };
  for (const p of paths) walk(p);
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
  const active = opts.only?.length ? rules.filter((r) => opts.only!.includes(r.id)) : rules;

  const files = collectFiles(paths);
  const named = new Set(paths.filter((p) => statSync(p).isFile()));
  const skippedFiles: string[] = [];
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
      for (const t of run.turns) {
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
  const units = new Map<string, { cost: number; calls: number; priced: number; failed: number }>();
  for (const r of summaries) {
    const u = units.get(unitOf(r)) ?? { cost: 0, calls: 0, priced: 0, failed: 0 };
    u.cost += r.costUsd;
    u.calls += r.calls;
    u.priced += r.pricedCalls;
    u.failed += r.failedCalls;
    units.set(unitOf(r), u);
  }
  const all = [...units.values()];
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
