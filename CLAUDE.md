# burnlint

CLI that measures what agent runs cost and finds the avoidable part. Each finding has a rule id, severity, location, what it cost and what fixing it would save. Reads Claude Code session logs and OpenTelemetry traces (GenAI `gen_ai.*`, Vercel AI SDK `ai.*`, OpenInference), as OTLP/JSON or recorded from protobuf. Framework-agnostic by design: new agents are supported by adding a reader or a dialect mapper, never by special-casing rules.

## Purpose

burnlint supports P&L decisions about agents. Primary users are people building agents, who can change what a finding points at; people using coding agents (Claude Code and the like) come second. So the product answers "what does a unit of agent work cost, and did this change make it better or worse": cost per run, before/after comparison in CI, and cost per successful run once outcomes are known. Waste rules explain where the money goes; they are not the headline. The biggest P&L levers (model choice, context size) are trade-offs and need outcome evidence before burnlint advises them.

## Commands

- `npm install`
- `npm test` builds (tsc) and runs node:test on `dist/test/*.test.js`
- `node dist/cli.js audit <paths>` (no path = `~/.claude/projects`; `-v` for each occurrence, `--runs-per-month <n>` for a monthly projection, `--outcomes <file>` for success and cost per successful run, `-f json|md`)
- `node dist/cli.js diff <base> <head>` (cost per run before/after, grouped; `--group-by <label>`, `--fail-above <pct>`, `--outcomes <file>`, `--fail-success-drop <points>`, `-f json`)
- `node dist/cli.js record -o run.jsonl` (OTLP/HTTP receiver, protobuf or JSON, on 127.0.0.1:4318, Ctrl-C to stop)
- `npm run update-prices` refreshes `src/pricing/prices.json` from LiteLLM

## Layout

- `src/model.ts` normalized model: Run > Turn > ModelCall + ToolCall, Tokens, Finding
- `src/adapters/` one reader per source format (`claude-code.ts`, `otlp.ts`)
- `src/rules/` one pure function per rule, registered in `rules/index.ts`
- `src/pricing.ts` price lookup, cost math, provider inference/relabeling
- `src/record.ts` OTLP/HTTP receiver for `record`: appends each trace export as one JSONL line, JSON written as received, protobuf decoded by `src/otlp-protobuf.ts` (hand-written, no dependency) into the same OTLP/JSON form
- `src/audit.ts` file discovery, format detection, runs rules; `src/outcomes.ts` the user's pass/fail file (reading, id normalization); `src/diff.ts` before/after comparison and its permutation test (cost, and success on failures); `src/report.ts` table/json/md; `src/cli.ts`
- `fixtures/` real traces only (redacted), plus the script that generated each one. `*-exports.ndjson` hold raw OTLP/HTTP request bodies (from `scripts/gen-protobuf-fixture.mjs` and `scripts/gen-protobuf-fixture-python.py`), not trace files; `audit` skips `.ndjson`. `scripts/redact-claude-code.mjs` does the same for a Claude Code session log (allowlist of what the reader uses). `scripts/redact-capture.mjs` turns picked traces of a `record` capture into a fixture (content removed, tool results replaced by same-length filler, equal where equal; numbered file lines keep their numbers and get per-line filler, keyed with a per-run secret)
- `bench/<framework>/` agents run to capture real traces, each with its own pinned package.json (never a dependency of burnlint). `bench/ai-sdk/agent.mjs`: read-only code reviewer on the Vercel AI SDK, 3 tasks x normal/prefix/reread (+ nocache on Anthropic), `--provider anthropic|google|deepseek`; tools read a pinned commit (`--snapshot`) so batches on different days see the same code. `bench/openai-agents/agent.py`: the same tasks on the OpenAI Agents SDK + OpenInference (Python, pinned `requirements.txt`, own `.venv`), variants normal/prefix/reread. Raw captures go to `captures/` (gitignored: they hold prompts and tool results)

## Principles

