import { relative } from "node:path";
import type { AuditResult } from "./audit.js";
import type { Finding } from "./model.js";

const usd = (n: number | null): string =>
  n == null ? "?" : n < 0 ? `-${usd(-n)}` : n >= 100 ? `$${n.toFixed(0)}` : n >= 1 ? `$${n.toFixed(2)}` : n >= 0.01 ? `$${n.toFixed(3)}` : n > 0 ? `$${n.toFixed(4)}` : "$0";
const int = (n: number | null) => (n == null ? "?" : n.toLocaleString("en-US"));
const short = (p: string) => {
  const r = relative(process.cwd(), p);
  return r.startsWith("..") ? p : r;
};

export function renderJson(r: AuditResult): string {
  return JSON.stringify(r, null, 2);
}

export function renderTable(r: AuditResult, opts: { color?: boolean; verbose?: boolean } = {}): string {
  const c = (code: string, s: string) => (opts.color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const sevColor: Record<string, string> = { high: "31", medium: "33", low: "2" };
  const out: string[] = [];

  out.push(
    `${c("1", "burnlint")}  ${r.runs.length} run(s) in ${r.files} file(s)  ·  total ${usd(r.totalCostUsd)}  ·  in findings ${usd(r.findingsCostUsd)}  ·  avoidable ${usd(r.avoidableUsd)}`,
  );
  out.push("");

  if (!r.findings.length) {
    out.push("No findings.");
  } else {
    const rows = r.findings.map((f) => [f.severity, f.rule, usd(f.costUsd), savable(f), int(f.tokens), f.message, runLabel(f)]);
    const heads = ["SEV", "RULE", "COST", "SAVABLE", "TOKENS"];
    const w = heads.map((h, i) => Math.max(...rows.map((row) => row[i]!.length), h.length));
    out.push(c("2", [...heads.map((h, i) => (i < 2 ? h.padEnd(w[i]!) : h.padStart(w[i]!))), "FINDING"].join("  ")));
    for (const row of rows) {
      out.push(
        [
          c(sevColor[row[0]!]!, row[0]!.padEnd(w[0]!)),
          row[1]!.padEnd(w[1]!),
          row[2]!.padStart(w[2]!),
          row[3]!.padStart(w[3]!),
          row[4]!.padStart(w[4]!),
          row[5]! + c("2", `  [${row[6]}]`),
        ].join("  "),
      );
    }
  }

  const notes = r.runs.flatMap((run) => run.notes.map((n) => `${shortRun(run.id)}: ${n}`));
  const unpriced = [...new Set(r.runs.flatMap((run) => run.unpricedModels))];
  if (unpriced.length) notes.push(`no price for model(s): ${unpriced.join(", ")} (add them with --prices)`);
  if (r.skippedFiles.length) notes.push(`${r.skippedFiles.length} file(s) skipped${opts.verbose ? ": " + r.skippedFiles.map(short).join(", ") : " (use --verbose to list)"}`);
  if (notes.length) {
    out.push("");
    out.push(c("2", "Notes"));
    const shown = opts.verbose ? notes : notes.slice(0, 8);
    for (const n of shown) out.push(c("2", `  - ${n}`));
    if (shown.length < notes.length) out.push(c("2", `  - … ${notes.length - shown.length} more (use --verbose)`));
  }
  out.push("");
  if (r.findings.length) out.push(c("2", SAVABLE_NOTE));
  out.push(c("2", `Costs are estimates. Prices: ${r.prices.source}, retrieved ${r.prices.retrieved}.`));
  return out.join("\n");
}

const SAVABLE_NOTE =
  "Savable: what a fix that loses nothing the model already had would have saved, net of the fix's own cost. " +
  "Trade-offs change what the model sees or which model runs; quality may change, so they are not counted as avoidable.";

function savable(f: Finding): string {
  return f.fix === "trade-off" ? "trade-off" : usd(f.avoidableUsd);
}

export function renderMarkdown(r: AuditResult): string {
  const out: string[] = [];
  out.push(`### burnlint`);
  out.push("");
  out.push(
    `${r.runs.length} run(s) · total **${usd(r.totalCostUsd)}** · in findings **${usd(r.findingsCostUsd)}** · avoidable **${usd(r.avoidableUsd)}**`,
  );
  out.push("");
  if (!r.findings.length) {
    out.push("No findings.");
  } else {
    out.push("| Severity | Rule | Cost | Savable | Tokens | Finding |");
    out.push("|---|---|--:|--:|--:|---|");
    for (const f of r.findings) {
      out.push(`| ${f.severity} | \`${f.rule}\` | ${usd(f.costUsd)} | ${savable(f)} | ${int(f.tokens)} | ${escapeMd(f.message)} |`);
    }
    out.push("");
    out.push(`<sub>${SAVABLE_NOTE}</sub>`);
  }
  const notes = r.runs.flatMap((run) => run.notes);
  if (notes.length) {
    out.push("");
    out.push("<details><summary>Notes</summary>");
    out.push("");
    for (const n of [...new Set(notes)]) out.push(`- ${escapeMd(n)}`);
    out.push("");
    out.push("</details>");
  }
  out.push("");
  out.push(`<sub>Costs are estimates. Prices: ${r.prices.source}, retrieved ${r.prices.retrieved}.</sub>`);
  return out.join("\n");
}

function runLabel(f: Finding): string {
  return shortRun(f.runId);
}

function shortRun(id: string): string {
  const [base, rest] = id.split("#");
  const b = base!.length > 14 ? base!.slice(0, 8) : base!;
  return rest ? `${b}#${rest.slice(0, 10)}` : b;
}

function escapeMd(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
