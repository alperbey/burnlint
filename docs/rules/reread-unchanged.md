# reread-unchanged

**Symptom:** the agent reads the same file, or the same lines of it, again and again, with nothing changed in between.

## Why it costs money

Every read puts the file's content into the context, and the context is sent again on every later call. A second copy of the same lines is carried, and paid for, for the rest of the run.

## What burnlint reports

File content read again with no write to it in between. When the tool returns numbered lines (like Claude Code's `Read`), any overlap counts: a range inside an earlier one, the whole file after a range, or a partial overlap of at least 10 lines. Only the repeated lines count, and only when every one of them came back unchanged. Other reads must repeat exactly: same path, same input, same result.

The cost is the tokens of the repeated lines, carried through the rest of the run. From `fixtures/ai-sdk-v7-reread.jsonl`, a real Vercel AI SDK run on Claude Sonnet 5.5:

```
burnlint-bench-reviewer 87495b49  $0.012 savable of $0.012  fixtures/ai-sdk-v7-reread.jsonl
  low  $0.0024  $0.0024  reread-unchanged  src/tools.ts: 80 lines read again with no change in between (turns 4, 6)
                                           · turn 6: lines 1–80 again, 80 of 115 lines returned
  low  $0.0023  $0.0023  reread-unchanged  src/rules/cache-thrash.ts: 71 lines read again with no change in between (turns 2, 6)
                                           · turn 6: lines 95–165 again, 71 of 181 lines returned
```

Each finding is small. They add up over long sessions, and the calls that make the rereads cost more than the reread lines: on the bench, the rereading variant cost 36-42% more per run than the normal one. That extra is not counted as avoidable, because a reread moves code to the end of the context, which may help the model. `burnlint diff` measures it.

## How to fix it

- Tell the agent in its instructions that file contents stay in context and needn't be read again unless the file was changed.
- Give the read tool a way to return only a range, and keep track of what was read.
- In Claude Code, this often shows up after long sessions where earlier reads scrolled far back. Compaction resets the check.

## Limits

The rule stays silent when the file may have changed: after a write to a path that could be the same file, after any shell command or write without a target, after a human message or compaction, when a repeated line came back different, or when a result is unknown. A call that made only rereads isn't counted, since it may also have returned new lines; its cost is shown with `-v` as context.
