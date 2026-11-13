# burnlint

CLI that lints agent traces for avoidable token spend. Each finding has a rule id, severity, location and an estimated USD cost. Reads Claude Code session logs and OpenTelemetry GenAI (OTLP/JSON) traces. Framework-agnostic by design: new agents are supported by adding a reader or a dialect mapper, never by special-casing rules.

## Commands

- `npm install`
- `npm test` builds (tsc) and runs node:test on `dist/test/*.test.js`
- `node dist/cli.js audit <paths>` (no path = `~/.claude/projects`)
- `node dist/cli.js record -o run.jsonl` (OTLP/HTTP JSON receiver on 127.0.0.1:4318, Ctrl-C to stop)
- `npm run update-prices` refreshes `src/pricing/prices.json` from LiteLLM

## Layout

- `src/model.ts` normalized model: Run > Turn > ModelCall + ToolCall, Tokens, Finding
- `src/adapters/` one reader per source format (`claude-code.ts`, `otlp.ts`)
- `src/rules/` one pure function per rule, registered in `rules/index.ts`
- `src/pricing.ts` price lookup, cost math, provider inference/relabeling
- `src/record.ts` OTLP/HTTP receiver for `record`: appends each trace export as one JSONL line, body written as received
- `src/audit.ts` file discovery, format detection, runs rules; `src/report.ts` table/json/md; `src/cli.ts`
- `fixtures/` real traces only (redacted), plus the script that generated each one

## Principles

- Local only. No network calls at runtime, never print message content.
- Unknown is not zero. Missing usage = unpriced; missing cache fields = cache unknown (price as uncached, mark as upper bound, cache rules skip the call).
- False positives are worse than misses. A rule must stay silent when it can't tell. Repeat detection resets on writes, shell commands and new human messages; never reports shell commands or polling tools; and treats a different result as "the world changed". `duplicate-tool-call` requires both results known and equal. Tool kinds (read/write/shell/other), path normalization and the polling-name list live in `src/tools.ts`, not in rules.
- Findings never include tool inputs (queries, commands). Paths and tool names are fine.
- burnlint measures cost, not output quality. Every finding has a `fix` effect: `no-loss` (the fix removes only what the model already had) or `trade-off` (it changes what the model sees or which model runs). Only no-loss findings get `avoidableUsd`, net of what the fix itself costs (cache-thrash expiry assumes a keep-alive for up to `keepAliveHours`, default 12, never hindsight). Trade-off rules (`context-growth`, `model-overkill`) report cost only, until a benchmark shows task success holds.
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

## Roadmap (M2, in order)

1. `burnlint record`: JSON encoding is done (traces only; logs and metrics are acknowledged and dropped). Protobuf exports are refused with 415 and a hint to set `OTEL_EXPORTER_OTLP_PROTOCOL=http/json`. Still open, to decide with Alper: add protobuf decoding (a dependency, or a hand-written decoder for the trace messages) or keep documenting `http/json`. Not yet checked against a real agent CLI, only against the OTel JS exporter.
2. Rules: `oversized-tool-result`, `retry-loop`, `context-growth`. `model-overkill` later (counterfactual, needs careful wording).
3. Dialect mappers, each from a real capture: Claude Code OTel spans (`claude_code.*`, needs CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1; tool inputs need OTEL_LOG_TOOL_DETAILS=1), Codex CLI rollout JSONL + OTel, Gemini CLI (`gemini_cli.*`, `outfile` setting), Qwen Code (`qwen-code.*`), OpenInference, Vercel AI SDK `ai.*`.
4. `burnlint diff <base> <head>` for CI, then a GitHub Action.
5. npm publish (name `burnlint` was free on npm, PyPI and GitHub as of Nov 2026).

Benchmark protocol for new sources: 3 fixed tasks, each run normally and with a deliberately wasteful setup, so every rule is shown to fire and to stay silent. For a trade-off rule, also run each task with the suggested fix applied and compare task success (tests pass) and cost; the rule only advises once success holds.

## Related projects

- ccusage: usage totals for coding-agent CLIs. Reference for native log parsing (MIT).
- AshwinUgale/tracelint: structural-defect linter for agent traces (correctness, not cost). Different job; don't copy its rules or naming.

## Conventions

- TypeScript strict, ESM, Node >= 20, node:test.
- Commit messages: plain, describe the change only. No Co-Authored-By trailers.