- Local only. No network calls at runtime, never print message content.
- Unknown is not zero. Missing usage = unpriced; missing cache fields = cache unknown (price as uncached, mark as upper bound, cache rules skip the call).
- False positives are worse than misses. A rule must stay silent when it can't tell. Repeat detection resets on writes, shell commands and new human messages; never reports shell commands or polling tools; and treats a different result as "the world changed". `duplicate-tool-call` requires both results known and equal; `reread-unchanged` on numbered-line reads requires every repeated line equal (per-line hashes, `lineKeys`). Tool kinds (read/write/shell/other), path normalization and the polling-name list live in `src/tools.ts`, not in rules.
- Findings never include tool inputs (queries, commands). Paths and tool names are fine.
- Terminal output is part of the product. `message` is one short line; per-occurrence detail goes in `details` (shown with -v). The table groups findings by run, wraps to the terminal width, and keeps one line per finding when piped. Severity follows `avoidableUsd`; trade-offs and fixes that save nothing are `info` and never fail `--fail-on`. Files found while scanning a folder that aren't traces are ignored quietly; a named file that can't be read is reported.
- burnlint measures cost, not output quality. Every finding has a `fix` effect: `no-loss` (the fix removes only what the model already had) or `trade-off` (it changes what the model sees or which model runs). Only no-loss findings get `avoidableUsd`, net of what the fix itself costs (cache-thrash expiry assumes a keep-alive for up to `keepAliveHours`, default 12, never hindsight). Trade-off rules (`context-growth`, `model-overkill`) report cost only, until a benchmark shows task success holds.
- Outcomes come from the user (`--outcomes`, JSONL `{"run", "pass"}`); burnlint never grades output. A run with no row is unknown, never failed; success counts every unit with an outcome, including runs cost per run leaves out (no priced call). Cost per successful run = all spend on runs with an outcome / passes, a lower bound when any of those runs is priced in part. In `diff`, any compared run without an outcome makes success `can't tell`; `--fail-success-drop` is separate from `--fail-above` and passes, with a warning, a drop the runs can't show. Errors name line numbers and keys, never values (notes may hold model output). The rule for users and the benches: `false` when the agent ran and didn't deliver for a reason of its own (wrong answer, turn limit, cost cap, output cut off), no row when nobody could grade it or something outside the agent broke.
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
- The exporter surfaces the body of an error response (`OTLPExporterError.data`), so a refusal reason reaches the user.

OTLP/HTTP protobuf (`fixtures/otel-js-exports.ndjson`, `fixtures/otel-python-exports.ndjson`, raw request bodies):
- JS `exporter-trace-otlp-proto` 0.223.2 sends `content-type: application/x-protobuf`. Decoded, its bodies equal what `exporter-trace-otlp-http` 0.223.2 sends for the same spans, except defaults protobuf leaves off the wire (zero dropped counts, empty events/links, status code 0).
- Python `opentelemetry-exporter-otlp-proto-http` 1.45.2 (protobuf 7.36.2) decodes to the SDK's in-memory spans; it sets span and link `flags` to 256 (the has-is-remote bit) and sends ints up to the full int64 range. It defaults to protobuf over HTTP and honors `OTEL_EXPORTER_OTLP_COMPRESSION=gzip`.
- The Python API counts span kinds from INTERNAL = 0; OTLP from UNSPECIFIED = 0 (so +1). JS ids, times and ints match the JSON exporter's form: ids hex, times decimal strings, ints numbers (beyond 2^53 burnlint writes decimal strings).
- gRPC (port 4317) is not served; agents that default to it need `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf`.
- The newest lines of the OTel JS packages have conflicting peer ranges on `@opentelemetry/api`; install the pinned set from `scripts/gen-record-fixture.mjs`.

Vercel AI SDK 7.0.157 + @ai-sdk/otel 1.0.157 + @ai-sdk/anthropic 4.0.92, Claude Sonnet 5.5, captured through `record` (fixtures/ai-sdk-v7-*.jsonl):
- Default `OpenTelemetry`: `invoke_agent` (sums its steps), `step N`, `chat` per call, `execute_tool`. Cache in `gen_ai.usage.cache_read/cache_creation.input_tokens`; `gen_ai.usage.input_tokens` includes both. 5m/1h writes not split. Content is recorded by default (`gen_ai.input.messages`, tool arguments and results).
- `LegacyOpenTelemetry`: `ai.generateText` (sums its steps, no gen_ai.usage), `ai.generateText.doGenerate` per call (`ai.operationId`; gen_ai.usage present, cache only in `ai.usage.inputTokenDetails.cacheReadTokens/cacheWriteTokens`), `ai.toolCall` (`ai.toolCall.name/id/args/result`). Provider `anthropic.messages`, relabeled.
- A failed call: model span with status 2 and no usage; SDK retries are inside one span ("Failed after 3 attempts"), so an attempt before a successful retry is invisible.
- `result.response.messages` is only the last step in v7 (all steps: `result.responseMessages`); passing the former into a second call drops the history.
- Semconv `gen_ai.tool.call.result` holds a string result JSON-encoded (`"\"1\\tfoo\""`).
- Semconv `chat` spans carry the prompt as sent per step: `gen_ai.tool.definitions`, `gen_ai.system_instructions` (from that step's `instructions`, so a per-step timestamp shows), `gen_ai.input.messages` (role + parts, the SDK's normalized view: provider options and signatures dropped). The reader keeps only hashes (`promptKeys`). Legacy `ai.prompt.tools` is a list of strings (arrayValue).
- Same SDK with `@ai-sdk/deepseek` 3.0.76 (deepseek-flash, semconv, 2026-11-15): `gen_ai.provider.name` `deepseek`; `gen_ai.usage.input_tokens` = `prompt_tokens` (hits + misses), cache reads = `prompt_cache_hit_tokens`, no writes (automatic cache); output includes reasoning. Equal to DeepSeek's own usage on 27 runs.
- With `@ai-sdk/google` 4.0.108 (gemini-3.8-flash, semconv): `gen_ai.provider.name` `gcp.gemini`; input = `promptTokenCount` (+ `toolUsePromptTokenCount`), output = candidates + `thoughtsTokenCount`, raw `usageMetadata` also in `ai.response.providerMetadata`. Equal to it on 7 calls (one run; the 8th call failed with 503 "high demand" after 3 attempts: status 2, no usage, as on Anthropic). No cache reads seen yet (prompts up to ~5k tokens).

