# burnlint

**One line in a system prompt can make every agent run cost 4× more, and your tests will still pass.** burnlint catches it before it ships.

We added the current time to an agent's system prompt. It broke the prompt cache on every call: each run cost 4.4 times as much, and 8 of 9 runs still passed. Nothing failed and nothing logged an error. The only place it showed was the bill.

burnlint reads your agent's traces and answers:

- **Did this change make runs more expensive?** Before/after cost per run, with a significance test so run-to-run noise doesn't fail your build (`diff --fail-above`).
- **What does a run cost at my volume?** Typical, 90th percentile, and per month.
- **What does a *successful* run cost?** Give it pass/fail per run. A cheaper agent that fails more often isn't cheaper.
- **Where did money go for nothing?** Prompt caches rebuilt mid-run, files reread unchanged, the same tool called twice: each priced, with what a fix saves.

Try it on your Claude Code history, no setup: `npx burnlint audit`

## Use this when

- Did my prompt change make agent runs more expensive? Is the rise real or noise?
- Agent cost regression: block a PR that makes runs cost more (`diff --fail-above 15`)
- Is the cheaper model worth it, or does it fail more often? (cost per successful run)
- What will this agent cost per month at 20,000 runs?
- Why did this agent run cost so much more than the others?
- Claude Code session cost spiked after resume, or `cache_creation_input_tokens` jumped
- The agent reads the same file over and over, or calls the same tool twice
- Prompt caching is on, but the cache keeps getting rewritten (Anthropic), or caching was never turned on

It works on any agent, not one framework:

- **Claude Code** session logs (`~/.claude/projects/**/*.jsonl`), no setup needed
- **OpenTelemetry GenAI traces** (`gen_ai.*` spans, OTLP/JSON), which most agent SDKs and CLIs can emit
- **OpenInference traces** (`openinference.span.kind` spans), checked on the OpenAI Agents SDK
- Any of these as protobuf or JSON, recorded from a running agent with `burnlint record`

Everything runs locally. No network calls, and message content is never printed.

```
npx burnlint audit                      # your Claude Code history
npx burnlint audit traces.json          # an OTLP/JSON export
npx burnlint audit ./traces --runs-per-month 20000  # what it comes to at your volume
npx burnlint audit ./traces --fail-on high -f md   # CI, Markdown for PR comments
npx burnlint record -o run.jsonl        # capture OTLP traces from a running agent
npx burnlint diff base.jsonl head.jsonl --fail-above 15  # did this change make runs cost more?
npx burnlint diff base/ head/ --outcomes outcomes.jsonl  # ...and do they still pass?
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

## Comparing before and after

`burnlint diff <base> <head>` compares cost per run between two sets of runs of the same tasks: before and after a prompt, tool or model change. Each side is a trace file or a folder. How the test works and how to use it in CI: [docs/diff.md](docs/diff.md).

```
$ burnlint diff normal.jsonl reread.jsonl --group-by bench.task
burnlint diff  grouped by bench.task

  base  9 runs  normal.jsonl
  head  9 runs  reread.jsonl

  cost per run  $0.081 → $0.111   higher, +38% (p<0.001)
                at base's mix of groups · run-to-run noise here: about ±11% · exact test over 8,000 relabelings

  group      side  runs    mean  median     min     max  calls  prompt tok  output tok  cache
  review     base     3  $0.133  $0.126  $0.124  $0.149    6.0     166,457       3,137    79%
             head     3  $0.183  $0.177  $0.171  $0.201    9.0     296,342       4,201    84%  +38%
  explain    base     3  $0.042  $0.042  $0.040  $0.043    5.3      22,097       1,985    62%
             head     3  $0.057  $0.060  $0.051  $0.060    6.7      35,708       2,236    64%  +35%
  principle  base     3  $0.067  $0.071  $0.061  $0.071    7.0      54,757       3,211    77%
             head     3  $0.095  $0.098  $0.088  $0.098    7.7      67,243       3,889    70%  +41%
  per run means; cache = cache reads as a share of prompt tokens
