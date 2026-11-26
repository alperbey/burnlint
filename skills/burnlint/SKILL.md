---
name: burnlint
description: Measure what AI agent runs cost and catch cost regressions, locally, from Claude Code session logs or OpenTelemetry traces. Use when the user asks why an agent run or Claude Code session was expensive, why cost spiked (for example after resuming a session, or cache_creation_input_tokens jumped), whether a prompt, tool or model change made runs more expensive, what a successful run costs, or wants an agent cost check in CI.
---

# burnlint

burnlint reads agent traces and reports cost per run, before/after changes with a significance test, cost per successful run, and spend that was avoidable. It runs locally with `npx burnlint`, makes no network calls, and never prints message content.

## Pick the command

| The user wants to know | Run |
|---|---|
| What their Claude Code sessions cost and what was avoidable | `npx burnlint audit` (reads `~/.claude/projects`) |
| The same for a trace file or folder | `npx burnlint audit <file-or-dir>` |
| What that comes to per month | `npx burnlint audit <path> --runs-per-month <n>` |
| Every occurrence behind a finding | add `-v` |
| Whether a change made runs more expensive | `npx burnlint diff <base> <head>` |
| What a successful run costs | add `--outcomes <file.jsonl>` to `audit` or `diff` |
| A CI check | `audit --fail-on high`, `diff --fail-above <pct>`, `diff --fail-success-drop <points>` |
| Traces from their own agent | `npx burnlint record -o run.jsonl`, then run the agent with `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318` |

Output formats: `audit` takes `-f table|json|md` (md for PR comments); `diff` takes `-f table|json`. Run `npx burnlint --help` for every option.

Inputs: Claude Code session logs, OTLP/JSON traces with GenAI (`gen_ai.*`), Vercel AI SDK (`ai.*`) or OpenInference spans, and files written by `burnlint record`. An agent whose exporter defaults to gRPC needs `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf` for `record`.

## Read the audit

A run is one OTLP trace, or one Claude Code session with its sub-agents.

- `perRun`: `meanUsd`, `medianUsd`, `p90Usd`, `maxUsd` per run; `avoidableUsd` per run and `avoidableShare` of spend; `incomplete` counts runs with some unpriced calls (their cost is a lower bound).
- `excludedRuns`: runs with no priced call (`failed`, `unpriced`). They are left out of cost per run, never counted as $0.
- `projection` (with `--runs-per-month`): `spendUsd` and `avoidableUsd` per month.
- `outcomes` (with `--outcomes`): `successRate`, `costPerSuccessUsd` (all spend on runs with an outcome divided by passes).
- `findings[]`: `rule`, `severity`, `runId`, `message`, `details`, `costUsd` (what the pattern cost), `avoidableUsd` (what fixing it would have saved, net of the fix's own cost), `fix`.
  - `fix: "no-loss"` removes only what the model already had: safe to recommend.
  - `fix: "trade-off"` changes what the model sees or which model runs: report the cost, but don't present it as savings.

Rules: `cache-thrash` (a prompt cache rebuilt mid-run, e.g. after a resume or a changed system prompt), `no-prompt-cache` (an Anthropic run that never cached while re-sending the same growing prompt), `reread-unchanged` (a file read again with nothing changed in between), `duplicate-tool-call` (the same tool call with the same result).

## Read the diff

Runs are compared within groups (`--group-by <root-span attribute>`; default `gen_ai.agent.name`, then the Claude Code project), at base's mix of groups, with a permutation test.

- `overall`: `baseUsd`, `headUsd`, `change` (a share: 0.38 is +38%), `pTwoSided`, `noise` (about two standard errors, as a share), `verdict`: `higher`, `lower`, `no clear change`, `too few runs`, or `can't tell` (some calls have no price or usage).
- `success` (with `--outcomes`): `baseRate`, `headRate`, `change` in points, `verdict` (`lower` means head passes less often), and `costPerSuccess` with its own `change` and `verdict`.
- Report the verdict, not just the change: `no clear change` and `too few runs` mean the difference may be run-to-run noise. With 3 runs per group, only rises of about 15-20% or more show reliably.
- Both sides must run the same inputs. A task that reads a growing repo costs more by itself.

Exit codes: 0 pass, 1 a `--fail-on`, `--fail-above` or `--fail-success-drop` gate failed, 2 nothing could be compared or decided (no runs, unknown cost or outcome).

## Outcomes file

JSONL, one line per run: `{"run": "<trace id or Claude Code session id>", "pass": true}`. burnlint never grades output. Use `false` when the agent ran and didn't deliver (wrong answer, turn limit, cut off); leave the run out when nobody could grade it.

## Notes

- Prices come from a bundled LiteLLM table; `--prices <file.json>` overrides them. Costs are estimates.
- While the version is 0.x, `-f json` fields may change between minor versions.
