# burnlint

CLI that lints agent traces for avoidable token spend. Each finding has a rule id, severity, location and an estimated USD cost. Reads Claude Code session logs and OpenTelemetry GenAI (OTLP/JSON) traces. Framework-agnostic by design: new agents are supported by adding a reader or a dialect mapper, never by special-casing rules.

## Commands

- `npm install`
- `npm test` builds (tsc) and runs node:test on `dist/test/*.test.js`
- `node dist/cli.js audit <paths>` (no path = `~/.claude/projects`)
- `npm run update-prices` refreshes `src/pricing/prices.json` from LiteLLM

## Layout

- `src/model.ts` normalized model: Run > Turn > ModelCall + ToolCall, Tokens, Finding
- `src/adapters/` one reader per source format (`claude-code.ts`, `otlp.ts`)
- `src/rules/` one pure function per rule, registered in `rules/index.ts`
- `src/pricing.ts` price lookup, cost math, provider inference/relabeling
- `src/audit.ts` file discovery, format detection, runs rules; `src/report.ts` table/json/md; `src/cli.ts`
- `fixtures/` real traces only (redacted), plus the script that generated each one

## Principles

- Local only. No network calls at runtime, never print message content.
- Unknown is not zero. Missing usage = unpriced; missing cache fields = cache unknown (price as uncached, mark as upper bound, cache rules skip the call).
- False positives are worse than misses. A rule must stay silent when it can't tell (e.g. repeat detection resets on writes, shell commands and new human messages).
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

## Roadmap (M2, in order)

1. `burnlint record`: local OTLP/HTTP receiver on 127.0.0.1:4318 writing JSONL that `audit` reads. JSON encoding first. Most CLIs default to protobuf: decide with Alper between a protobuf dependency and documenting `OTEL_EXPORTER_OTLP_PROTOCOL=http/json`.
2. Rules: `oversized-tool-result`, `retry-loop`, `context-growth`. `model-overkill` later (counterfactual, needs careful wording).
3. Dialect mappers, each from a real capture: Claude Code OTel spans (`claude_code.*`, needs CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1; tool inputs need OTEL_LOG_TOOL_DETAILS=1), Codex CLI rollout JSONL + OTel, Gemini CLI (`gemini_cli.*`, `outfile` setting), Qwen Code (`qwen-code.*`), OpenInference, Vercel AI SDK `ai.*`.
4. `burnlint diff <base> <head>` for CI, then a GitHub Action.
5. npm publish (name `burnlint` was free on npm, PyPI and GitHub as of Nov 2026).

Benchmark protocol for new sources: 3 fixed tasks, each run normally and with a deliberately wasteful setup, so every rule is shown to fire and to stay silent.

## Related projects

- ccusage: usage totals for coding-agent CLIs. Reference for native log parsing (MIT).
- AshwinUgale/tracelint: structural-defect linter for agent traces (correctness, not cost). Different job; don't copy its rules or naming.

## Conventions

- TypeScript strict, ESM, Node >= 20, node:test.
- Commit messages: plain, describe the change only. No Co-Authored-By trailers.