```

(Nine runs of the bench agent, each task run normally and then told to reread files before answering. The captures hold prompts and aren't in the repo.)

- **Groups.** Runs are compared within groups, so a head that happened to run more of the cheap task doesn't look cheaper. The default group is `gen_ai.agent.name` (the Vercel AI SDK's `functionId`), then the Claude Code project, else all runs in one group. `--group-by <key>` uses any attribute on a trace's root span, such as a task or input id the harness sets. A key that no run has is refused. Keys whose names look like content (`input`, `prompt`, `output`, ...) are never kept as labels, except the one you name in `--group-by`: `--group-by bench.input_id` works, and its values are short scalars like every label.
- **Overall.** The headline is the mean of the group means, weighted by base's mix of runs. When the two sides ran groups in different proportions, the plain pooled means are shown too. Groups with runs on one side only are listed and left out.
- **Noise.** Agent runs vary a lot from run to run (the same task cost $0.11 to $0.24 over three runs in one capture). The verdict comes from a permutation test: within each group, runs are relabeled base/head in every possible way, and the observed change is compared with what relabeling gives. With one run per group on each side this becomes a sign test over the groups. `too few runs` means no outcome of these runs could be told from noise. The noise figure is about two standard errors of the change.
- **Same inputs.** Both sides must run the same tasks on the same inputs. An agent whose task reads the repo it runs in costs more as the repo grows, with no change to the agent: our own bench rose 11% in a day for that reason. Pin what the agent reads (a fixed commit, fixed documents).
- **CI.** `--fail-above <pct>` exits 1 when the measured rise is above that and the runs show a rise clearly (one-sided p < 0.05). With it set, the headline judges a rise the same way, so the two always agree; a fall is still judged two-sided. It doesn't test that the rise exceeds the threshold, so with many runs a measured 10.5% with a wide spread fails a 10% gate. A rise the runs can't separate from noise prints a warning and passes. False alarms in CI are worse than a late catch. A simulation at the run-to-run noise of our bench gave these detection rates with 3 runs per task: a 10% rise about half the time, 15% most of the time (86%), 20% almost always. To catch 10%, use 5 or more runs per task.
- **What it won't call.** If either side has runs with calls that have no price (an unknown model, or no usage), the verdict is `can't tell`, and `--fail-above` exits 2. Add the price with `--prices`. Runs with a failed call are counted per side. A failed call has no usage in the trace but may still be billed (a response cut off at its output limit is), and a failed run usually stops early, so the output notes them and when head has more of them. A change of model is noted as a trade-off: cost alone doesn't show whether the work still gets done. Add `--outcomes` to see that next to cost.
- A run is counted as in `audit`: an OTLP trace, or a Claude Code session with its sub-agents.

### Success and cost per successful run

A cheaper run that does the work worse isn't cheaper. burnlint doesn't judge output; your tests or evals do, and `--outcomes <file>` joins their verdicts to cost, on `audit` and `diff`. The file has one JSON object per line:

```
{"run": "71416a2f7d5e9561c2d933c805b5cd61", "pass": true}
{"run": "69227109187db8b6eb5277e875078c69", "pass": false, "score": 0.4, "notes": "..."}
```

`run` is the run's OTLP trace id (hex, or base64 as some exporters write it, padded or not, standard or URL-safe) or its Claude Code session id. `pass` is `true` or `false`. Other keys are ignored and never printed. A line that can't be read, or a run listed both as pass and fail, is refused with its line number; a file none of whose ids match a run exits 2 (usually the wrong file or the wrong id).

What counts as a failure is yours to decide, but one rule keeps the numbers honest: **`false` when your agent ran and didn't deliver, for any reason of its own** (a wrong answer, its turn limit, its cost cap, a response cut off at its output limit); **no row only when you couldn't grade it or something outside the agent broke** (a provider outage, a rate limit, the harness). A run with no row is unknown, never a failure. Leaving out the runs that hit their own limits drops the likeliest and often most expensive failures.

`audit` adds a line:

```
  per success  $0.085   17 of 22 runs passed (77.3%) · $1.45 on those 22 ÷ 17 passes, failed runs included · no outcome for 2 of 24
```

