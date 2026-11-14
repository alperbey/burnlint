# burnlint

CLI that measures what agent runs cost and finds the avoidable part. Each finding has a rule id, severity, location, what it cost and what fixing it would save. Reads Claude Code session logs and OpenTelemetry GenAI (OTLP/JSON) traces. Framework-agnostic by design: new agents are supported by adding a reader or a dialect mapper, never by special-casing rules.

## Purpose

burnlint supports P&L decisions about agents. Primary users are people building agents, who can change what a finding points at; people using coding agents (Claude Code and the like) come second. So the product answers "what does a unit of agent work cost, and did this change make it better or worse": cost per run, before/after comparison in CI, and cost per successful run once outcomes are known. Waste rules explain where the money goes; they are not the headline. The biggest P&L levers (model choice, context size) are trade-offs and need outcome evidence before burnlint advises them.

## Commands

- `npm install`
- `npm test` builds (tsc) and runs node:test on `dist/test/*.test.js`
- `node dist/cli.js audit <paths>` (no path = `~/.claude/projects`; `-v` for each occurrence, `--runs-per-month <n>` for a monthly projection, `-f json|md`)
- `node dist/cli.js diff <base> <head>` (cost per run before/after, grouped; `--group-by <label>`, `--fail-above <pct>`, `-f json`)
- `node dist/cli.js record -o run.jsonl` (OTLP/HTTP JSON receiver on 127.0.0.1:4318, Ctrl-C to stop)
- `npm run update-prices` refreshes `src/pricing/prices.json` from LiteLLM

## Layout

- `src/model.ts` normalized model: Run > Turn > ModelCall + ToolCall, Tokens, Finding
- `src/adapters/` one reader per source format (`claude-code.ts`, `otlp.ts`)
- `src/rules/` one pure function per rule, registered in `rules/index.ts`
- `src/pricing.ts` price lookup, cost math, provider inference/relabeling
- `src/record.ts` OTLP/HTTP receiver for `record`: appends each trace export as one JSONL line, body written as received
- `src/audit.ts` file discovery, format detection, runs rules; `src/diff.ts` before/after comparison and its permutation test; `src/report.ts` table/json/md; `src/cli.ts`
- `fixtures/` real traces only (redacted), plus the script that generated each one. `scripts/redact-capture.mjs` turns picked traces of a `record` capture into a fixture (content removed, tool results replaced by same-length filler, equal where equal; numbered file lines keep their numbers and get per-line filler, keyed with a per-run secret)
- `bench/<framework>/` agents run to capture real traces, each with its own pinned package.json (never a dependency of burnlint). `bench/ai-sdk/agent.mjs`: read-only code reviewer on the Vercel AI SDK, 3 tasks x normal/wasteful/nocache. Raw captures go to `captures/` (gitignored: they hold prompts and tool results)

## Principles

- Local only. No network calls at runtime, never print message content.
- Unknown is not zero. Missing usage = unpriced; missing cache fields = cache unknown (price as uncached, mark as upper bound, cache rules skip the call).
- False positives are worse than misses. A rule must stay silent when it can't tell. Repeat detection resets on writes, shell commands and new human messages; never reports shell commands or polling tools; and treats a different result as "the world changed". `duplicate-tool-call` requires both results known and equal; `reread-unchanged` on numbered-line reads requires every repeated line equal (per-line hashes, `lineKeys`). Tool kinds (read/write/shell/other), path normalization and the polling-name list live in `src/tools.ts`, not in rules.
- Findings never include tool inputs (queries, commands). Paths and tool names are fine.
- Terminal output is part of the product. `message` is one short line; per-occurrence detail goes in `details` (shown with -v). The table groups findings by run, wraps to the terminal width, and keeps one line per finding when piped. Severity follows `avoidableUsd`; trade-offs and fixes that save nothing are `info` and never fail `--fail-on`. Files found while scanning a folder that aren't traces are ignored quietly; a named file that can't be read is reported.
- burnlint measures cost, not output quality. Every finding has a `fix` effect: `no-loss` (the fix removes only what the model already had) or `trade-off` (it changes what the model sees or which model runs). Only no-loss findings get `avoidableUsd`, net of what the fix itself costs (cache-thrash expiry assumes a keep-alive for up to `keepAliveHours`, default 12, never hindsight). Trade-off rules (`context-growth`, `model-overkill`) report cost only, until a benchmark shows task success holds.
- Cost per run counts only runs with at least one priced call; runs that failed (error status, Claude Code `isApiErrorMessage`) or carried no usage are counted apart, never as $0 runs. A failed call leaves the cache state alone.
- `cache-thrash` fires on a lost cache (read < what the previous call left cached), never on a large write alone; savable is min(lost, written) at write minus read, checked against a stable-prefix counterfactual on a real capture.
- The CLI refuses what it would otherwise ignore: unknown rule ids, non-numeric thresholds, options of another command, unknown price fields. Zero runs audited exits 2.
- Every mapper is built from a real captured trace, not from docs. Pin the source version it was checked against.
- Check money against an independent calculation (see tests) before claiming a number.
- No runtime dependencies so far. Adding one (e.g. protobuf decoding) is a decision to raise with Alper first.

