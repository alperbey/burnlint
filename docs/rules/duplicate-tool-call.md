# duplicate-tool-call

**Symptom:** the agent calls the same tool with the same input and gets the same result, with nothing changed in between: the same search twice, the same lookup, the same API call.

## Why it costs money

Each call adds its result to the context, which is sent again on every later call. A repeated call with a result the model already has adds a second copy, and a model call to make it.

## What burnlint reports

A tool called again with identical input and an identical result, with nothing written in between and the earlier call not having failed. The finding names the tool and the turns, never the input, since an input can be a query or a command:

```
<tool> called 2x with identical input and result (turns 3, 7)
```

File reads are left to [reread-unchanged](reread-unchanged.md).

No committed trace has shown this rule firing yet: on the benches so far, agents repeated reads, not other tools. The format above is the rule's message; its tests use synthetic runs.

## How to fix it

- Cache tool results inside the agent for the length of a run, for tools whose result can't change within it.
- Tell the agent in its instructions that earlier tool results stay in context.

## Limits

The rule stays silent when it can't tell that the call was redundant:

- shell commands are never reported, and reset the check
- writes, human messages and compaction reset the check
- both results must be known and equal: a different result means the call learned something
- tools that poll by name (status, wait and the like) are never reported