Cost per successful run is everything spent on runs with an outcome, passed or failed, divided by the passes: what one success costs you. Every run with an outcome counts, including runs that never got a priced call (they're left out of cost per run, but they are usually failures); when any such run has calls without a price or usage, the figure is marked as a lower bound.

`diff` compares success the way it compares cost: per group, at base's mix of groups, with the same permutation test (on failures instead of dollars), and shows passes per group. Cost per success gets a verdict of its own: the same test, with each run keeping its cost and its outcome together, on the ratio head / base (a side with no passes has an infinite cost per success). The same normal and reread runs as above, with the bench's grades as outcomes (every run passed, so a success costs what a run does):

```
$ burnlint diff normal.jsonl reread.jsonl --group-by bench.task --outcomes outcomes.jsonl
  ...
  cost per run  $0.081 → $0.111   higher, +38% (p<0.001)
                at base's mix of groups · run-to-run noise here: about ±11% · exact test over 8,000 relabelings
  success       100.0% → 100.0%   no change
                passed 9/9 → 9/9 · at base's mix of groups
  per success   $0.081 → $0.111   higher, +38% (p<0.001)
                all spend on runs with an outcome ÷ passes, failed runs included

  group      side  runs    mean  ...  cache  passed
  review     base     3  $0.133  ...    79%     3/3
             head     3  $0.183  ...    84%     3/3  +38%
  ...
```

If any compared run has no outcome, both the success and the cost-per-success verdicts are `can't tell`; so is cost per success when a run with an outcome has calls with no price or no usage. A failed call whose spend is unknown doesn't stop the verdict: the figures are marked as lower bounds. Cost per success has no CI gate yet; on 8,000 splits of 18 same-setup runs into base and head, its verdict called a change in 4.97% (the test's 5% level, as designed).

**Few runs can only show a collapse.** Pass/fail carries little information per run. In a single group of 3 runs, no drop is ever clear, not even 3/3 → 0/3. In one group of 5, 5/5 → 1/5 is; 5/5 → 2/5 isn't. Groups add up: 2 tasks × 3 runs show 6/6 → 1/6, 3 tasks × 5 runs show 15/15 → 10/15. These are for the CI gate (one-sided p < 0.05); without `--fail-success-drop`, the verdict is two-sided and needs a little more. The test is much stronger when each input is its own group (`--group-by` with an input id on the root span): it then works like a sign test. Five inputs that flip from pass to fail, with none flipping back, fail the gate (p = 1/32); without the gate, the verdict calls it clear from six.

**CI.** `--fail-success-drop <points>` exits 1 when the success rate fell more than that many percentage points and the runs show a drop clearly (one-sided p < 0.05). A drop the runs can't show prints a warning and passes; a compared run with no outcome exits 2. The gate runs even when cost can't be compared (a head whose runs all failed before a priced call): a clear drop still exits 1. It is separate from `--fail-above`, which stays about cost; with both set, either can fail the build. Without the success gate, a drop in success is still written to stderr, so a green cost check doesn't hide it.

## Recording a running agent

`burnlint record` is a local OTLP/HTTP receiver. It saves the traces an agent exports so they can be audited, without a collector or a tracing backend.

```
burnlint record -o run.jsonl
```

In another terminal, run the agent with its OpenTelemetry export pointed at the recorder:

```
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 \
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf \
  your-agent ...
```

Stop the recorder with Ctrl-C, then `burnlint audit run.jsonl`.

- **OTLP/HTTP, protobuf or JSON**, gzip-compressed or not. gRPC is not supported: an agent that defaults to it (many Python setups do) needs `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf` or `http/json`. The protobuf decoder is part of burnlint (no dependency), checked against the OpenTelemetry JS exporters: a protobuf export decodes to what the JSON exporter sends for the same spans. An export that can't be read is refused with an error the agent's SDK reports, and counted in the summary; nothing is dropped silently.
- It listens on `127.0.0.1` only (port 4318, change with `--port`) and forwards nothing.
- Each trace export becomes one line of the output file: JSON as received, protobuf converted to the same OTLP/JSON form. Recording to an existing trace file appends to it.
- The file holds whatever the agent exports. With content capture turned on in the agent that includes prompts and tool results, so it is created readable by your user only (mode 0600). burnlint never prints that content.
- Only traces are kept. Log and metric exports are accepted and discarded, and the summary says how many.
- The agent still has to have telemetry switched on. How to do that differs per agent and is not something `record` can do for it.

