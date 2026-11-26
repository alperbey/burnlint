# no-prompt-cache

**Symptom:** an agent on Anthropic models costs up to about twice what it should. `cache_read_input_tokens` and `cache_creation_input_tokens` are 0 on every call, while the prompt grows from call to call.

## Why it costs money

Anthropic caches only when the request asks for it (`cache_control`). Without it, every call pays the full input rate for the whole conversation so far: the system prompt, the tools and every earlier message, again and again. With caching, each call reads what the previous call sent at a tenth of the input rate or less and writes only what is new.

## What burnlint reports

A run on a provider that caches only when asked, where nothing was cached and the calls re-sent the same growing prompt. The saving is a counterfactual: the same calls with a 5-minute cache breakpoint at the end of each prompt (what top-level `cache_control` does), net of the extra cost of writing the cache. It is reported only when that comes out positive. From `fixtures/ai-sdk-v7-nocache.jsonl`, a real Vercel AI SDK run on Claude Sonnet 5.5 without `cache_control`:

```
burnlint-bench-reviewer 2fe29eff  $0.057 savable of $0.063  fixtures/ai-sdk-v7-nocache.jsonl
  low  $0.057  $0.063  no-prompt-cache  prompt caching off: 33k tokens of repeated prefix sent at the full rate over 5 calls
                                        · 5 of 6 calls would have read the previous prompt from a 5-minute cache
                                        · writing it would have cost $0.0060 more; net saving $0.0569
```

That was 47.7% of the run's cost. On the bench, the measured difference between runs with and without caching was $0.052 per run.

## How to fix it

Turn on prompt caching: a `cache_control` breakpoint on the request (or the provider option your SDK exposes for it). Keep the prefix stable, or the cache will be lost on every call (see [cache-thrash](cache-thrash.md)).

## Limits

The rule stays silent when it can't tell:

- cache fields are unknown on any call
- the run reads or writes the cache at all (caching is on, and `cache-thrash` covers losses)
- the provider caches on its own (OpenAI, DeepSeek, Gemini) or hasn't been checked: it fires on Anthropic's API and Vertex, not on Bedrock
- the model has no known minimum cacheable length, or no price

Where the trace records the prompt, a call counts as a cache hit only if its prefix matches the previous call's. Otherwise the saving is marked "up to": an upper bound. Caching off on a prefix that changes every call reports nothing, since caching as it stands would save nothing there.
