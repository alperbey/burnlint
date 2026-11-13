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
  calls: number;
  pricedCalls: number;
  costUsd: number;
  unpricedModels: string[];
  notes: string[];
}

export interface AuditResult {
  files: number;
  skippedFiles: string[];
  runs: RunSummary[];
  findings: Finding[];
  totalCostUsd: number;
  /** What the patterns found cost, trade-offs included. */
  findingsCostUsd: number;
  /** What no-loss fixes would have saved, net of their own cost. Trade-offs are not counted. */
  avoidableUsd: number;
  prices: { source: string; retrieved: string };
}

export interface AuditOptions {
  prices?: PriceTable;
  config?: Partial<RuleConfig>;
  /** Only run these rule ids. */
  only?: string[];
}

const SEVERITY_RANK: Record<Severity, number> = { high: 3, medium: 2, low: 1 };
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
  const skippedFiles: string[] = [];
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
      skippedFiles.push(`${file} (unrecognized format)`);
      continue;
    }
    for (const run of runs) {
      let cost = 0;
      let priced = 0;
      const unpriced = new Set<string>();
      for (const t of run.turns) {
        const c = callCost(t.call, prices);
        if (c != null) {
          cost += c;
          priced++;
        } else if (t.call.tokens && t.call.model) {
          unpriced.add(t.call.model);
        }
      }
      summaries.push({
        id: run.id,
        file: run.file,
        source: run.source,
        agent: run.agent,
        calls: run.turns.length,
        pricedCalls: priced,
        costUsd: cost,
        unpricedModels: [...unpriced],
        notes: run.notes,
      });
      for (const rule of active) findings.push(...rule.check(run, { prices, config }));
    }
  }

  findings.sort(
    (a, b) => severityRank(b.severity) - severityRank(a.severity) || (b.costUsd ?? -1) - (a.costUsd ?? -1),
  );

  return {
    files: files.length,
    skippedFiles,
    runs: summaries,
    findings,
    totalCostUsd: summaries.reduce((s, r) => s + r.costUsd, 0),
    findingsCostUsd: findings.reduce((s, f) => s + (f.costUsd ?? 0), 0),
    avoidableUsd: findings.reduce((s, f) => s + (f.avoidableUsd ?? 0), 0),
    prices: { source: prices.source, retrieved: prices.retrieved },
  };
}