OpenAI Agents SDK 0.24.0 + openinference-instrumentation-openai-agents 2.8.3 (OTel Python SDK 1.45.2), gpt-5.4-mini, captured through `record` (fixtures/openai-agents-*.jsonl):
- Span kind in `openinference.span.kind` (LLM, TOOL, AGENT, CHAIN); model spans are named `response`. A span with that attribute is a model call or tool only by its kind.
- Usage: `llm.token_count.prompt` (includes cache reads), `.prompt_details.cache_read`, `.prompt_details.cache_write` (always 0 on OpenAI: its cache is automatic), `.completion`, `.completion_details.reasoning`. Model `llm.model_name` (dated, e.g. gpt-5.4-mini-2026-03-17), provider `llm.system`, no `llm.provider`.
- TOOL spans: `tool.name`, arguments as JSON in `input.value`, the result as text in `output.value`, no call id. `agent.name` on AGENT spans.
- Every message is flattened into attributes (`llm.input_messages.N...`), and `llm.invocation_parameters` holds `instructions` (the system prompt). At the OTel Python default of 128 attributes per span, the oldest are dropped first, token counts included (`droppedAttributesCount` > 0); `OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT` raises it.
- A failed call (including a response cut off at `max_output_tokens`, which OpenAI bills) is an error span with only `llm.system` and the kind: no model, no usage.
- Instrumentation is exclusive by default: it replaces the SDK's upload of traces to OpenAI.

## Roadmap (M2, in order)

NOTES.md holds the dated log of captures, checks and decisions; keep this section to the current state.

Order set by Alper on 2026-11-14, after the independent progress review: the biggest risk is that nobody outside has used burnlint, so publish first, then widen what it reads, then outcomes. New rules wait until a real user's trace shows money there.

