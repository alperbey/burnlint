import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readOtlp } from "../src/adapters/otlp.js";
import { audit } from "../src/audit.js";
import { PriceTable } from "../src/pricing.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixture = (name: string) => join(root, "fixtures", name);

type Attr = { key: string; value: { stringValue?: string; intValue?: number | string } };
/** The fixture's spans with their attributes as a map, read without the reader under test. */
function spansOf(file: string) {
  const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  return lines.flatMap((r: any) =>
    r.resourceSpans.flatMap((rs: any) =>
      rs.scopeSpans.flatMap((ss: any) =>
        ss.spans.map((s: any) => ({
          name: s.name as string,
          dropped: (s.droppedAttributesCount ?? 0) as number,
          a: Object.fromEntries((s.attributes as Attr[]).map((x) => [x.key, x.value.stringValue ?? Number(x.value.intValue)])),
        })),
      ),
    ),
  );
}

test("OpenInference (OpenAI Agents SDK): calls, tools, usage, and usage lost to the attribute limit", () => {
  // A real run (bench/openai-agents, gpt-5.4-mini) on the OTel Python SDK's default limit of
  // 128 attributes per span: from the 6th call on, the model spans dropped their token counts.
  const file = fixture("openai-agents-attribute-limit.jsonl");
  const spans = spansOf(file);
  const llm = spans.filter((s) => s.a["openinference.span.kind"] === "LLM");
  assert.equal(llm.length, 10);
  const withUsage = llm.filter((s) => s.a["llm.token_count.prompt"] !== undefined);
  assert.equal(withUsage.length, 5);
  assert.ok(llm.filter((s) => s.a["llm.token_count.prompt"] === undefined).every((s) => s.dropped > 0));

  const [run, ...more] = readOtlp(file);
  assert.equal(more.length, 0);
  assert.equal(run!.dialect, "openinference");
  assert.equal(run!.turns.length, 10);
  assert.equal(run!.labels?.["gen_ai.agent.name"], "reviewer-explain");
  assert.equal(run!.labels?.["bench.task"], "explain");
  const priced = run!.turns.filter((t) => t.call.tokens);
  assert.equal(priced.length, 5);
  assert.ok(priced.every((t) => t.call.model === "gpt-5.4-mini-2026-03-17" && t.call.provider === "openai"));
  assert.ok(run!.notes.some((n) => /5 model call\(s\) lost their usage to the sender's span attribute limit/.test(n)));
  assert.ok(!run!.notes.some((n) => /have no usage data/.test(n)), "lost to the limit, not reported as plain missing usage");

  // Tools: every TOOL span, attached to the call before it, with its arguments.
  const tools = run!.turns.flatMap((t) => t.tools);
  assert.equal(tools.length, spans.filter((s) => s.a["openinference.span.kind"] === "TOOL").length);
  assert.deepEqual([...new Set(tools.map((t) => t.name))].sort(), ["git_show", "grep", "list_files"]);
  assert.ok(tools.every((t) => t.input && typeof t.input === "object"));

  // Cost from the spans' own numbers: prompt includes cache reads.
  const p = new PriceTable().lookup("gpt-5.4-mini-2026-03-17")!;
  const sum = (k: string) => withUsage.reduce((n, s) => n + (s.a[k] as number), 0);
  const [prompt, read, completion] = [sum("llm.token_count.prompt"), sum("llm.token_count.prompt_details.cache_read"), sum("llm.token_count.completion")];
  assert.equal(read, 1024);
  const want = ((prompt - read) * p.input! + read * p.cacheRead! + completion * p.output!) / 1e6;
  const result = audit([file]);
  assert.ok(Math.abs(result.totalCostUsd - want) < 1e-12, `${result.totalCostUsd} != ${want}`);
  assert.equal(result.perRun?.incomplete, 1, "a run with calls lost to the limit is a lower bound");
});

test("OpenInference: a span that kept one token count but lost the other to the limit is lost, not priced low", () => {
  // OpenInference writes the output count before the prompt's, and the limit drops the
  // oldest first: a span can lose `completion` and keep `prompt`. Made from the real
  // fixture by removing one priced call's output count, as the sender would have.
  const dir = mkdtempSync(join(tmpdir(), "burnlint-oi-"));
  const file = join(dir, "partial.jsonl");
  let done = false;
  const lines = readFileSync(fixture("openai-agents-attribute-limit.jsonl"), "utf8").trim().split("\n").map((l) => {
    const req = JSON.parse(l);
    for (const rs of req.resourceSpans)
      for (const ss of rs.scopeSpans)
        for (const s of ss.spans) {
          if (done || !s.attributes.some((a: Attr) => a.key === "llm.token_count.completion")) continue;
          s.attributes = s.attributes.filter((a: Attr) => a.key !== "llm.token_count.completion");
          s.droppedAttributesCount = 8;
          done = true;
        }
    return JSON.stringify(req);
  });
  assert.ok(done);
  writeFileSync(file, lines.join("\n") + "\n");
  const [run] = readOtlp(file);
  assert.equal(run!.turns.filter((t) => t.call.tokens).length, 4);
  assert.ok(run!.notes.some((n) => /^6 model call\(s\) lost their usage to the sender's span attribute limit/.test(n)), run!.notes.join("\n"));
  rmSync(dir, { recursive: true });
});

// The Agents SDK's own usage for these runs (RunResult raw_responses, summed per run by
// bench/openai-agents/agent.py into out/runs.jsonl), not read from the trace.
const SDK_USAGE = {
  normal: { calls: 4, input: 29597, cached: 2816, output: 1744 },
  prefix: { calls: 4, input: 34967, cached: 0, output: 2143 },
  reread: { calls: 6, input: 89141, cached: 27008, output: 2355 },
} as const;

test("OpenInference: per-run tokens and cost equal the SDK's own usage; reread-unchanged fires only on rereads", () => {
  // Real runs of the explain task on gpt-5.4-mini, attribute limit raised: normal, the time
  // at the end of the instructions, changed every call (prefix), and every file read twice
  // (reread). The instructions come before the conversation, so a change at their end still
  // changes the prefix of everything after it.
  const result = audit([fixture("openai-agents-explain.jsonl")]);
  assert.equal(result.runs.length, 3);
  const p = new PriceTable().lookup("gpt-5.4-mini-2026-03-17")!;
  for (const run of result.runs) {
    const variant = run.labels?.["bench.variant"] as keyof typeof SDK_USAGE;
    const u = SDK_USAGE[variant];
    assert.ok(u, `unexpected variant ${variant}`);
    assert.equal(run.calls, u.calls, variant);
    assert.equal(run.pricedCalls, u.calls, variant);
    assert.equal(run.promptTokens, u.input, variant);
    assert.equal(run.cacheReadTokens, u.cached, variant);
    assert.equal(run.outputTokens, u.output, variant);
    const want = ((u.input - u.cached) * p.input! + u.cached * p.cacheRead! + u.output * p.output!) / 1e6;
    assert.ok(Math.abs(run.costUsd - want) < 1e-12, `${variant}: ${run.costUsd} != ${want}`);
    const rules = result.findings.filter((f) => f.runId === run.id).map((f) => f.rule);
    if (variant === "reread") assert.ok(rules.length > 0 && rules.every((r) => r === "reread-unchanged"), rules.join());
    // prefix: OpenAI's automatic cache is lost on every call (0 reads), but OpenAI reports no
    // cache writes, so cache-thrash has nothing to compare against. A known gap (CLAUDE.md
    // roadmap, capture gaps); when a rule covers it, this run is where it should fire.
    else assert.deepEqual(rules, [], variant);
  }
});

test("OpenInference: a response cut off at max_output_tokens is a failed span with no usage", () => {
  // Real run (review task): the 11th call ended `response.incomplete` (reason max_output_tokens)
  // and the SDK raised. OpenInference records the span with error status and only
  // llm.system + the span kind: no model, no tokens. OpenAI bills that response anyway.
  const file = fixture("openai-agents-incomplete.jsonl");
  const spans = spansOf(file);
  const llm = spans.filter((s) => s.a["openinference.span.kind"] === "LLM");
  assert.equal(llm.length, 11);
  const bare = llm.filter((s) => s.a["llm.token_count.prompt"] === undefined);
  assert.equal(bare.length, 1);
  assert.deepEqual(Object.keys(bare[0]!.a).sort(), ["llm.system", "openinference.span.kind"]);

  const result = audit([file]);
  const [run] = result.runs;
  assert.equal(run!.calls, 11);
  assert.equal(run!.pricedCalls, 10);
  assert.equal(run!.failedCalls, 1);
  assert.ok(run!.notes.some((n) => /1 model call\(s\) failed with an error status .*may still bill/.test(n)));

  const p = new PriceTable().lookup("gpt-5.4-mini-2026-03-17")!;
  const ok = llm.filter((s) => s.a["llm.token_count.prompt"] !== undefined);
  const sum = (k: string) => ok.reduce((n, s) => n + (s.a[k] as number), 0);
  const [prompt, read, completion] = [sum("llm.token_count.prompt"), sum("llm.token_count.prompt_details.cache_read"), sum("llm.token_count.completion")];
  // The bench's cost guard, from the SDK's response.usage of each completed call: $0.1221.
  const want = ((prompt - read) * p.input! + read * p.cacheRead! + completion * p.output!) / 1e6;
  assert.ok(Math.abs(want - 0.1221) < 5e-5, `${want}`);
  assert.ok(Math.abs(result.totalCostUsd - want) < 1e-12, `${result.totalCostUsd} != ${want}`);
});