## Verified format facts

Claude Code JSONL (checked on v2.1.x logs):
- One API response is written as several `assistant` lines with the same `message.id`, usage repeated. Count usage once per id.
- Imported/synthetic records have zero or null usage: treat as no usage.
- `usage.cache_creation` splits 5m vs 1h writes; 1h writes cost more.
- `isSidechain` = sub-agent; `isMeta` user lines are not human input.
- `Read` results list lines as `N<TAB>text` (not `N→text`); image reads come back as image blocks.

OTel gen_ai via `opentelemetry-instrumentation-openai-v2` 2.3b0 (2.4b0 is broken against published util-genai; needs `wrapt<2`):
- Provider is in `gen_ai.system` (older name), not `gen_ai.provider.name`.
- Calls to DeepSeek through the OpenAI client are labeled `openai`; relabel from model/server.
- DeepSeek cache fields are dropped; `gen_ai.usage.input_tokens` is the full prompt.
- No `server.address` was emitted in that setup.
- Python exporters encode ids as base64; the reader normalizes to hex.

OTLP/HTTP JSON via `@opentelemetry/exporter-trace-otlp-http` 0.223.2 (sdk-trace-node 2.12.1), captured through `record`:
- Ids are hex, `startTimeUnixNano` is a string, `intValue` is a JSON number, span `kind` is a number.
- `OTEL_EXPORTER_OTLP_COMPRESSION=gzip` sends `content-encoding: gzip`.
- The exporter surfaces the body of an error response (`OTLPExporterError.data`), so the 415 hint for protobuf reaches the user.
- The newest lines of the OTel JS packages have conflicting peer ranges on `@opentelemetry/api`; install the pinned set from `scripts/gen-record-fixture.mjs`.

Vercel AI SDK 7.0.157 + @ai-sdk/otel 1.0.157 + @ai-sdk/anthropic 4.0.92, Claude Sonnet 5.5, captured through `record` (fixtures/ai-sdk-v7-*.jsonl):
- Default `OpenTelemetry`: `invoke_agent` (sums its steps), `step N`, `chat` per call, `execute_tool`. Cache in `gen_ai.usage.cache_read/cache_creation.input_tokens`; `gen_ai.usage.input_tokens` includes both. 5m/1h writes not split. Content is recorded by default (`gen_ai.input.messages`, tool arguments and results).
- `LegacyOpenTelemetry`: `ai.generateText` (sums its steps, no gen_ai.usage), `ai.generateText.doGenerate` per call (`ai.operationId`; gen_ai.usage present, cache only in `ai.usage.inputTokenDetails.cacheReadTokens/cacheWriteTokens`), `ai.toolCall` (`ai.toolCall.name/id/args/result`). Provider `anthropic.messages`, relabeled.
- A failed call: model span with status 2 and no usage; SDK retries are inside one span ("Failed after 3 attempts"), so an attempt before a successful retry is invisible.
- `result.response.messages` is only the last step in v7 (all steps: `result.responseMessages`); passing the former into a second call drops the history.
- Semconv `gen_ai.tool.call.result` holds a string result JSON-encoded (`"\"1\\tfoo\""`).
- Semconv `chat` spans carry the prompt as sent per step: `gen_ai.tool.definitions`, `gen_ai.system_instructions` (from that step's `instructions`, so a per-step timestamp shows), `gen_ai.input.messages` (role + parts, the SDK's normalized view: provider options and signatures dropped). The reader keeps only hashes (`promptKeys`). Legacy `ai.prompt.tools` is a list of strings (arrayValue).

## Roadmap (M2, in order)

