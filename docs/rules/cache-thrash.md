# cache-thrash

**Symptom:** a Claude Code session or agent run costs much more than usual, often right after a resume or a break. `cache_creation_input_tokens` jumps on a call that should have read the cache, and `cache_read_input_tokens` drops.

## Why it costs money

Providers cache the start of a prompt (the prefix) so later calls can read it cheaply. On Anthropic, writing to the cache costs more than sending tokens normally (1.25x for the 5-minute cache, 2x for the 1-hour cache), and reading it costs a tenth of the input rate or less (a twentieth on Claude Sonnet 5.5 and Opus 5.5). A stable prefix is written once and read on every later call.

When the cache is lost, the next call writes the whole context again. That happens when:

- **the cache expired** during a break longer than its TTL (5 minutes or 1 hour)
- **the prefix changed**: an edited system prompt, reordered tools, a timestamp or session id near the start of the prompt
- **the model changed**: each model has its own cache

A long context makes each loss expensive. From a real Claude Code session, resumed in a new environment that changed the system prompt:

```
myproject 3f2a9c1e  $1.22 savable of $1.22
  high  $1.22  $1.22  cache-thrash  1 cache rewrite after the prompt prefix changed
```

The whole 156k-token context was written to cache again at the 1-hour rate: $1.22 of the session's $5.08.

## What burnlint reports

A call that reads back at least 1,024 fewer tokens from the cache than the previous call left in it, and writes them again. A large write on its own is not reported: a big tool result is new content and has to be written once.

Only the lost part counts: the tokens that were cached before and written again, priced at the write rate minus the read rate. New tokens would have been written anyway.

One finding per cause, because the fixes differ. Where the trace records the prompt (the Vercel AI SDK does), burnlint compares hashes of the tools, system prompt and messages and names what changed. From `fixtures/ai-sdk-v7-prefix.jsonl`, where the system prompt ends with the current time:

```
burnlint-bench-reviewer e51c9189  $0.053 savable of $0.053  fixtures/ai-sdk-v7-prefix.jsonl
  low  $0.053  $0.053  cache-thrash  5 cache rewrites: system prompt changed
                                     · turn 2 · 1,094 tokens · $0.00 · system prompt changed
                                     · turn 3 · 1,900 tokens · $0.00 · system prompt changed
                                     · turn 4 · 2,281 tokens · $0.01 · system prompt changed
                                     · turn 5 · 6,632 tokens · $0.02 · system prompt changed
                                     · turn 6 · 10k tokens · $0.02 · system prompt changed
```

That was 52.7% of the run's cost. An expired cache, from a real Claude Code session (`fixtures/claude-code-session.jsonl`):

```
scratch-2026-10-27-53a77d 2afc960c  $0.192 savable of $0.237  fixtures/claude-code-session.jsonl
  medium  $0.192  $0.237  cache-thrash  1 cache rewrite after 3h35m idle, within the 12h keep-alive
                                        · turn 2 · 30k tokens · $0.24 · idle 3h35m
```

## How to fix it

- **Prefix changed:** keep everything that changes per call (time, ids, retrieved context) after the cached part: at the end of the system prompt's cached block, or in the latest message. Keep the tool list and its order fixed. The whole rewrite is counted as savable.
- **Expired:** a keep-alive re-sends the cached prefix just before the TTL runs out, billed as a cache read. Nobody knows how long a break will last, so the saving assumes a fixed policy: keep-alive for up to 12 hours (`keepAliveHours`), never hindsight. The saving is net of the pings: in the example above, pinging through the 3h35m break would have cost about $0.045, so the fix saves $0.192 of the $0.237. A break longer than 12 hours pays for the pings and the rewrite.
- **Model switched:** reported as a trade-off with no saving. Avoiding it means running the other model.

## Limits

- The first call after compaction is skipped: the context was replaced on purpose.
- A call with unknown cache usage is skipped. A failed call leaves the cache state as it was.
- Providers with automatic caching (OpenAI, DeepSeek, Gemini) report cache reads but not writes, so a lost cache there can't be seen as a rewrite and this rule stays silent. `burnlint diff` still shows the cost rise: on our DeepSeek bench, the timestamp above made each run cost 4.4 times as much.