Done:
- `burnlint record` (OTLP/HTTP, JSON or protobuf, gzip or not; traces only, logs and metrics acknowledged and dropped). Protobuf (2026-11-14): hand-written decoder, checked against the OTel JS protobuf exporter (equals the JSON exporter's output for the same spans) and the Python one (equals the SDK's in-memory spans); recorded either way, the same trace audits the same. gRPC not served.
- Cost per run (`perRun` in `audit.ts`): count, mean, median, p90 and max cost per run, avoidable per run and as a share of spend; `--runs-per-month` projects both to a month. A run here is the unit of work: a Claude Code session with its sub-agents (grouped by `session`), or one OTLP trace.
- Real captures, Vercel AI SDK 7 on Claude Sonnet 5.5 (both span formats; bench in `bench/ai-sdk/`, Alper runs it on his key, about $12 so far): cost and savable match independent checks on every captured run, and each rule fires on its wasteful variant and stays silent on normal runs.
- `burnlint diff <base> <head>` v1 (2026-11-13/14). Runs compared within groups (`Run.labels`: OTLP root-span scalar attributes, never content keys, plus `gen_ai.agent.name`, filled from `ai.telemetry.functionId`; Claude Code `project`), overall at base's mix, stratified permutation test, `--fail-above` fails only on a clear rise, unpriced calls make it `can't tell`. Checked: +38% on a wasteful variant matches an independent recomputation; A/A on a pinned bench gives -0.9%, p=0.81; over all 8,000 3v3 splits of 18 same-setup runs the gate fires 0.09% at 10%. Inputs must be pinned on both sides (the bench reads a fixed commit, `--snapshot`).

- Published `burnlint@0.1.0` to npm (2026-11-14, tag `v0.1.0`, 4858f1e). Alper runs `npm publish --auth-type=web` in his own terminal (security-key 2FA; a non-interactive shell gets EOTP). npm stages a first publish (`0.0.0-stage` placeholder, then the real version). Before each publish: `npm publish --dry-run`, a tarball install, and compare the published `dist.shasum` with a local `npm pack`. Published from another computer, the gzip layer can differ (another Node's zlib): then compare the uncompressed tar (`gunzip -c x.tgz | shasum`).

- Second builder framework: OpenAI Agents SDK via OpenInference (2026-11-14, bench in `bench/openai-agents/`, about $1.50): tokens and cost equal the SDK's own usage on all 18 checked runs; `reread-unchanged` fires on 6/6 reread runs and on none of 12 others; usage lost to the span attribute limit is reported as such. Reviewed independently (Fable 5.2, 2026-11-15) and fixed. Published as `burnlint@0.2.0` (2026-11-15, with protobuf; tag `v0.2.0`, 840346d; `latest`).

- Outcomes, sidecar file (2026-11-15): `--outcomes` on audit and diff, success rate and cost per successful run, success in `diff` tested like cost (stratified permutation test on failures), `--fail-success-drop`. Design reviewed by Fable 5.2 before building. Checked on the OpenAI Agents SDK capture: cost per success $0.08516 from burnlint vs $0.08515 from the bench's own usage (22 runs, 17 passed; the bench rounds each run to 4 decimals). Power: a single group of 3 runs can't show any drop, but groups add up (2 x 3: 6/6 -> 1/6 is clear one-sided); grouping by input makes it a sign test (5 flips for the one-sided gate, 6 two-sided). Both benches write `out/outcomes.jsonl`. `--group-by` keeps the named key even if the content filter would drop it (`bench.input_id`). Pre-release review by Fable 5.2, four output fixes. Published as `burnlint@0.3.0` (2026-11-15, with the AI SDK DeepSeek and Gemini checks; tag `v0.3.0`, 71c6520; `latest`).

Next, in order:
1. 0.3.1, the four fixes deferred from the 0.3.0 review: published as `burnlint@0.3.1` (2026-11-16, from 5c5cc96, made on the other computer). Run ids keep 12 hex unless traces in a file share them (then the whole trace id); the success gate runs when cost can't be compared; base64 ids unpadded or URL-safe; a UTF-8 BOM skipped. Its commit reached origin on 2026-11-26; `fix-0.3.1` had made the same fixes again and was merged onto it (see NOTES).
2. Cost-per-success verdict in `diff`: published as `burnlint@0.4.0` (2026-11-26, tag `v0.4.0`, 4a356bf; `latest`; pre-release review by Fable 5.2, output fixes made). Permutation test of log(head / base) with each run's cost and outcome relabeled together (no passes = infinite), two-sided, no gate yet; `can't tell` when success can't tell or a run with an outcome is priced in part; a failed call's unknown spend only marks it a lower bound. p checked against a brute-force count; A/A on 8,000 splits of 18 same-setup runs (all passing): 4.97% called a change.
3. Outcomes recorded in the trace: waiting for a real tool that emits them, used for its own sake (Alper's own agents count; our bench doesn't, since we'd write both ends). Most likely the OTel `gen_ai.evaluation.result` event (experimental, usually sent as a log record, which `record` drops today). Decided 2026-11-24: no `--outcome-attr` of our own invention.
These are what let trade-off levers (model choice, context size) be advised.

Later, unordered:
- `diff`: findings added/removed; Markdown output; a GitHub Action.
- Capture gaps: a lost automatic cache on OpenAI/Gemini (they report cache reads but no writes, so `cache-thrash` never fires there; seen on a real capture, `openai-agents-explain.jsonl` prefix run: 0 reads, +22-45% cost, no finding); caching off on a volatile prefix reports nothing; failed legacy `ai.*` runs aren't recognized as model calls; an attempt hidden inside an SDK retry is invisible in the trace (don't flag warm starts as retries).
- Rules, only once a real trace shows money there: `oversized-tool-result`, `retry-loop`, `context-growth`. `model-overkill` after outcomes (counterfactual, needs careful wording).
- More dialect mappers, each from a real capture: Claude Code OTel spans (`claude_code.*`, needs CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1; tool inputs need OTEL_LOG_TOOL_DETAILS=1), Codex CLI rollout JSONL + OTel, Gemini CLI (`gemini_cli.*`, `outfile` setting), Qwen Code (`qwen-code.*`).
- An MCP server over the JSON output: a cheap add-on, not a priority.

Dated log of all of the above: NOTES.md.

Benchmark protocol for new sources: 3 fixed tasks, each run normally and with a deliberately wasteful setup, so every rule is shown to fire and to stay silent. For a trade-off rule, also run each task with the suggested fix applied and compare task success (tests pass) and cost; the rule only advises once success holds.

## Related projects

- ccusage: usage totals for coding-agent CLIs. Reference for native log parsing (MIT).
- AshwinUgale/tracelint: structural-defect linter for agent traces (correctness, not cost). Different job; don't copy its rules or naming.

## Conventions

- TypeScript strict, ESM, Node >= 20, node:test.
- Commit messages: plain, describe the change only. No Co-Authored-By trailers.
