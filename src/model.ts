// Normalized trace model. Every adapter produces Runs; rules only see Runs.

/** Token counts for one model call. `null` means the source did not report it. */
export interface Tokens {
  /** Input billed at the full rate (excludes cache reads and cache writes). */
  input: number | null;
  output: number | null;
  /** Reasoning/thinking tokens. Already included in `output`; informational. */
  reasoning: number | null;
  cacheRead: number | null;
  cacheWrite5m: number | null;
  cacheWrite1h: number | null;
  /** Cache writes where the TTL is not reported. Priced at the 5m rate. */
  cacheWriteOther: number | null;
  /**
   * False when the source gave no cache information at all. Rules that reason
   * about caching skip such calls instead of treating them as zero.
   */
  cacheKnown: boolean;
}

export type ProviderSource = "reported" | "inferred" | "relabeled" | "unknown";

export interface ModelCall {
  id: string;
  ts?: string;
  model?: string;
  provider: string;
  providerSource: ProviderSource;
  /** Provider as reported by the source, when it differs from `provider`. */
  reportedProvider?: string;
  /** null when the source carried no usage for this call. */
  tokens: Tokens | null;
}

/**
 * read/write: file tools. shell: runs arbitrary commands, so it can change
 * anything and its output depends on state the trace doesn't show.
 */
export type ToolKind = "read" | "write" | "shell" | "other";

export interface ToolCall {
  id: string;
  ts?: string;
  name: string;
  /** Raw tool input, when available. */
  input?: unknown;
  /** Stable string form of the input, for equality checks. undefined if input unknown. */
  inputKey?: string;
  kind: ToolKind;
  /** File or resource the tool reads or writes, when it can be determined. */
  target?: string;
  isError?: boolean;
  /** Estimated size of the tool result in tokens (chars / 4). undefined if unknown. */
  resultTokens?: number;
  /** Hash of the tool result, for equality checks. undefined if the result is unknown. */
  resultKey?: string;
}

export interface Turn {
  index: number;
  /**
   * True when a human message arrived just before this call. The outside
   * world may have changed, so repeat-detection rules start fresh.
   */
  humanInputBefore?: boolean;
  /**
   * True when the context was replaced just before this call (compaction).
   * Earlier tool results are gone from context and the prompt cache has to be
   * rebuilt, so neither a re-read nor a full cache write is waste.
   */
  contextReplacedBefore?: boolean;
  call: ModelCall;
  /** Tool calls requested by this model call. */
  tools: ToolCall[];
}

export interface Run {
  id: string;
  /** Adapter that produced the run, e.g. "claude-code", "otlp". */
  source: string;
  /** Telemetry dialect, e.g. "gen_ai". */
  dialect?: string;
  file: string;
  /** Sub-agent / sidechain label when the run is not the main thread. */
  agent?: string;
  turns: Turn[];
  /** Notes about data quality, shown in the report. */
  notes: string[];
}

export type Severity = "high" | "medium" | "low";

export interface Finding {
  rule: string;
  severity: Severity;
  runId: string;
  file: string;
  /** Turn indexes involved. */
  turns: number[];
  message: string;
  /** Estimated avoidable cost in USD. null when it can't be priced. */
  costUsd: number | null;
  /** Estimated avoidable tokens (all kinds). null when unknown. */
  tokens: number | null;
}

export function emptyTokens(): Tokens {
  return {
    input: null,
    output: null,
    reasoning: null,
    cacheRead: null,
    cacheWrite5m: null,
    cacheWrite1h: null,
    cacheWriteOther: null,
    cacheKnown: false,
  };
}

export function cacheWriteTotal(t: Tokens): number {
  return (t.cacheWrite5m ?? 0) + (t.cacheWrite1h ?? 0) + (t.cacheWriteOther ?? 0);
}

export function totalTokens(t: Tokens): number {
  return (t.input ?? 0) + (t.output ?? 0) + (t.cacheRead ?? 0) + cacheWriteTotal(t);
}
