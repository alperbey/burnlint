import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ModelCall, Run, Tokens } from "./model.js";

/** USD per 1M tokens. */
export interface Price {
  provider: string;
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite5m: number | null;
  cacheWrite1h: number | null;
}

interface PriceFile {
  source: string;
  retrieved: string;
  models: Record<string, Price>;
}

const here = dirname(fileURLToPath(import.meta.url));
const bundled: PriceFile = JSON.parse(readFileSync(join(here, "pricing", "prices.json"), "utf8"));

export class PriceTable {
  readonly models: Record<string, Price>;
  readonly source: string;
  readonly retrieved: string;

  constructor(overrides?: Record<string, Partial<Price>>) {
    // No prototype: a model named "constructor" or "__proto__" is just an unknown model.
    this.models = Object.assign(Object.create(null) as Record<string, Price>, bundled.models);
    for (const [id, p] of Object.entries(overrides ?? {})) {
      this.models[id] = { ...(this.models[id] ?? emptyPrice()), ...p } as Price;
    }
    this.source = bundled.source;
    this.retrieved = bundled.retrieved;
  }

  lookup(model: string | undefined): Price | undefined {
    if (!model) return undefined;
    for (const candidate of modelCandidates(model)) {
      const p = this.models[candidate];
      if (p) return p;
    }
    return undefined;
  }
}

function emptyPrice(): Price {
  return { provider: "unknown", input: null, output: null, cacheRead: null, cacheWrite5m: null, cacheWrite1h: null };
}

/** Name variants to try, most specific first. */
export function modelCandidates(model: string): string[] {
  const out: string[] = [];
  const push = (s: string) => {
    if (s && !out.includes(s)) out.push(s);
  };
  let m = model.trim().toLowerCase();
  push(m);
  // provider/model and bedrock-style prefixes
  if (m.includes("/")) push((m = m.split("/").pop()!));
  m = m.replace(/^(global|us|eu|apac)\./, "").replace(/^anthropic\./, "");
  push(m);
  // trailing date stamps: -20250929, -2025-09-29, @20250929
  push(m.replace(/[-@]\d{8}$/, "").replace(/-\d{4}-\d{2}-\d{2}$/, ""));
  // bedrock version suffix: -v1:0
  push(m.replace(/-v\d+(:\d+)?$/, ""));
  return out;
}

/** Cost of one model call in USD. null if the call has no usage or no price. */
export function callCost(call: ModelCall, prices: PriceTable): number | null {
  if (!call.tokens) return null;
  const p = prices.lookup(call.model);
  if (!p) return null;
  return tokensCost(call.tokens, p);
}

export function tokensCost(t: Tokens, p: Price): number {
  const per = (n: number | null, rate: number | null) => ((n ?? 0) * (rate ?? 0)) / 1e6;
  const write5m = p.cacheWrite5m ?? p.input;
  const write1h = p.cacheWrite1h ?? write5m;
  return (
    per(t.input, p.input) +
    per(t.output, p.output) +
    per(t.cacheRead, p.cacheRead ?? p.input) +
    per(t.cacheWrite5m, write5m) +
    per(t.cacheWrite1h, write1h) +
    per(t.cacheWriteOther, write5m)
  );
}

/** Rates used to estimate the cost of carrying N extra tokens in context. */
export function contextRates(model: string | undefined, prices: PriceTable): { first: number; carried: number } | null {
  const p = prices.lookup(model);
  if (!p || p.input == null) return null;
  // First time: written to cache (or billed as input). Later turns: cache read.
  const first = p.cacheWrite5m ?? p.input;
  const carried = p.cacheRead ?? p.input;
  return { first, carried };
}

/**
 * Estimated cost of `tokens` extra tokens entering context at `turnIndex` and
 * being carried through every later turn, up to the next context reset.
 */
export function carriedCost(run: Run, turnIndex: number, tokens: number, prices: PriceTable): number | null {
  const turn = run.turns[turnIndex];
  if (!turn) return null;
  const rates = contextRates(turn.call.model, prices);
  if (!rates) return null;
  let later = 0;
  while (turnIndex + later + 1 < run.turns.length && !run.turns[turnIndex + later + 1]!.contextReplacedBefore) later++;
  return (tokens * rates.first + tokens * rates.carried * later) / 1e6;
}

// --- prompt caching ---------------------------------------------------------

/**
 * Providers whose models cache only when the request asks for it
 * (`cache_control`). Others cache on their own (OpenAI, DeepSeek, Gemini
 * implicit) or weren't checked. Bedrock is left out: its minimums are
 * documented by AWS, not in the table below.
 */
const EXPLICIT_CACHE_PROVIDERS = new Set(["anthropic", "gcp.vertex_ai"]);

export function cachesOnlyWhenAsked(provider: string): boolean {
  return EXPLICIT_CACHE_PROVIDERS.has(provider);
}

