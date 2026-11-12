# burnlint

Lint agent traces for wasted tokens and money.

Usage trackers tell you how much an agent spent. burnlint points at the spend that was avoidable: repeated tool calls, files read twice, prompt caches rebuilt mid-run. Each finding comes with a severity and an estimated dollar cost, and `--fail-on` turns it into a CI check.

It works on any agent, not one framework:

- **Claude Code** session logs (`~/.claude/projects/**/*.jsonl`), no setup needed
- **OpenTelemetry GenAI traces** (`gen_ai.*` spans, OTLP/JSON), which most agent SDKs and CLIs can emit

Everything runs locally. No network calls, and message content is never printed.

```
npx burnlint audit                      # your Claude Code history
npx burnlint audit traces.json          # an OTLP/JSON export
npx burnlint audit ./traces --fail-on high -f md   # CI, Markdown for PR comments
```

## Example

From a real Claude Code session:

```
burnlint  1 run(s) in 1 file(s)  ·  total $5.08  ·  avoidable $1.22

SEV   RULE           COST   TOKENS  FINDING
high  cache-thrash  $1.22  156,248  1 cache rewrite(s), 156,248 tokens, prompt prefix changed between calls (turn 66: 156,248 tokens)
```

The session was resumed in a new environment, which changed the system prompt and forced the whole 156k-token context to be written to cache again at the 1-hour rate. That one call was a quarter of the session's cost.

From an agent calling DeepSeek through the OpenAI client, traced with the official OpenTelemetry instrumentation (`fixtures/otel-deepseek-via-openai.json`):

```
SEV  RULE                 COST  TOKENS  FINDING
low  reread-unchanged  $0.0004   1,350  src/app.py read 2x with no change in between (turns 1, 2)

Notes
  - 3 call(s) relabeled by model/server: openai -> deepseek
  - 3 call(s) report no cache usage; their cost is an upper bound (cached tokens priced at full rate)
```

## Rules

| Rule | Flags | Estimated cost |
|---|---|---|
| `duplicate-tool-call` | Same tool, identical input, nothing written in between, earlier call didn't fail | Repeated result tokens, carried through the rest of the run |
| `reread-unchanged` | Same file and range read again with no write to it (or shell command) in between | Same |
| `cache-thrash` | A turn after the first that writes more to the prompt cache than it reads, above 20k tokens | Rewritten tokens at the write rate minus the read rate |

Repeat detection resets when a new human message arrives, since the person may have changed things outside the agent.

Severity is set by cost: `high` from $1, `medium` from $0.10 (change with `--high-usd` / `--medium-usd`).

## How costs are calculated

- Prices come from a bundled snapshot of LiteLLM's model price table (MIT), with the retrieval date shown in every report. Override or add models with `--prices prices.json` (USD per 1M tokens: `input`, `output`, `cacheRead`, `cacheWrite5m`, `cacheWrite1h`). Refresh with `npm run update-prices`.
- Cache reads and 5-minute vs 1-hour cache writes are priced separately when the source reports them.
- Missing data is treated as unknown, never as zero:
  - Calls without usage are left unpriced and counted in the notes.
  - When a trace has no cache attributes, cache usage is unknown. The call is priced as if nothing was cached (an upper bound), and cache rules skip it.
- A tool result that enters context is charged once at the cache-write rate, then at the cache-read rate for every later turn.

These are estimates. For Claude Code logs the total matches an independent calculation from the raw usage fields; check against your provider's billing page before relying on absolute numbers.

## Trace sources

### Claude Code logs

Read directly. Handled quirks:

- One API response is often written as several lines sharing a message ID with the usage repeated. Usage is counted once.
- Records with zero or null usage (imported history) are unpriced, not free.
- Sub-agent (sidechain) work becomes its own run.

### OpenTelemetry GenAI (OTLP/JSON)

Accepts a single export request, an array of them, or JSONL with one per line (the OTel Collector file exporter format).

- Model calls: spans with `gen_ai.operation.name` of `chat`, `generate_content`, `text_completion`, or carrying `gen_ai.usage.*`. Parent spans that only sum their children's usage are skipped.
- Tool calls: `execute_tool` spans. Duplicate and reread rules need `gen_ai.tool.call.arguments`, which most instrumentations only record with content capture turned on.
- Provider: read from `gen_ai.provider.name` or the older `gen_ai.system`, then checked against `server.address` and the model name. Calls to DeepSeek, Qwen and others made through an OpenAI-compatible client are reported as `openai` by the instrumentation and get relabeled, so they are priced correctly.
- `gen_ai.usage.input_tokens` is taken as the total prompt; `cache_read` / `cache_creation` input tokens are subtracted when present. DeepSeek's own cache field is read if an instrumentation records it.

## Related tools

- [ccusage](https://github.com/ryoppippi/ccusage) reports how much coding-agent CLIs spent, by day, session and model. burnlint reports which part of that spend was avoidable.
- [tracelint](https://github.com/AshwinUgale/tracelint) checks agent traces for structural defects (correctness), using OpenInference traces. burnlint checks for waste (cost). The two can run side by side in CI.

## Status

v0.1. Working: Claude Code logs, gen_ai OTLP, three rules, table / JSON / Markdown output.

Next:

- More rules: `oversized-tool-result`, `retry-loop`, `context-growth`
- `burnlint record`: a local OTLP receiver, so any OTel-capable agent can be audited with one environment variable
- Dialect mappers checked against real exports: Codex CLI, Gemini CLI, Qwen Code, Claude Code OTel spans, OpenInference, Vercel AI SDK
- `burnlint diff` for comparing a branch against a baseline in CI

## Development

```
npm install
npm test
```

`scripts/gen-otel-deepseek-fixture.py` regenerates the OTel fixture by running the official `opentelemetry-instrumentation-openai-v2` against a local mock DeepSeek server (needs `openai`, `opentelemetry-sdk`, `opentelemetry-instrumentation-openai-v2==2.3b0`, `opentelemetry-exporter-otlp-proto-common`, `wrapt<2`).

## License

MIT