## Rules

| Rule | Flags | Cost | Savable |
|---|---|---|---|
| [`duplicate-tool-call`](docs/rules/duplicate-tool-call.md) | Same tool, identical input and identical result, nothing written and no shell command in between, earlier call didn't fail | Repeated result tokens, carried through the rest of the run | All of it |
| [`reread-unchanged`](docs/rules/reread-unchanged.md) | File content read again with no write to it (under any spelling of the path) and no shell command in between. When reads return numbered lines (Claude Code `Read`, `N<TAB>text`), any overlap counts: a range inside an earlier one, a whole file after a range, or a partial overlap of 10+ lines; every repeated line must come back unchanged. Other reads must repeat exactly: same path, input and content | The repeated lines' share of the result, carried through the rest of the run | All of it |
| [`cache-thrash`](docs/rules/cache-thrash.md) | A call that reads back at least 1,024 fewer tokens from the prompt cache than the previous call left in it, and writes them again. A large write alone doesn't count: new content has to be written once. One finding per cause: cache expired, prompt prefix changed, model switched. When the trace records the prompt, it names what changed (tool definitions, system prompt, an earlier message, or 20+ blocks added in one step, beyond the cache lookback); a rewrite with the prefix unchanged has an unknown cause and isn't counted as savable | The lost tokens written again, at the write rate minus the read rate (what a stable prefix would have saved) | Expired: net of a keep-alive (below). Prefix changed: all of it. Model switched: trade-off |
| [`no-prompt-cache`](docs/rules/no-prompt-cache.md) | A run on Anthropic (API or Vertex) that cached nothing (cache fields reported, all zero) while its calls re-sent a growing prompt above the model's minimum cacheable size. Silent for providers that cache on their own, Bedrock, unknown models and unknown cache fields. When the trace records the prompt, a call counts as a cache hit only if its prefix is the previous call's (same tools, system prompt and earlier messages); otherwise the saving is labeled "up to", an upper bound | Repeated prefix tokens sent at the full rate, at the input rate minus the cache read rate | Net of cache writes, against a 5-minute cache breakpoint at the end of each prompt; a shrinking prompt, a context reset or an idle gap near the 5-minute lifetime counts as a miss |

### Cost, savable and trade-offs

**Cost** is what the pattern cost. **Savable** is what fixing it would have saved, counted only for fixes that take nothing away from the model and net of what the fix itself costs. The header's **avoidable** is the sum of these.

- **No loss**: the model loses only what it already had. A repeated tool result or a second copy of an unchanged file adds nothing. Rewriting an unchanged prompt to the cache costs money without changing what the model sees.
- **Trade-off**: the fix changes what the model sees or which model runs: compacting, starting fresh, a smaller model. Output quality may change, and a trace can't show whether it would. These findings show their cost with `trade-off` in place of a saving and are left out of "avoidable".

A cache that expired during a break could have been kept warm by re-sending the prompt shortly before the cache lifetime runs out, each time billed as a cache read. Nobody knows in advance how long a break will be, so the saving assumes a fixed policy: keep the cache warm for up to 12 hours, then give up. A break under 12 hours saves the rewrite and pays for its keep-alives. A longer break pays for 12 hours of keep-alives and the rewrite as well, so its saving is negative. Sessions that were never resumed would also have been kept warm, and that cost isn't included. The Claude Code logs checked so far show no keep-alive traffic, so the figure is what one would be worth, not something a setting gives you today.

The repeat rules stay silent when the trace can't show that a call was redundant:

- A new human message resets them, since the person may have changed things outside the agent.
- Shell commands are never reported as duplicates. Their output depends on state the trace doesn't show, and anything read before one may have changed.
- A call that returned something different from last time learned something, so it is not a repeat. `duplicate-tool-call` and `reread-unchanged` need the results in the trace for this; without them they report nothing.
- A call that made only rereads isn't counted as savable: it may have returned new lines too, and putting code back at the end of the context can help. `reread-unchanged` shows what such a call cost in its details (`-v`).
- Tools that poll by name (`get_job_status`, `wait_for_…`, `ping`) and reads of URLs are not treated as repeats.

