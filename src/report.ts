import { homedir } from "node:os";
import { basename, extname, relative, sep } from "node:path";
import type { AuditResult, RunSummary } from "./audit.js";
import type { Finding } from "./model.js";

const usd = (n: number | null): string =>
  n == null ? "?" : n < 0 ? `-${usd(-n)}` : n >= 100 ? `$${n.toFixed(0)}` : n >= 1 ? `$${n.toFixed(2)}` : n >= 0.01 ? `$${n.toFixed(3)}` : n > 0 ? `$${n.toFixed(4)}` : "$0";
const usdTotal = (n: number) =>
  n >= 1 ? `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : usd(n);
const int = (n: number | null) => (n == null ? "?" : n.toLocaleString("en-US"));
const short = (p: string) => {
  const r = relative(process.cwd(), p);
  if (!r.startsWith("..")) return r;
  const home = homedir();
  return p.startsWith(home + sep) ? "~" + p.slice(home.length) : p;
};
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const SAVABLE_LEGEND = [
  "savable    what the fix would have saved, net of its own cost. Counted only when the fix takes nothing away from the model.",
  "trade-off  the fix changes what the model sees or which model runs. Quality may change, so it isn't counted as avoidable.",
  "info       a trade-off, or nothing to gain. Never fails --fail-on.",
];

export function renderJson(r: AuditResult): string {
  return JSON.stringify(r, null, 2);
}

export interface TableOptions {
  color?: boolean;
  verbose?: boolean;
  /** Terminal width. Findings wrap to it; without one each finding stays on one line. */
  width?: number;
}

export function renderTable(r: AuditResult, opts: TableOptions = {}): string {
  const c = (code: string, s: string) => (opts.color && s ? `\x1b[${code}m${s}\x1b[0m` : s);
  const dim = (s: string) => c("2", s);
  const runs = new Map(r.runs.map((run) => [run.id, run]));
  const out: string[] = [];

  out.push(`${c("1", "burnlint")}  ${dim(`${runsSummary(r)}`)}`);
  out.push("");
  for (const [label, value, note] of totalLines(r)) {
    const lead = `  ${label.padEnd(12)} ${value}   `;
    const styledLead = `  ${label.padEnd(12)} ${label === "avoidable" ? c("1", value) : value}   `;
    hanging(lead, note, opts.width).forEach((l, i) => out.push(i ? dim(l) : styledLead + dim(l.slice(lead.length))));
  }
  out.push("");

  if (!r.findings.length) {
    out.push("No findings.");
  } else {
    // Findings grouped under the run they came from, as a linter groups by file.
    // Columns are sized over all findings so every group lines up.
    const cells = (f: Finding) => [f.severity, savable(f), usd(f.costUsd), f.rule];
    const right = [false, true, true, false];
    const w = [0, 1, 2, 3].map((i) => Math.max(...r.findings.map((f) => cells(f)[i]!.length)));
    const pad = (s: string, i: number) => (right[i] ? s.padStart(w[i]!) : s.padEnd(w[i]!));
    const indent = 2 + w.reduce((s, x) => s + x + 2, 0);
    const room = opts.width ? Math.max(30, opts.width - indent - 1) : Infinity;
    const cont = " ".repeat(indent);

    for (const g of groupByRun(r.findings)) {
      const run = runs.get(g.runId);
      const sum = g.findings.reduce((s, f) => s + Math.max(0, f.avoidableUsd ?? 0), 0);
      const cost = g.findings.reduce((s, f) => s + (f.costUsd ?? 0), 0);
      const where = opts.verbose ? `  ${dim(short(g.findings[0]!.file))}` : "";
      out.push(`${c("1;36", runLabel(run, g.findings[0]!))}  ${dim(`${usd(sum)} savable of ${usd(cost)}`)}${where}`);
      for (const f of g.findings) {
        const styled = cells(f).map((s, i) => {
          const p = pad(s, i);
          if (i === 0) return c(SEV_COLOR[f.severity]!, p);
          if (i === 1) return c(f.fix === "trade-off" || (f.avoidableUsd ?? 0) <= 0 ? "2" : "32", p);
          if (i === 3) return dim(p);
          return p;
        });
        const [first, ...more] = wrap(f.message, room);
        out.push(["", ...styled, first].join("  "));
        for (const line of more) out.push(cont + line);
        if (opts.verbose) for (const d of f.details ?? []) for (const line of wrap(d, room - 2)) out.push(cont + dim("· " + line));
      }
      out.push("");
    }
    out.pop();
  }

  const notes = noteLines(r, runs, !!opts.verbose);
  if (notes.length) {
    out.push("");
    out.push(dim("Notes"));
    for (const n of notes) out.push(...hanging("  - ", n, opts.width).map(dim));
  }
  out.push("");
  if (r.findings.length)
    for (const line of SAVABLE_LEGEND) {
      const [, term, text] = /^(\S+\s+)(.*)$/.exec(line)!;
      out.push(...hanging(term!, text!, opts.width).map(dim));
    }
  out.push(...hanging("", `Costs are estimates. Prices: ${r.prices.source}, retrieved ${r.prices.retrieved}.`, opts.width).map(dim));
  return out.join("\n");
}

/** `lead` then `text` wrapped to the width, continuation lines indented under the text. */
function hanging(lead: string, text: string, width?: number): string[] {
  const lines = wrap(text, width ? Math.max(30, width - lead.length - 1) : Infinity);
  return lines.map((l, i) => (i ? " ".repeat(lead.length) : lead) + l);
}

const SEV_COLOR: Record<string, string> = { high: "1;31", medium: "33", low: "0", info: "2" };

export function renderMarkdown(r: AuditResult): string {
  const runs = new Map(r.runs.map((run) => [run.id, run]));
  const out: string[] = [];
  out.push(`### burnlint`);
  out.push("");
  out.push(runsSummary(r));
  out.push("");
  out.push("| | Total | |");
  out.push("|---|--:|---|");
  for (const [label, value, note] of totalLines(r)) out.push(`| ${label} | **${value.trim()}** | ${escapeMd(note)} |`);
  out.push("");
  if (!r.findings.length) {
    out.push("No findings.");
  } else {
    out.push("| Severity | Savable | Cost | Rule | Run | Finding |");
    out.push("|---|--:|--:|---|---|---|");
    for (const f of r.findings) {
      out.push(
        `| ${f.severity} | ${savable(f)} | ${usd(f.costUsd)} | \`${f.rule}\` | ${escapeMd(runLabel(runs.get(f.runId), f))} | ${escapeMd(f.message)} |`,
      );
    }
  }
  const notes = noteLines(r, runs, true);
  if (notes.length) {
    out.push("");
    out.push("<details><summary>Notes</summary>");
    out.push("");
    for (const n of notes) out.push(`- ${escapeMd(n)}`);
    out.push("");
    out.push("</details>");
  }
  out.push("");
  if (r.findings.length) out.push(`<sub>${SAVABLE_LEGEND.map((l) => escapeMd(l.replace(/\s{2,}/, ": "))).join("<br>")}</sub>`);
  out.push("");
  out.push(`<sub>Costs are estimates. Prices: ${r.prices.source}, retrieved ${r.prices.retrieved}.</sub>`);
  return out.join("\n");
}

/**
 * "12 runs in 1 file", plus runs left out of cost per run (no priced call) and
 * counted runs whose cost is a lower bound.
 */
function runsSummary(r: AuditResult): string {
  const parts = [`${plural(r.perRun?.count ?? 0, "run")} in ${plural(r.files - r.ignoredFiles.length, "file")}`];
  const { failed, unpriced } = r.excludedRuns;
  const left = [failed ? `${failed} failed` : "", unpriced ? `${unpriced} with no usage data` : ""].filter(Boolean);
  if (left.length) parts.push(`not counted: ${left.join(", ")}`);
  const part = r.perRun?.incomplete ?? 0;
  if (part) parts.push(`${plural(part, "run")} priced in part (lower bound)`);
  return parts.join(" · ");
}

/** The header block: label, value padded to a common width, and what it means per run. */
function totalLines(r: AuditResult): Array<[string, string, string]> {
  const p = r.perRun;
  const lines: Array<[string, string, string]> = [
    ["spent", usdTotal(r.totalCostUsd), p ? `${usd(p.meanUsd)} per run · median ${usd(p.medianUsd)} · p90 ${usd(p.p90Usd)} · max ${usd(p.maxUsd)}` : ""],
    ["in findings", usdTotal(r.findingsCostUsd), plural(r.findings.length, "finding")],
    [
      "avoidable",
      usdTotal(r.avoidableUsd),
      p ? `${usd(p.avoidableUsd)} per run, ${pct(p.avoidableShare)} of spend, without taking anything away from the model` : "",
    ],
  ];
  if (r.projection) {
    const { runsPerMonth, spendUsd, avoidableUsd } = r.projection;
    lines.push(["per month", usdTotal(spendUsd), `at ${int(runsPerMonth)} runs, ${usdTotal(avoidableUsd)} of it avoidable`]);
  }
  const w = Math.max(...lines.map((l) => l[1].length));
  return lines.map(([label, value, note]) => [label, value.padStart(w), note]);
}

const pct = (share: number) => (share > 0 && share < 0.001 ? "<0.1%" : `${(share * 100).toFixed(1)}%`);

/** Runs in order of what fixing them would save, then cost; findings keep their order inside. */
function groupByRun(findings: Finding[]): Array<{ runId: string; findings: Finding[] }> {
  const groups = new Map<string, Finding[]>();
  for (const f of findings) {
    if (!groups.has(f.runId)) groups.set(f.runId, []);
    groups.get(f.runId)!.push(f);
  }
  const score = (fs: Finding[]) => [
    fs.reduce((s, f) => s + Math.max(0, f.avoidableUsd ?? 0), 0),
    fs.reduce((s, f) => s + (f.costUsd ?? 0), 0),
  ];
  return [...groups]
    .map(([runId, fs]) => ({ runId, findings: fs, score: score(fs) }))
    .sort((a, b) => b.score[0]! - a.score[0]! || b.score[1]! - a.score[1]!);
}

function savable(f: Finding): string {
  return f.fix === "trade-off" ? "trade-off" : usd(f.avoidableUsd);
}

/** "web 20b66dcc", "web 20b66dcc sub-agent a8444de", "record-demo-agent 6710e2d0": where to look, in a few words. */
function runLabel(run: RunSummary | undefined, f: Finding): string {
  const [base, rest] = f.runId.split("#");
  const where = run?.project ?? run?.agent ?? basename(f.file, extname(f.file));
  const id = (run?.session ?? rest ?? base ?? "").slice(0, 8);
  const sub = run?.project && run.agent ? ` sub-agent ${run.agent.replace(/^agent-/, "").slice(0, 7)}` : "";
  return `${where} ${id}${sub}`;
}

/**
 * Data-quality notes. The same note from many runs ("N of M calls have no
 * usage") is shown once with a count unless verbose.
 */
function noteLines(r: AuditResult, runs: Map<string, RunSummary>, verbose: boolean): string[] {
  const groups = new Map<string, string[]>();
  for (const run of r.runs) {
    for (const n of run.notes) {
      const key = n.replace(/\d[\d,.]*/g, "#");
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(`${runLabel(runs.get(run.id), { runId: run.id, file: run.file } as Finding)}: ${n}`);
    }
  }
  const out: string[] = [];
  for (const lines of groups.values()) {
    if (verbose || lines.length === 1) out.push(...lines);
    else out.push(`${lines[0]}, and the same in ${plural(lines.length - 1, "more run")} (-v lists them)`);
  }
  const unpriced = [...new Set(r.runs.flatMap((run) => run.unpricedModels))];
  if (unpriced.length) out.push(`no price for model(s): ${unpriced.join(", ")} (add them with --prices)`);
  if (r.skippedFiles.length)
    out.push(`${plural(r.skippedFiles.length, "file")} could not be read${verbose ? ": " + r.skippedFiles.map(short).join(", ") : " (-v lists them)"}`);
  if (verbose && r.ignoredFiles.length) out.push(`${plural(r.ignoredFiles.length, "file")} in the scanned folders are not traces and were ignored`);
  return out;
}

/** Splits text into lines of at most `width` characters, at spaces where possible. */
function wrap(text: string, width: number): string[] {
  if (text.length <= width) return [text];
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (!line) line = word;
    else if (line.length + 1 + word.length <= width) line += " " + word;
    else {
      lines.push(line);
      line = word;
    }
    while (line.length > width) {
      lines.push(line.slice(0, width));
      line = line.slice(width);
    }
  }
  if (line) lines.push(line);
  return lines;
}

function escapeMd(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
