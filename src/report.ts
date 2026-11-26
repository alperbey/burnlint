import { homedir } from "node:os";
import { basename, extname, relative, sep } from "node:path";
import type { AuditResult, RunSummary } from "./audit.js";
import { SIGNIFICANCE, type DiffResult } from "./diff.js";
import type { Finding } from "./model.js";
import { escapeMd, plainDeep } from "./text.js";

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

export function renderTable(result: AuditResult, opts: TableOptions = {}): string {
  const r = plainDeep(result);
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

export function renderMarkdown(result: AuditResult): string {
  const r = plainDeep(result);
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
  const o = r.outcomes;
  if (o) {
    const parts = o.known
      ? [`${o.passed} of ${plural(o.known, "run")} passed (${pct(o.successRate!)})`, o.passed ? `${usd(o.costUsd)} on those ${o.known} ÷ ${o.passed} passes, failed runs included` : `${usd(o.costUsd)} spent on ${o.known === 1 ? "it" : "them"}`]
      : [`no run here has an outcome in ${short(o.file)}`];
    if (o.known && o.known < o.runs) parts.push(`no outcome for ${o.runs - o.known} of ${o.runs}`);
    if (o.incomplete) parts.push(`lower bound: ${plural(o.incomplete, "run")} priced in part`);
    lines.push(["per success", o.costPerSuccessUsd == null ? (o.known ? "no passes" : "?") : usdTotal(o.costPerSuccessUsd), parts.join(" · ")]);
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
  if (r.outcomes?.unmatchedRows) out.push(`${plural(r.outcomes.unmatchedRows, "row")} in ${short(r.outcomes.file)} name no run here`);
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

// --- diff ---------------------------------------------------------------------

const signedPct = (x: number | null) => {
  if (x == null) return "?";
  const v = x * 100;
  const s = Math.abs(v) < 10 ? v.toFixed(1) : v.toFixed(0);
  return `${v >= 0 ? "+" : ""}${s}%`;
};
// Near the 0.05 line, two decimals would show a clear p=0.0496 as p=0.05: show three.
const pValue = (p: number) => (p < 0.001 ? "p<0.001" : `p=${p.toFixed(p < 0.01 || (p >= 0.045 && p < 0.055) ? 3 : 2)}`);

export function renderDiffJson(r: DiffResult): string {
  return JSON.stringify(r, null, 2);
}

/** The verdict in one line, without the numbers before it. */
export function verdictLine(r: DiffResult): string {
  const o = r.overall;
  if (!o) return "nothing to compare: no group has priced runs on both sides";
  const ch = signedPct(o.change);
  // A rise under a gate is judged one-sided, like the gate; everything else two-sided.
  const oneSided = o.test === "rise" && (o.change ?? 0) > 0;
  const p = oneSided ? `one-sided ${pValue(o.pHigher)}` : pValue(o.pTwoSided);
  switch (o.verdict) {
    case "higher":
      return `higher, ${ch} (${p})`;
    case "lower":
      return `lower, ${ch} (${p})`;
    case "no clear change":
      // Near the line, don't call it noise: the runs just can't show it either way.
      return (oneSided ? o.pHigher : o.pTwoSided) < 0.1
        ? `no clear change: ${ch}, not clearly beyond run-to-run noise (${p})`
        : `no clear change: ${ch} is within run-to-run noise (${p})`;
    case "too few runs":
      return (
        `too few runs to tell (${ch}): no difference these runs could show would reach p<${SIGNIFICANCE}` +
        (r.groups.length === 1 && r.groups[0]!.base.runs + r.groups[0]!.head.runs < 8
          ? `. Run more, or label each run with its task (a root-span attribute) and use --group-by: groups of the same task vary less`
          : "")
      );
    case "can't tell": {
      const n = r.base.unpriced + r.head.unpriced;
      return `can't tell: ${plural(n, "run")} with calls that have no price or no usage, so their cost is unknown`;
    }
  }
}

const signedPoints = (x: number | null) => {
  if (x == null) return "?";
  const v = x * 100;
  const s = Math.abs(v) < 10 && v !== Math.round(v) ? v.toFixed(1) : v.toFixed(0);
  return `${v > 0 ? "+" : ""}${s} points`;
};

/** The success verdict in one line. */
export function successVerdictLine(r: DiffResult): string {
  const s = r.success;
  if (!s) return "";
  if (!s.groups.length) return "nothing to compare: no group has runs on both sides";
  const ch = signedPoints(s.change);
  const oneSided = s.test === "rise" && (s.change ?? 0) < 0;
  const p = oneSided ? `one-sided ${pValue(s.pDrop)}` : pValue(s.pTwoSided);
  switch (s.verdict) {
    case "higher":
      return `higher, ${ch} (${p})`;
    case "lower":
      return `lower, ${ch} (${p})`;
    case "no clear change":
      return s.change === 0 ? `no change` : `no clear change: ${ch}, not clearly beyond chance (${p})`;
    case "too few runs":
      return (
        `too few runs to tell (${ch}): no change these runs could show would reach p<${SIGNIFICANCE}; ` +
        `run more, or group by input (--group-by)`
      );
    case "can't tell": {
      const compared = s.groups.reduce((n, g) => n + g.base.runs + g.head.runs - g.base.known - g.head.known, 0);
      return compared
        ? `can't tell: ${plural(compared, "compared run")} with no outcome in ${short(s.file)}`
        : `can't tell: a group has no run with an outcome on one side`;
    }
  }
}

/** The cost-per-success verdict in one line (two-sided: no gate uses it). */
export function costPerSuccessLine(r: DiffResult): string {
  const s = r.success;
  if (!s) return "";
  const c = s.costPerSuccess;
  const ch = c.change != null ? signedPct(c.change) : c.headUsd == null ? "head has no passes" : "base has no passes";
  const p = pValue(c.pTwoSided);
  switch (c.verdict) {
    case "higher":
      return `higher, ${ch} (${p})`;
    case "lower":
      return `lower, ${ch} (${p})`;
    case "no clear change":
      return c.change != null && Math.abs(c.change) < 1e-12 ? "no change" : `no clear change: ${ch}, not clearly beyond run-to-run noise (${p})`;
    case "too few runs":
      return `too few runs to tell (${ch}): no change these runs could show would reach p<${SIGNIFICANCE}`;
    case "can't tell":
      return s.verdict === "can't tell"
        ? "can't tell: compared runs with no outcome"
        : "can't tell: runs with an outcome have calls with no price or no usage, so their spend is unknown";
  }
}

export function renderDiffTable(result: DiffResult, opts: TableOptions = {}): string {
  const r = plainDeep(result);
  const c = (code: string, s: string) => (opts.color && s ? `\x1b[${code}m${s}\x1b[0m` : s);
  const dim = (s: string) => c("2", s);
  const out: string[] = [];
  out.push(`${c("1", "burnlint diff")}  ${dim(r.groupBy ? `grouped by ${r.groupBy}` : "all runs in one group")}`);
  out.push("");
  for (const [name, s] of [["base", r.base], ["head", r.head]] as const) {
    const left = [s.excluded ? `${s.excluded} not counted (no priced call)` : ""].filter(Boolean);
    out.push(`  ${name}  ${plural(s.counted, "run")}${left.length ? dim(` · ${left.join(", ")}`) : ""}  ${dim(s.paths.map(short).join(", "))}`);
  }
  out.push("");

  const o = r.overall;
  if (o) {
    const color = o.verdict === "higher" ? "1;31" : o.verdict === "lower" ? "1;32" : "1";
    const lead = `  cost per run  ${usd(o.baseUsd)} → ${usd(o.headUsd)}   `;
    hanging(lead, verdictLine(r), opts.width).forEach((l, i) => out.push(i ? l : lead + c(color, l.slice(lead.length))));
    const sub: string[] = [];
    if (r.groups.length > 1) sub.push("at base's mix of groups");
    const mixDiffers =
      r.onlyBase.length || r.onlyHead.length || r.groups.some((g) => Math.abs(g.head.runs / headShared(r) - g.weight) > 1e-9);
    if (mixDiffers && r.base.pooledUsd != null && r.head.pooledUsd != null)
      sub.push(`all runs pooled: ${usd(r.base.pooledUsd)} → ${usd(r.head.pooledUsd)}`);
    if (o.verdict !== "can't tell" && o.verdict !== "too few runs" && o.noise != null)
      sub.push(`run-to-run noise here: about ±${(o.noise * 100).toFixed(0)}%`);
    sub.push(o.method === "exact" ? `exact test over ${int(o.permutations)} relabelings` : `test over ${int(o.permutations)} sampled relabelings`);
    out.push(...hanging(" ".repeat(16), sub.join(" · "), opts.width).map(dim));
  } else {
    out.push(`  ${verdictLine(r)}`);
  }
  const s = r.success;
  if (s) {
    const color = s.verdict === "lower" ? "1;31" : s.verdict === "higher" ? "1;32" : "1";
    const rates = s.baseRate != null && s.headRate != null ? `${pct(s.baseRate)} → ${pct(s.headRate)}` : "? → ?";
    const lead = `  success       ${rates}   `;
    hanging(lead, successVerdictLine(r), opts.width).forEach((l, i) => out.push(i ? l : lead + c(color, l.slice(lead.length))));
    const passed = (x: { known: number; passed: number; runs: number }) =>
      `${x.passed}/${x.known}${x.known < x.runs ? ` (${x.runs - x.known} without outcome)` : ""}`;
    const sub = [`passed ${passed(s.base)} → ${passed(s.head)}`];
    if (s.groups.length > 1) sub.push("at base's mix of groups");
    out.push(...hanging(" ".repeat(16), sub.join(" · "), opts.width).map(dim));
    const cps = s.costPerSuccess;
    if (cps.baseUsd != null || cps.headUsd != null) {
      const ccolor = cps.verdict === "higher" ? "1;31" : cps.verdict === "lower" ? "1;32" : "1";
      const each = (x: number | null) => (x == null ? "no passes" : usd(x));
      const lead = `  per success   ${each(cps.baseUsd)} → ${each(cps.headUsd)}   `;
      hanging(lead, costPerSuccessLine(r), opts.width).forEach((l, i) => out.push(i ? l : lead + c(ccolor, l.slice(lead.length))));
      const note = ["all spend on runs with an outcome ÷ passes, failed runs included"];
      if (cps.lowerBound) note.push("lower bound: some runs had a failed call whose spend is unknown");
      out.push(...hanging(" ".repeat(16), note.join(" · "), opts.width).map(dim));
    }
  }
  out.push("");

  // Success counts every run: a group can have outcomes on both sides with no priced run on one.
  const successOnly = (r.success?.groups ?? []).filter((g) => !r.groups.some((c) => c.name === g.name));
  if (r.groups.length || successOnly.length) {
    const succ = new Map((r.success?.groups ?? []).map((g) => [g.name, g]));
    const head = ["group", "side", "runs", "mean", "median", "min", "max", "calls", "prompt tok", "output tok", "cache", ...(r.success ? ["passed"] : []), ""];
    const rows: string[][] = [];
    for (const g of r.groups) {
      for (const [side, s] of [["base", g.base], ["head", g.head]] as const) {
        rows.push([
          side === "base" ? g.name : "",
          side,
          String(s.runs),
          usd(s.meanUsd),
          usd(s.medianUsd),
          usd(s.minUsd),
          usd(s.maxUsd),
          s.calls.toFixed(1),
          int(Math.round(s.promptTokens)),
          int(Math.round(s.outputTokens)),
          s.cacheShare == null ? "?" : `${(s.cacheShare * 100).toFixed(0)}%`,
          ...(r.success ? [passedCell(succ.get(g.name)?.[side])] : []),
          side === "head" ? signedPct(g.change) : "",
        ]);
      }
    }
    for (const g of successOnly)
      for (const side of ["base", "head"] as const)
        rows.push([side === "base" ? g.name : "", side, String(g[side].runs), ...Array<string>(8).fill("–"), passedCell(g[side]), ""]);
    const w = head.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i]!.length)));
    const left = (i: number) => i < 2;
    const line = (cells: string[]) => "  " + cells.map((s, i) => (left(i) ? s.padEnd(w[i]!) : s.padStart(w[i]!))).join("  ").trimEnd();
    out.push(dim(line(head)));
    for (const row of rows) out.push(line(row));
    out.push(
      dim(
        `  per run means; cache = cache reads as a share of prompt tokens` +
          (r.success ? `; passed = passes of runs with an outcome, every run counted (also those with no priced call)` : "") +
          (successOnly.length ? `; – = no priced run on one side, cost not compared` : ""),
      ),
    );
    out.push("");
  }

  const notes = diffNotes(r);
  if (notes.length) {
    out.push(dim("Notes"));
    for (const n of notes) out.push(...hanging("  - ", n, opts.width).map(dim));
    out.push("");
  }
  out.push(...hanging("", `Costs are estimates. Prices: ${r.prices.source}, retrieved ${r.prices.retrieved}.`, opts.width).map(dim));
  return out.join("\n");
}