/**
 * Shortest prompt a model will cache, in tokens; shorter prompts are processed
 * without caching and no error is returned. From Anthropic's prompt caching
 * page (Claude API, Claude Platform on AWS, Google Cloud, Foundry), checked
 * 2026-11-13.
 */
const MIN_CACHEABLE: Record<string, number> = {
  "claude-fable-5-2": 512,
  "claude-mythos-5-2": 512,
  "claude-fable-5-1": 512,
  "claude-mythos-5-1": 512,
  "claude-opus-5-5": 512,
  "claude-opus-5": 512,
  "claude-sonnet-5-5": 512,
  "claude-fable-5": 512,
  "claude-mythos-5": 512,
  "claude-haiku-5-5": 512,
  "claude-mythos-preview": 2048,
  "claude-opus-4-7": 2048,
  "claude-opus-4-6": 4096,
  "claude-opus-4-5": 4096,
  "claude-opus-4-8": 1024,
  "claude-sonnet-5": 1024,
  "claude-sonnet-4-6": 1024,
  "claude-sonnet-4-5": 1024,
  "claude-opus-4-1": 1024,
  "claude-opus-4": 1024,
  "claude-sonnet-4": 1024,
  "claude-haiku-4-5": 4096,
};

/** Minimum cacheable prompt for a model; undefined when not known. */
export function minCacheableTokens(model: string | undefined): number | undefined {
  if (!model) return undefined;
  for (const candidate of modelCandidates(model)) {
    const n = MIN_CACHEABLE[candidate];
    if (n !== undefined) return n;
  }
  return undefined;
}

// --- provider inference -----------------------------------------------------

const MODEL_PREFIXES: Array<[RegExp, string]> = [
  [/^claude|anthropic/, "anthropic"],
  [/^(gpt|o\d|chatgpt|codex|text-embedding)/, "openai"],
  [/^gemini|^gemma/, "gcp.gemini"],
  [/^deepseek/, "deepseek"],
  [/^qwen|^qwq/, "qwen"],
  [/^grok/, "x_ai"],
  [/^(kimi|moonshot)/, "moonshot_ai"],
  [/^glm/, "zai"],
  [/^(mistral|codestral|devstral|magistral)/, "mistral_ai"],
];

const HOSTS: Array<[RegExp, string]> = [
  [/(^|\.)anthropic\.com$/, "anthropic"],
  [/(^|\.)openai\.com$/, "openai"],
  [/(^|\.)deepseek\.com$/, "deepseek"],
  [/generativelanguage\.googleapis\.com$/, "gcp.gemini"],
  [/aiplatform\.googleapis\.com$/, "gcp.vertex_ai"],
  [/dashscope.*\.aliyuncs\.com$/, "qwen"],
  [/(^|\.)x\.ai$/, "x_ai"],
  [/(^|\.)moonshot\.(ai|cn)$/, "moonshot_ai"],
  [/(^|\.)mistral\.ai$/, "mistral_ai"],
  [/(^|\.)bigmodel\.cn$|(^|\.)z\.ai$/, "zai"],
];

export function providerFromModel(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const m = model.toLowerCase().split("/").pop()!.replace(/^(global|us|eu|apac)\./, "");
  for (const [re, p] of MODEL_PREFIXES) if (re.test(m)) return p;
  return undefined;
}

export function providerFromHost(host: string | undefined): string | undefined {
  if (!host) return undefined;
  const h = host.toLowerCase().replace(/^https?:\/\//, "").split(/[/:]/)[0]!;
  for (const [re, p] of HOSTS) if (re.test(h)) return p;
  return undefined;
}

/**
 * Decide the provider of a call. The server address is the strongest signal,
 * then the model name, then whatever the instrumentation reported. Calls made
 * through an OpenAI-compatible client are often reported as "openai".
 */
export function resolveProvider(opts: {
  reported?: string;
  model?: string;
  host?: string;
}): { provider: string; source: ModelCall["providerSource"]; reported?: string } {
  const inferred = providerFromHost(opts.host) ?? providerFromModel(opts.model);
  const reported = opts.reported?.toLowerCase();
  if (inferred && reported && !sameProvider(inferred, reported)) {
    return { provider: inferred, source: "relabeled", reported };
  }
  if (reported) return { provider: reported, source: "reported" };
  if (inferred) return { provider: inferred, source: "inferred" };
  return { provider: "unknown", source: "unknown" };
}

function sameProvider(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/^gcp\./, "").replace(/_ai$/, "");
  // Hosting platforms legitimately serve other vendors' models.
  if (/^(aws\.bedrock|azure|gcp\.vertex_ai|openrouter)/.test(b)) return true;
  return norm(a) === norm(b) || (norm(a) === "gemini" && b.startsWith("gcp."));
}