Done: `burnlint record` (OTLP/HTTP JSON; traces only, logs and metrics acknowledged and dropped; protobuf refused with 415 and a hint to set `OTEL_EXPORTER_OTLP_PROTOCOL=http/json`). Still open, to decide with Alper: protobuf decoding (a dependency, or a hand-written decoder for the trace messages) or keep documenting `http/json`. Checked only against the OTel JS exporter so far.

1. Done: cost per run (`perRun` in `audit.ts`): count, mean, median, p90 and max cost per run, avoidable per run and as a share of spend; `--runs-per-month` projects both to a month. A run here is the unit of work: a Claude Code session with its sub-agents (grouped by `session`), or one OTLP trace.
2. Real captures from agent frameworks builders use (OpenAI Agents SDK, LangGraph, Vercel AI SDK `ai.*`, OpenInference), through `record`. Needed before `diff`: it must be designed against real before/after traces, and they show whether the waste rules find money outside Claude Code. In progress (2026-11-13): Vercel AI SDK first, on Claude Sonnet 5.5; agent in `bench/ai-sdk/`, Alper runs it on his key. First capture (`captures/ai-sdk.jsonl`, 12 runs, ~$1.5): semconv cost matched an independent recomputation on all 9 runs. It showed cache-thrash overstating savable and firing on a big tool result on a cold cache (both fixed), and failed runs counted as $0 runs (fixed). Second capture (`captures/ai-sdk-2.clean.jsonl`; the raw file also holds 2 mock traces, dropped in the clean copy): 34 semconv + 9 legacy runs, ~$7.4, two phases per run (answer, then check), variants normal/prefix/nocache/reread x 3. Cost and cache-thrash savable matched independent checks on all 34; burnlint's prefix savable roughly equals the measured prefix-minus-normal cost difference (review $0.40 vs +$0.42, explain $0.037 vs +$0.043, principle $0.101 vs +$0.098). Harness bug: in AI SDK 7 `result.response.messages` is only the last step (all steps: `result.responseMessages`), so every check phase lost its tool results; fixed in agent.mjs after the run, so the reread variant was not a valid test (also: rereads came with different, overlapping ranges, which `reread-unchanged` doesn't match). That bug showed a burnlint gap, now fixed: a trace can hold several conversations, so the OTLP reader marks a call whose prompt shrank (under 80% and 1,024+ tokens below the previous) as a context reset. Noise is large (principle nocache $0.11-0.24 over 3 runs). Done since: the `ai.*` (LegacyOpenTelemetry) mapper and fixtures for both formats; all 43 runs match independent cost and savable checks. Third capture (`captures/ai-sdk-3.jsonl`, 2026-11-13, normal,reread x 3 tasks x 3, $1.73, 18/18 pass): cost matched an independent recomputation from the SDK's usage on all 18 (official Sonnet 5.5 cache read is $0.10/MTok, 0.05x; the bench's `PRICE` equals LiteLLM's, so it isn't an independent check). reread costs +36-42% over normal, but the model rereads with new ranges, rarely the same one: exact-match reread-unchanged fired in 2/9. Now matches overlapping ranges by per-line hashes; on this capture it fires on 9/9 reread and 0/9 normal, and its repeated lines match an interval calculation from the requested ranges (fixture `ai-sdk-v7-reread.jsonl`). Its savable (repeated tokens carried) is a small part of the reread cost difference: most of that is the extra calls that reread, which aren't counted as avoidable (a reread moves content to the end of context and may help; a trade-off until outcomes show otherwise). `no-prompt-cache`: on all 18 ai-sdk-3 runs with their caching stripped, its savable matched what caching really saved within 0.1%; on a real nocache run (`captures/ai-sdk-4.jsonl`, principle, $0.119; fixture `ai-sdk-v7-nocache.jsonl`) it fires with $0.057 savable (measured nocache minus normal mean: $0.052), and the AI SDK reports zero cache fields as 0, not absent. It errs high when the prefix changes every call while the prompt grows (a timestamp in the system prompt). A reread-only call's cost is shown in `reread-unchanged` details, never counted (independent review, 2026-11-13). Prefix check: where the trace records the prompt, `promptKeys` (hashes of tools, system, each message, blocks per message) let `no-prompt-cache` count a hit only on an unchanged prefix (else "up to", an upper bound) and let `cache-thrash` name what changed. Checked on a real `prefix` run (`captures/ai-sdk-5.jsonl`, fixture `ai-sdk-v7-prefix.jsonl`): system prompt changed on 5 of 6 calls; all 107 steps of ai-sdk-3 and the nocache run unchanged; the prefix run with caching stripped gets no no-prompt-cache finding. Gap: caching off on a volatile prefix reports nothing (caching as it stands would save nothing; the stable-prefix saving isn't claimed). Follow-up, needs one real capture each: a lost automatic cache on OpenAI/Gemini (prefix-matched too; they report cache reads but no writes, so `cache-thrash`, which needs a rewrite, never fires there). `carriedCost` stops at a context reset; `reread-unchanged` exact matches need both results known. The 3 failed legacy runs vanish: legacy spans aren't recognized as model calls yet. An earlier attempt hidden by an SDK retry is invisible in the trace (review-normal step 2: 66s, reads a cache no earlier call wrote); don't flag warm starts as retries. From the SDK source (ai 7.0.157, @ai-sdk/otel 1.0.157), to confirm on the real capture: v7's default `OpenTelemetry` integration emits GenAI semconv (`invoke_agent` root with summed usage, `chat` per call with `gen_ai.usage.cache_read/cache_creation.input_tokens`, `execute_tool` with arguments and result), and input_tokens includes cache reads and writes; 5m vs 1h writes are not split. `LegacyOpenTelemetry` (and AI SDK <= 6) emits `ai.generateText` / `.doGenerate` / `ai.toolCall` with cache only in `ai.usage.inputTokenDetails.cacheReadTokens/cacheWriteTokens`: the reader doesn't map those or `ai.toolCall` yet (a mock run showed cache unknown and no reread finding). The `nocache` variant shows a gap: Anthropic without `cache_control` caches nothing and no rule reports it yet.
3. `burnlint diff <base> <head>`: same tasks before and after a change. v1 done (2026-11-13, design reviewed independently): runs compared within groups (`Run.labels`: OTLP root-span scalar attributes, never content keys, plus `gen_ai.agent.name`, filled from `ai.telemetry.functionId` for `ai.*` spans; Claude Code `project`); default group `gen_ai.agent.name`, then `project`, else one group; an unknown `--group-by` key is refused. Headline is group means weighted by base's mix (pooled means shown when the mix differs); per group mean/median/min/max, calls, prompt and output tokens, cache share. Stratified permutation test (exact up to 200k relabelings, else 20k sampled with a fixed seed); verdict two-sided, `--fail-above` one-sided and only on a clear rise (an unclear rise passes with a warning); unpriced calls on either side make it `can't tell` (gate exits 2); failed runs and model changes noted. Checked on ai-sdk-3 normal vs reread: group means and +38.1% match an independent recomputation from the SDK's usage, p = 1/8000 one-sided as computed independently. Power at bench noise (simulated): 3 runs per task see +10% 56%, +15% 86%, +20% 98%. Not yet: findings added/removed, Markdown output, an A/A run to check the false-alarm rate on real runs, then a GitHub Action.
4. Outcomes: pass/fail per run (span attribute or a sidecar file), cost per successful run, and `diff` reporting success beside cost. This is what lets trade-off levers be advised.
5. Rules: `oversized-tool-result`, `retry-loop`, `context-growth`. `model-overkill` after outcomes (counterfactual, needs careful wording).
6. More dialect mappers, each from a real capture: Claude Code OTel spans (`claude_code.*`, needs CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1; tool inputs need OTEL_LOG_TOOL_DETAILS=1), Codex CLI rollout JSONL + OTel, Gemini CLI (`gemini_cli.*`, `outfile` setting), Qwen Code (`qwen-code.*`).
7. npm publish (name `burnlint` was free on npm, PyPI and GitHub as of Nov 2026). An MCP server over the JSON output is a cheap later add-on, not a priority.

Benchmark protocol for new sources: 3 fixed tasks, each run normally and with a deliberately wasteful setup, so every rule is shown to fire and to stay silent. For a trade-off rule, also run each task with the suggested fix applied and compare task success (tests pass) and cost; the rule only advises once success holds.

## Related projects

- ccusage: usage totals for coding-agent CLIs. Reference for native log parsing (MIT).
- AshwinUgale/tracelint: structural-defect linter for agent traces (correctness, not cost). Different job; don't copy its rules or naming.

## Conventions

- TypeScript strict, ESM, Node >= 20, node:test.
- Commit messages: plain, describe the change only. No Co-Authored-By trailers.