const passedCell = (x: { runs: number; known: number; passed: number } | undefined) =>
  x ? `${x.passed}/${x.known}${x.known < x.runs ? ` ?${x.runs - x.known}` : ""}` : "";

const headShared = (r: DiffResult) => r.groups.reduce((s, g) => s + g.head.runs, 0);

function diffNotes(r: DiffResult): string[] {
  const out: string[] = [];
  const { base: b, head: h } = r;
  if (b.failed || h.failed) {
    const more = h.failed / Math.max(1, h.runs) > b.failed / Math.max(1, b.runs);
    out.push(
      `runs with a failed call: base ${b.failed} of ${b.runs}, head ${h.failed} of ${h.runs}. ` +
        `A failed call has no usage in the trace but may still be billed, so those runs' cost is a lower bound` +
        (more ? `; and a failed run usually stops early, so head may look cheaper than it is` : ""),
    );
  }
  // Models come from priced runs: a side without any says nothing about a model change.
  if (b.counted && h.counted && b.models.join() !== h.models.join())
    out.push(`models: base ${b.models.join(", ") || "?"}; head ${h.models.join(", ") || "?"}. A model change is a trade-off: ${r.success ? "weigh cost against success above" : "cost alone doesn't show whether the work still gets done; add --outcomes"}`);
  const unpriced = [...new Set([...b.unpricedModels, ...h.unpricedModels])];
  if (unpriced.length) out.push(`no price for model(s): ${unpriced.join(", ")} (add them with --prices)`);
  if (r.success?.unmatchedRows) out.push(`${plural(r.success.unmatchedRows, "row")} in ${short(r.success.file)} name no run on either side`);
  // Success counts runs with no priced call, so it may still compare these groups.
  const success = new Set((r.success?.groups ?? []).map((g) => g.name));
  const only = (side: string, names: string[]) =>
    `priced runs only in ${side}, cost not compared: ${names.map((n) => (success.has(n) ? `${n} (success compared)` : n)).join(", ")}`;
  if (r.onlyBase.length) out.push(only("base", r.onlyBase));
  if (r.onlyHead.length) out.push(only("head", r.onlyHead));
  return out;
}