Findings name the tool and the turns, or the file path. They never include tool inputs such as queries or commands.

Exit codes: `0` audited, `1` a finding at or above `--fail-on`, `2` bad options or nothing to audit (no agent runs found in the given paths).

Severity is set by what fixing the finding would save: `high` from $1, `medium` from $0.10 (change with `--high-usd` / `--medium-usd`), `low` below that. Trade-offs, and fixes that would save nothing (an idle break longer than the keep-alive), are `info`: shown, but never failing `--fail-on`.

## How costs are calculated

- Prices come from a bundled snapshot of LiteLLM's model price table (MIT), with the retrieval date shown in every report. Override or add models with `--prices prices.json` (USD per 1M tokens: `input`, `output`, `cacheRead`, `cacheWrite5m`, `cacheWrite1h`). In a clone of this repo, `npm run update-prices` refreshes the snapshot.
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
- A span with error status and no usage is a failed call: unpriced, and noted, since the provider may still have billed it. A run whose calls all failed is counted apart, not as a $0 run.
- One trace can hold several conversations (a second agent call, a sub-agent). A call whose prompt is much smaller than the previous one (under 80%, and at least 1,024 tokens less) starts a new context, so repeat and cache rules start over there.

### Vercel AI SDK

Checked against AI SDK 7.0.157 with `@ai-sdk/otel` 1.0.157, on real captures (`fixtures/ai-sdk-v7-*.jsonl`).

