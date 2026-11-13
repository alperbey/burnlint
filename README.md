# burnlint

What do your agent's runs cost, and how much of that was avoidable?

burnlint reads agent traces and reports cost per run (typical, 90th percentile, at your monthly volume) and the spend that was avoidable: repeated tool calls, files read twice, prompt caches rebuilt mid-run. Each finding comes with a severity, what the pattern cost, and how much of that a fix could have saved without taking anything away from the model. `--fail-on` turns it into a CI check.

It works on any agent, not one framework:

- **Claude Code** session logs (`~/.claude/projects/**/*.jsonl`), no setup needed
- **OpenTelemetry GenAI traces** (`gen_ai.*` spans, OTLP/JSON), which most agent SDKs and CLIs can emit

Everything runs locally. No network calls, and message content is never printed.

```
npx burnlint audit                      # your Claude Code history
npx burnlint audit traces.json          # an OTLP/JSON export
npx burnlint audit ./traces --runs-per-month 20000  # what it comes to at your volume
npx burnlint audit ./traces --fail-on high -f md   # CI, Markdown for PR comments
npx burnlint record -o run.jsonl        # capture OTLP traces from a running agent
```

## Example

From a real Claude Code session (project name and session id replaced):

```
burnlint  1 run in 1 file

  spent        $5.08   $5.08 per run · median $5.08 · p90 $5.08 · max $5.08
  in findings  $1.22   1 finding
  avoidable    $1.22   $1.22 per run, 24.0% of spend, without taking anything away from the model

myproject 3f2a9c1e  $1.22 savable of $1.22
  high  $1.22  $1.22  cache-thrash  1 cache rewrite after the prompt prefix changed
```

The session was resumed in a new environment, which changed the system prompt and forced the whole 156k-token context to be written to cache again at the 1-hour rate. That one call was a quarter of the session's cost. `-v` lists each occurrence (`turn 66 · 156k tokens · $1.22`) and the log file.

A run is one unit of agent work: an OTLP trace, or a Claude Code session together with the sub-agents it started. The header gives the cost per run as a mean, median, 90th percentile and maximum, and avoidable spend per run and as a share of the total. With `--runs-per-month <n>` it adds what both come to in a month at that volume (mean cost per run × n). Runs with no priced call (every call failed, or none reported usage) are left out of these figures and counted in the header, so a run that failed at its first call doesn't show up as a $0 run. Runs with some unpriced calls are counted, and the header says how many: their cost is a lower bound.

Findings are grouped by session (or trace), the one where fixes would save most first. Each line has the severity, what fixing it would save, what it cost, the rule and what happened. In a terminal, long lines wrap to its width; piped, each finding stays on one line.

From an agent calling DeepSeek through the OpenAI client, traced with the official OpenTelemetry instrumentation (`fixtures/otel-deepseek-via-openai.json`):

```
deepseek-demo-agent 5f017722  $0.0004 savable of $0.0004
  low  $0.0004  $0.0004  reread-unchanged  src/app.py read 2x with no change in between (turns 1, 2)

Notes
  - deepseek-demo-agent 5f017722: 3 call(s) relabeled by model/server: openai -> deepseek
  - deepseek-demo-agent 5f017722: 3 call(s) report no cache usage; their cost is an upper bound (cached tokens priced at full rate)
```

## Recording a running agent

`burnlint record` is a local OTLP/HTTP receiver. It saves the traces an agent exports so they can be audited, without a collector or a tracing backend.

```
burnlint record -o run.jsonl
```

In another terminal, run the agent with its OpenTelemetry export pointed at the recorder:

```
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 \
OTEL_EXPORTER_OTLP_PROTOCOL=http/json \
  your-agent ...
```

Stop the recorder with Ctrl-C, then `burnlint audit run.jsonl`.

- **JSON encoding only for now.** Many SDKs and CLIs export protobuf unless told otherwise, hence `OTEL_EXPORTER_OTLP_PROTOCOL=http/json`. A protobuf export is refused with HTTP 415 and counted in the summary; nothing is dropped silently. Gzip-compressed JSON is accepted.
- It listens on `127.0.0.1` only (port 4318, change with `--port`) and forwards nothing.
- Each trace export becomes one line of the output file, written as received. Recording to an existing trace file appends to it.
- The file holds whatever the agent exports. With content capture turned on in the agent that includes prompts and tool results, so it is created readable by your user only (mode 0600). burnlint never prints that content.
- Only traces are kept. Log and metric exports are accepted and discarded, and the summary says how many.
- The agent still has to have telemetry switched on. How to do that differs per agent and is not something `record` can do for it.

## Rules

| Rule | Flags | Cost | Savable |
|---|---|---|---|
| `duplicate-tool-call` | Same tool, identical input and identical result, nothing written and no shell command in between, earlier call didn't fail | Repeated result tokens, carried through the rest of the run | All of it |
| `reread-unchanged` | Same file and range read again, same content returned, with no write to it (under any spelling of the path) and no shell command in between | Same | All of it |
| `cache-thrash` | A call that reads back at least 1,024 fewer tokens from the prompt cache than the previous call left in it, and writes them again. A large write alone doesn't count: new content has to be written once. One finding per cause: cache expired, prompt prefix changed, model switched | The lost tokens written again, at the write rate minus the read rate (what a stable prefix would have saved) | Expired: net of a keep-alive (below). Prefix changed: all of it. Model switched: trade-off |

