# Comparing before and after: `burnlint diff`

**Use it when:** you changed a prompt, a tool, a model or the agent's code, and want to know whether runs now cost more, or pass less often, before the change ships.

```
burnlint diff <base> <head>
```

Each side is a trace file or a folder of them: runs of the same tasks before the change (base) and after it (head).

## Why a plain comparison of averages isn't enough

Agent runs vary a lot from run to run. On our bench, three runs of one task with the same setup cost between $0.11 and $0.24. With a few runs per side, an average can move 10-20% by chance. A CI check on raw averages fails builds at random, and a real rise can hide in the noise.

`diff` answers two questions instead of one: how much did cost per run change, and is that change bigger than these runs could show by chance?

## Example

The same three tasks run normally (base) and with an agent that rereads files (head), 3 runs per task, from the Vercel AI SDK bench on Claude Sonnet 5.5:

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

The per-group columns show where the change came from: head made more calls and carried more prompt tokens on every task.

## How it compares

- **Groups.** Runs are compared within groups, so a head that happened to run more of the cheap task doesn't look cheaper. The default group is `gen_ai.agent.name` (the Vercel AI SDK's `functionId`), then the Claude Code project, else all runs in one group. `--group-by <key>` uses any attribute on a trace's root span, such as a task or input id your harness sets. Groups of the same task vary less, so the test sees smaller changes.
- **Base's mix.** The headline is each group's mean, weighted by how many runs base has in that group. When head's mix differs, the plain average over all runs is shown too.
- **The test.** A stratified permutation test: within each group, the runs are relabeled base and head in every way that keeps the group's sizes (8,000 ways above), and the same weighted difference is computed each time. The p-value is the share of relabelings that show a difference at least as large as the real one. It assumes nothing about how costs are distributed. Up to 200,000 relabelings it is exact; beyond that, 20,000 are sampled with a fixed seed, so the same input always gives the same answer.
- **Noise.** "run-to-run noise here: about ±11%" is about two standard errors of the change, from the spread within each group. A change inside it is what these runs could show by chance.

## Verdicts

| Verdict | Meaning |
|---|---|
| `higher`, `lower` | The change is clear: p < 0.05 |
| `no clear change` | The runs can't tell this change from noise |
| `too few runs` | No difference these runs could show would reach p < 0.05. Run more, or group by task |
| `can't tell` | Some calls have no price or no usage, so their cost is unknown |

Runs that failed before any priced call are counted apart, never as $0 runs: a change that makes runs fail early would otherwise look cheaper.

## In CI

```
burnlint diff base/ head/ --fail-above 15
```

Exits 1 when cost per run rose more than 15% and the runs show a rise clearly (one-sided p < 0.05). A rise the runs can't tell from noise passes, with a warning on stderr. From the example above:

```
burnlint: cost per run rose 38.1%, above 15% (one-sided p=0.00013)
```

The gate tests for a rise, not for a rise above the threshold: with many runs, a measured 10.5% with a wide spread fails a 10% gate.

How small a rise it sees depends on the runs. At our bench's noise, with 3 runs per task across 3 tasks, a +10% rise is caught 56% of the time, +15% 86%, +20% 98%. Use 5 or more runs per task for 10%.

**Pin the inputs.** Both sides must run the same tasks on the same inputs. An agent that reads a growing repo costs more by itself: when our bench read the live repo, a rerun a day later cost 11% more, and the gate correctly failed. Pinned to a fixed commit, the rerun came out at -0.9% (p = 0.81). Over all 8,000 ways of splitting 18 runs of one setup into two sides, the gate at 10% fired on 0.09% of them.

## Success and cost per successful run

A cheaper run that does the work worse is not cheaper. Give `diff` your pass/fail per run, and it compares success the same way:

```
burnlint diff base/ head/ --outcomes outcomes.jsonl --fail-success-drop 10
```

`outcomes.jsonl` has one line per run: `{"run": "<trace id or Claude Code session id>", "pass": true}`. burnlint never grades output itself.

- **Success** is tested like cost, on failures instead of dollars. `--fail-success-drop <points>` exits 1 when the success rate fell more than that many percentage points and the runs show a drop clearly. It runs even when cost can't be compared, so a head whose every run failed early still fails it.
- **Cost per success** is all spend on runs with an outcome, divided by the passes. It gets its own verdict: the same test, with each run keeping its cost and its outcome together. A side with no passes has an infinite cost per success.
- If any compared run has no outcome, both verdicts are `can't tell`.

Pass/fail carries little information per run, so few runs can only show a collapse: in a single group of 3 runs, not even 3/3 → 0/3 is clear. Grouping by input makes the test much stronger: five inputs that flip from pass to fail fail the gate.

## Exit codes

| Code | When |
|---|---|
| 0 | No gate failed |
| 1 | `--fail-above` or `--fail-success-drop` failed |
| 2 | Nothing to compare, or a gate can't decide (unknown cost or a missing outcome) |