- The default `OpenTelemetry` integration emits GenAI spans (`invoke_agent`, `chat`, `execute_tool`), read as above, cache reads and writes included.
- `LegacyOpenTelemetry` emits `ai.*` spans: one model call per `ai.generateText.doGenerate` / `ai.streamText.doStream` span (`ai.operationId`), cache reads and writes from `ai.usage.inputTokenDetails`, tool calls from `ai.toolCall` spans. AI SDK 6 and earlier emit this format by default; that has not been checked on a capture yet.
- Retries inside the SDK are one span: an attempt that failed before a retry leaves no trace of its own, so its cost can't be counted.
- Providers checked on real runs: `@ai-sdk/anthropic` 4.0.92, `@ai-sdk/deepseek` 3.0.76 (27 runs, tokens, cache reads and cost equal to DeepSeek's own usage) and `@ai-sdk/google` 4.0.108 (one run so far; thinking tokens count as output).

### OpenAI Agents SDK (via OpenInference)

Checked against `openai-agents` 0.24.0 with `openinference-instrumentation-openai-agents` 2.8.3 and the OpenTelemetry Python SDK 1.45.2, on real runs with gpt-5.4-mini (`fixtures/openai-agents-*.jsonl`): tokens and cost per run equal the SDK's own usage on every run checked.

```
pip install openai-agents openinference-instrumentation-openai-agents \
  opentelemetry-sdk opentelemetry-exporter-otlp-proto-http
```

```python
from openinference.instrumentation.openai_agents import OpenAIAgentsInstrumentor
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

provider = TracerProvider()
provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
OpenAIAgentsInstrumentor().instrument(tracer_provider=provider)
# ... run your agents, then provider.shutdown() so the last spans are sent
```

```
burnlint record -o run.jsonl      # in one terminal
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 \
OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT=10000 \
  python your_agent.py            # in another
```

- **Raise the attribute limit.** OpenInference writes every message of the conversation into the model span's attributes, and the Python SDK keeps 128 per span by default, dropping the oldest first: the token counts. Past about five calls in a conversation, calls lose their usage. burnlint reports those calls as lost to the limit, not as free, and doesn't price them. `OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT=10000` (or `SpanLimits(max_span_attributes=...)` on the provider) avoids it.
- The instrumentation replaces the SDK's own upload of traces to OpenAI by default, so traces go only where you export them.
- Model calls are `LLM` spans (model `llm.model_name`, provider `llm.system`); tool calls are `TOOL` spans, with their arguments and results. Cache reads come from `llm.token_count.prompt_details.cache_read`.
- OpenAI caches prompts on its own and reports cache reads but not writes. When a prompt prefix changes every call (a timestamp in the instructions), the cache is lost and the run costs more, but no rule reports it yet: `cache-thrash` needs the rewrite. `diff` shows it as a rise with the cache share dropping.
- A call that fails, including a response cut off at its output limit (which OpenAI bills), carries no usage in the trace: it is noted, left unpriced, and the run's cost is a lower bound.
- The trace holds the full prompts and tool results (the recorder writes them to a file only your user can read). burnlint never prints them.

## Related tools

- [ccusage](https://github.com/ryoppippi/ccusage) reports how much coding-agent CLIs spent, by day, session and model. burnlint reports which part of that spend was avoidable.
- [tracelint](https://github.com/AshwinUgale/tracelint) checks agent traces for structural defects (correctness), using OpenInference traces. burnlint checks for waste (cost). The two can run side by side in CI.

## Status

v0.4. Working: Claude Code logs, gen_ai OTLP, Vercel AI SDK 7 (both span formats; Anthropic, DeepSeek and Gemini providers checked), OpenAI Agents SDK via OpenInference, four rules, cost per run, `diff` for before/after cost per run with a CI gate, outcomes from your own pass/fail file (success rate and cost per successful run, success and cost per success compared in `diff`, `--fail-success-drop`), table / JSON / Markdown output, `record` for OTLP/HTTP (protobuf or JSON).

New in 0.4: a verdict on cost per success in `diff`; JSON `success.costPerSuccess` gains `change`, `pHigher`, `pTwoSided`, `minP`, `method`, `permutations` and `verdict`. Base64 run ids in outcomes files must be a valid encoding of a 16-byte trace id (0.3.1 read any 22 base64 characters as one, rewriting some names); a group with no priced run on one side shows its passes in the table, with `–` for cost.

0.3.1: runs whose trace ids share their first 12 hex digits stay separate; the success gate runs when cost can't be compared; a group with no priced run on one side is named with its passes; more base64 id forms and a byte-order mark in outcomes files.

New in 0.3: `--outcomes` on `audit` and `diff`, `--fail-success-drop`, and `--group-by` on a key whose name looks like content (`bench.input_id`). JSON output gains `outcomes` (audit), `success` (diff), and `traceId` and `pass` on runs.

While the version is 0.x, the fields of `-f json` output may change between minor versions; changes are noted in the release notes.

Next:

- Outcomes recorded in the trace itself (likely the OTel `gen_ai.evaluation.result` event), once a real tool that sends them can be captured; a GitHub Action
- A lost automatic prompt cache on OpenAI, DeepSeek and Gemini, which report cache reads but not writes
- Dialect mappers checked against real exports: other OpenInference instrumentations (LangGraph), Codex CLI, Gemini CLI, Qwen Code, Claude Code OTel spans
- More rules (`oversized-tool-result`, `retry-loop`, `context-growth`) once real traces show money there

## Development

```
npm install
npm test
```

`scripts/gen-record-fixture.mjs` regenerates the `record` fixture by sending spans through the official OpenTelemetry JS OTLP exporter to a running `burnlint record` (package versions are pinned in the script).

`fixtures/ai-sdk-v7-*.jsonl` are real runs of `bench/ai-sdk/agent.mjs` (a read-only code-review agent on Claude Sonnet 5.5), captured with `burnlint record` and redacted with `scripts/redact-capture.mjs`: prompts and model output are removed, tool results replaced by filler of the same length (equal where they were equal). `fixtures/openai-agents-*.jsonl` are real runs of `bench/openai-agents/agent.py` (the same agent on the OpenAI Agents SDK, gpt-5.4-mini), redacted the same way. `fixtures/openai-agents-outcomes.jsonl` holds the bench's grades for those runs (the cut-off review run as a failure).

`scripts/gen-otel-deepseek-fixture.py` regenerates the OTel fixture by running the official `opentelemetry-instrumentation-openai-v2` against a local mock DeepSeek server (needs `openai`, `opentelemetry-sdk`, `opentelemetry-instrumentation-openai-v2==2.3b0`, `opentelemetry-exporter-otlp-proto-common`, `wrapt<2`).

## License

MIT