### Cost, savable and trade-offs

**Cost** is what the pattern cost. **Savable** is what fixing it would have saved, counted only for fixes that take nothing away from the model and net of what the fix itself costs. The header's **avoidable** is the sum of these.

- **No loss**: the model loses only what it already had. A repeated tool result or a second copy of an unchanged file adds nothing. Rewriting an unchanged prompt to the cache costs money without changing what the model sees.
- **Trade-off**: the fix changes what the model sees or which model runs: compacting, starting fresh, a smaller model. Output quality may change, and a trace can't show whether it would. These findings show their cost with `trade-off` in place of a saving and are left out of "avoidable".

A cache that expired during a break could have been kept warm by re-sending the prompt shortly before the cache lifetime runs out, each time billed as a cache read. Nobody knows in advance how long a break will be, so the saving assumes a fixed policy: keep the cache warm for up to 12 hours, then give up. A break under 12 hours saves the rewrite and pays for its keep-alives. A longer break pays for 12 hours of keep-alives and the rewrite as well, so its saving is negative. Sessions that were never resumed would also have been kept warm, and that cost isn't included. The Claude Code logs checked so far show no keep-alive traffic, so the figure is what one would be worth, not something a setting gives you today.

The repeat rules stay silent when the trace can't show that a call was redundant:

- A new human message resets them, since the person may have changed things outside the agent.
- Shell commands are never reported as duplicates. Their output depends on state the trace doesn't show, and anything read before one may have changed.
- A call that returned something different from last time learned something, so it is not a repeat. `duplicate-tool-call` needs the results in the trace for this; without them it reports nothing.
- Tools that poll by name (`get_job_status`, `wait_for_…`, `ping`) and reads of URLs are not treated as repeats.

Findings name the tool and the turns, or the file path. They never include tool inputs such as queries or commands.

Exit codes: `0` audited, `1` a finding at or above `--fail-on`, `2` bad options or nothing to audit (no agent runs found in the given paths).

Severity is set by what fixing the finding would save: `high` from $1, `medium` from $0.10 (change with `--high-usd` / `--medium-usd`), `low` below that. Trade-offs, and fixes that would save nothing (an idle break longer than the keep-alive), are `info`: shown, but never failing `--fail-on`.

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

Accepts a single export request, an array of them, or JSONL with one per line (the OTel Collector file exporter format, and what `burnlint record` writes).

- Model calls: spans with `gen_ai.operation.name` of `chat`, `generate_content`, `text_completion`, or carrying `gen_ai.usage.*`. Parent spans that only sum their children's usage are skipped.
- Tool calls: `execute_tool` spans. Duplicate and reread rules need `gen_ai.tool.call.arguments`, which most instrumentations only record with content capture turned on.
- Provider: read from `gen_ai.provider.name` or the older `gen_ai.system`, then checked against `server.address` and the model name. Calls to DeepSeek, Qwen and others made through an OpenAI-compatible client are reported as `openai` by the instrumentation and get relabeled, so they are priced correctly.
- `gen_ai.usage.input_tokens` is taken as the total prompt; `cache_read` / `cache_creation` input tokens are subtracted when present. DeepSeek's own cache field is read if an instrumentation records it.

## Related tools

- [ccusage](https://github.com/ryoppippi/ccusage) reports how much coding-agent CLIs spent, by day, session and model. burnlint reports which part of that spend was avoidable.
- [tracelint](https://github.com/AshwinUgale/tracelint) checks agent traces for structural defects (correctness), using OpenInference traces. burnlint checks for waste (cost). The two can run side by side in CI.

## Status

v0.1. Working: Claude Code logs, gen_ai OTLP, three rules, table / JSON / Markdown output, `record` for OTLP/HTTP JSON.

Next:

- More rules: `oversized-tool-result`, `retry-loop`, `context-growth`
- Protobuf in `burnlint record`, so agents that cannot switch to `http/json` can be recorded too
- Dialect mappers checked against real exports: Codex CLI, Gemini CLI, Qwen Code, Claude Code OTel spans, OpenInference, Vercel AI SDK
- `burnlint diff` for comparing a branch against a baseline in CI

## Development

```
npm install
npm test
```

`scripts/gen-record-fixture.mjs` regenerates the `record` fixture by sending spans through the official OpenTelemetry JS OTLP exporter to a running `burnlint record` (package versions are pinned in the script).

`scripts/gen-otel-deepseek-fixture.py` regenerates the OTel fixture by running the official `opentelemetry-instrumentation-openai-v2` against a local mock DeepSeek server (needs `openai`, `opentelemetry-sdk`, `opentelemetry-instrumentation-openai-v2==2.3b0`, `opentelemetry-exporter-otlp-proto-common`, `wrapt<2`).

## License

MIT
