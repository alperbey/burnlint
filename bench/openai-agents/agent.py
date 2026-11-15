"""A read-only code-review agent built on the OpenAI Agents SDK, run to capture
real traces for burnlint (roadmap step 2, second framework). The same tasks,
tools, phases and grading as bench/ai-sdk/agent.mjs, so the two frameworks can
be compared. Spans go out as OTLP/HTTP protobuf through OpenInference to
`burnlint record`.

Each run has two phases in one trace: answer the task, then check the answer.
Variants differ from `normal` in exactly one way:
  normal   stable prompt; read_file takes a line range; the check uses what
           was read. OpenAI caches the prompt prefix automatically.
  prefix   the system prompt ends with the current time, changed every call,
           so the automatically cached prefix is lost each call.
  reread   the check phase is told to read every cited file again.
(No `nocache` variant: OpenAI caching is automatic and can't be switched off.)

Controls, as in the AI SDK bench:
- A per-run marker opens the system prompt, so runs can't read each other's
  caches.
- --repeat runs every cell several times.
- Answers are graded with deterministic checks (grade()): grounded, not
  necessarily right.
- Tools read a pinned commit (--snapshot), checked out into a temporary git
  worktree, so batches on different days see the same code.
- The run stops before spending if no trace receiver is listening, and the
  SDK's own trace upload to OpenAI is replaced (OpenInference's exclusive
  mode); the script refuses to run if another trace processor is left.

Checked with Python 3.14.2 and requirements.txt (pip install -r).

Usage (from this folder, with `burnlint record` running at the repo root):
  node ../../dist/cli.js record -o ../../captures/agents-1.jsonl      # terminal 1
  withkeys openai .venv/bin/python agent.py                            # terminal 2
Options:
  --tasks review,explain,principle   --variants normal,prefix,reread   --repeat 3
  --model gpt-5.4-mini   --max-turns 15 (answer; the check gets 8)
  --budget 3 (USD, all runs)   --run-cap 0.3 (USD, one run)
  --repo ../..   --snapshot 4233b57 (or "live")
  --mock      scripted model (the SDK's ScriptedModel), no API key, no cost:
              checks the pipeline only. Its traces must never become a fixture.
  --grade <dir>   re-grade saved answers and exit.

Answers and per-run results go to out/ (runs.jsonl: trace id, usage, grade).
Traces carry prompts, tool results and answers (OpenInference records them by
default); burnlint never prints them.
"""

from __future__ import annotations

import argparse
import asyncio
import atexit
import json
import os
import re
import socket
import subprocess
import sys
import tempfile
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

from agents import Agent, ModelSettings, RunConfig, RunHooks, Runner, function_tool
from agents.exceptions import MaxTurnsExceeded
from openai.types.shared import Reasoning
from openinference.instrumentation.openai_agents import OpenAIAgentsInstrumentor
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import SpanLimits, TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

VARIANTS = ["normal", "prefix", "reread"]

p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
p.add_argument("--tasks", default="review,explain,principle")
p.add_argument("--variants", default=",".join(VARIANTS))
p.add_argument("--repeat", type=int, default=3)
p.add_argument("--model", default="gpt-5.4-mini")
p.add_argument("--max-turns", type=int, default=15)
p.add_argument("--budget", type=float, default=3.0)
p.add_argument("--run-cap", type=float, default=0.3)
p.add_argument("--repo", default="../..")
p.add_argument("--snapshot", default="4233b57")
p.add_argument("--mock", action="store_true")
p.add_argument("--grade")
opt = p.parse_args()

CHECK_TURNS = 8
for name in ("repeat", "max_turns", "budget", "run_cap"):
    if not getattr(opt, name) > 0:
        sys.exit(f"--{name.replace('_', '-')} must be a positive number")


def checkout(repo: Path, commit: str) -> Path:
    # Resolved: on macOS the temp folder is a symlink (/var -> /private/var), and the
    # tools compare resolved paths against REPO (the first real run failed every call).
    d = Path(tempfile.mkdtemp(prefix=f"bench-{commit}-")).resolve()
    subprocess.run(["git", "-C", str(repo), "worktree", "add", "--detach", "--quiet", str(d), commit], check=True)

    def remove() -> None:
        r = subprocess.run(["git", "-C", str(repo), "worktree", "remove", "--force", str(d)], capture_output=True, text=True)
        if r.returncode:
            print(f"could not remove worktree {d}: {r.stderr.strip()}", file=sys.stderr)

    atexit.register(remove)
    return d


# The code under review changes as the project grows; a run that reads more
# costs more. Tools read a pinned commit so cost differences between batches
# come from the agent, not from the code it reads.
SNAPSHOT = None if opt.snapshot == "live" else opt.snapshot
if SNAPSHOT is not None and not re.fullmatch(r"[0-9a-f]{7,40}", SNAPSHOT):
    sys.exit("--snapshot must be a commit hash or live")
REPO = checkout(Path(opt.repo).resolve(), SNAPSHOT) if SNAPSHOT and not opt.grade else Path(opt.repo).resolve()


def tools_work() -> None:
    """Every tool against the checkout, before a paid run: a broken tool makes every run worthless."""
    for name, call in (
        ("list_files", lambda: walk(inside("src/rules"))),
        ("read_file", lambda: inside("src/audit.ts").read_text(encoding="utf-8")),
        ("grep", lambda: walk(inside("src"))),
        ("git_show", lambda: git("show", "--stat", REVIEW_COMMIT)),
    ):
        try:
            if not call():
                raise ValueError("empty result")
        except Exception as e:
            sys.exit(f"tool {name} fails on the checkout ({e}); not starting")

# gpt-5.4-mini, USD per 1M tokens (bundled LiteLLM table, retrieved 2026-11-12).
# Only for the budget guard; burnlint prices the trace with its own table.
PRICE = {"input": 0.75, "cached": 0.075, "output": 4.5}

REVIEW_COMMIT = "fd08744"

TASKS = {
    "review": (
        f"Review commit {REVIEW_COMMIT} in this repository for correctness bugs. Use git_show to see the change and read the "
        "surrounding code where you need it. Report at most 5 findings, each with file:line, what goes wrong and a "
        "concrete input that triggers it. If you find none, say so."
    ),
    "explain": (
        "In this repository, how are sub-agents counted when computing cost per run? Trace it from where a Claude Code "
        "log is read to where the per-run statistics are computed. Answer in under 200 words and cite file:line for each step."
    ),
    "principle": (
        "This tool promises that findings never include tool inputs (queries, commands). Check every place under "
        "src/rules/ where a finding's message or details are built, and say whether any of them can include a tool "
        "input. Cite file:line for each place you checked."
    ),
}

SYSTEM = (
    "You are a code reviewer working in a read-only checkout of a TypeScript repository. Use the tools to look at "
    "the code and never guess what a file contains. Prefer grep and line ranges over reading whole files. Be concise, "
    "and cite every claim as path:line, with the path relative to the repository root."
)

CHECK = {
    "normal": (
        "Check your answer before you finish. Use what you have already read; call a tool only for code you have not "
        "looked at yet. Then give your final answer in full, corrected where needed."
    ),
    "reread": (
        "Check your answer before you finish. Read every file you cited again with read_file, then give your final "
        "answer in full, corrected where needed."
    ),
}

# ---------- tools (read-only, confined to the repo) ----------

SKIP_DIRS = {".git", "node_modules", "dist", "out", "captures", ".venv", "__pycache__"}
READ_CAP = 400


def inside(p: str | None) -> Path:
    path = (REPO / (p or ".")).resolve()
    try:
        rel = path.relative_to(REPO)
    except ValueError:
        raise ValueError(f"{p} is outside the repository") from None
    if any(part in SKIP_DIRS for part in rel.parts) or path.name.startswith(".env"):
        raise ValueError(f"{p} is not available")
    return path


def walk(d: Path) -> list[Path]:
    out: list[Path] = []
    for child in sorted(d.iterdir(), key=lambda c: c.name):
        if child.name in SKIP_DIRS or child.name.startswith(".env"):
            continue
        out.extend(walk(child)) if child.is_dir() else out.append(child)
    return out


def rel(p: Path) -> str:
    return p.relative_to(REPO).as_posix()


def git(*args: str) -> str:
    return subprocess.run(["git", "-C", str(REPO), *args], check=True, capture_output=True, text=True).stdout


def safe(fn):
    def wrapped(*a, **k):
        try:
            return fn(*a, **k)
        except Exception as e:  # the model sees the error and can try again
            return f"error: {e}"

    return wrapped


@function_tool
def list_files(dir: str = ".") -> str:
    """List files under a directory of the repository (recursive).

    Args:
        dir: Directory relative to the repo root.
    """
    return safe(lambda: "\n".join(rel(f) for f in walk(inside(dir))[:300]) or "(empty)")()


@function_tool
def read_file(path: str, start_line: int | None = None, end_line: int | None = None) -> str:
    """Read a file with line numbers. Give start_line/end_line for part of it; at most 400 lines per call.

    Args:
        path: File path relative to the repo root.
        start_line: First line to read (1-based).
        end_line: Last line to read.
    """

    def run() -> str:
        lines = inside(path).read_text(encoding="utf-8").split("\n")
        start = max(1, start_line or 1)
        end = min(end_line or len(lines), start + READ_CAP - 1, len(lines))
        body = "\n".join(f"{start + i}\t{line}" for i, line in enumerate(lines[start - 1 : end]))
        more = f"\n({len(lines)} lines; continue with start_line={end + 1})" if end < len(lines) else ""
        return body + more

    return safe(run)()


@function_tool
def grep(pattern: str, path: str = ".") -> str:
    """Search files for a regular expression. Returns file:line: text, at most 80 matches.

    Args:
        pattern: Regular expression.
        path: File or directory relative to the repo root.
    """

    def run() -> str:
        rx = re.compile(pattern)
        root = inside(path)
        hits: list[str] = []
        for f in walk(root) if root.is_dir() else [root]:
            try:
                text = f.read_text(encoding="utf-8")
            except (UnicodeDecodeError, OSError):
                continue
            for i, line in enumerate(text.split("\n"), 1):
                if rx.search(line):
                    hits.append(f"{rel(f)}:{i}: {line.strip()[:200]}")
            if len(hits) >= 80:
                break
        return "\n".join(hits[:80]) or "no matches"

    return safe(run)()


@function_tool
def git_show(commit: str) -> str:
    """Show a commit's message, changed files and diff.

    Args:
        commit: Commit hash, 7-40 hex characters.
    """

    def run() -> str:
        if not re.fullmatch(r"[0-9a-f]{7,40}", commit):
            raise ValueError("commit must be a 7-40 character hex hash")
        out = git("show", "--stat", "--patch", "--no-color", commit)
        return out[:80000] + "\n(diff truncated at 80000 characters)" if len(out) > 80000 else out

    return safe(run)()


TOOLS = [list_files, read_file, grep, git_show]

# ---------- grading (deterministic; grounded, not necessarily right) ----------


def line_counts(path: str) -> list[int]:
    counts = []
    try:
        counts.append(len((REPO / path).read_text(encoding="utf-8").split("\n")))
    except OSError:
        pass
    try:
        counts.append(len(git("show", f"{REVIEW_COMMIT}:{path}").split("\n")))
    except subprocess.CalledProcessError:
        pass
    return counts


def grade(task: str, answer: str) -> dict:
    files = [rel(f) for f in walk(REPO)]
    cites = [
        {"path": m.group(1).removeprefix("./"), "line": int(m.group(3) or m.group(2))}
        for m in re.finditer(r"([\w./-]+\.(?:ts|mjs|js|json|md)):(\d+)(?:[-–](\d+))?", answer)
    ]
    resolved = []
    for c in cites:
        matches = [f for f in files if f == c["path"] or f.endswith("/" + c["path"])]
        path = matches[0] if len(matches) == 1 else None
        ok = path is not None and c["line"] >= 1 and any(c["line"] <= n for n in line_counts(path))
        resolved.append({**c, "path": path, "ok": ok})

    def cited(rx: str) -> bool:
        return any(c["ok"] and re.search(rx, c["path"]) for c in resolved)

    checks = {
        "answered": bool(answer.strip()),
        "cites": bool(resolved),
        "citationsValid": bool(resolved) and all(c["ok"] for c in resolved),
    }
    if task == "explain":
        checks["citesAudit"] = cited(r"(^|/)src/audit\.ts$")
        checks["citesClaudeCodeReader"] = cited(r"(^|/)src/adapters/claude-code\.ts$")
        checks["mentionsSession"] = bool(re.search(r"session", answer, re.I))
    elif task == "principle":
        for rule in ("cache-thrash", "duplicate-tool-call", "reread-unchanged"):
            checks[f"cites:{rule}"] = cited(rf"src/rules/{rule}\.ts$")
    elif task == "review":
        changed = set(git("show", "--name-only", "--format=", REVIEW_COMMIT).strip().split("\n"))
        checks["citesChangedFile"] = any(c["ok"] and c["path"] in changed for c in resolved) or bool(
            re.search(r"no (correctness )?bugs|none found|found none", answer, re.I)
        )
    return {
        "pass": all(checks.values()),
        "checks": checks,
        "citations": len(resolved),
        "invalid": sum(1 for c in resolved if not c["ok"]),
    }


# ---------- cost (budget guard only) ----------


def usd_of(u) -> float:
    cached = getattr(u.input_tokens_details, "cached_tokens", 0) or 0
    return ((u.input_tokens - cached) * PRICE["input"] + cached * PRICE["cached"] + u.output_tokens * PRICE["output"]) / 1e6


class RunCapReached(Exception):
    pass


class Guard(RunHooks):
    """Adds up each call's cost and stops the run once it passes the cap."""

    def __init__(self, cap: float):
        self.cap = cap
        self.usd = 0.0

    async def on_llm_end(self, context, agent, response) -> None:
        self.usd += usd_of(response.usage)
        if self.usd >= self.cap:
            raise RunCapReached(f"run cap of ${self.cap} reached (${self.usd:.3f})")


# ---------- model ----------


def make_model(phase: str):
    if not opt.mock:
        return opt.model
    # Scripted, per phase: list, read, grep, answer. Pipeline check only, not a real trace.
    from agents.testing import ScriptedModel, assistant_message, function_call
    from agents.usage import Usage
    from openai.types.responses.response_usage import InputTokensDetails, OutputTokensDetails

    def usage(i: int) -> Usage:
        inp = 1200 + i * 900
        cached = 0 if i == 0 else 1024 * (1 + i)
        return Usage(
            requests=1,
            input_tokens=inp,
            input_tokens_details=InputTokensDetails(cached_tokens=min(cached, inp), cache_write_tokens=0),
            output_tokens=80,
            output_tokens_details=OutputTokensDetails(reasoning_tokens=20),
            total_tokens=inp + 80,
        )

    calls = [
        ("list_files", {"dir": "src/rules"}),
        ("read_file", {"path": "src/audit.ts", "start_line": 190, "end_line": 200}),
        ("grep", {"pattern": "unitOf", "path": "src"}),
    ]
    steps = [
        {"output": [function_call(name, args, call_id=f"mock_{phase}_{i}")], "usage": usage(i), "response_id": f"resp_mock_{phase}_{i}"}
        for i, (name, args) in enumerate(calls)
    ]
    steps.append(
        {
            "output": [assistant_message("Mock answer: sub-agents roll into their session (src/audit.ts:194, src/adapters/claude-code.ts:90).")],
            "usage": usage(len(calls)),
            "response_id": f"resp_mock_{phase}_final",
        }
    )
    # emit_traces: model-call spans like a real model's, so the mock exercises the whole span tree.
    return ScriptedModel(steps, emit_traces=True)


# ---------- run ----------


def phase_usage(result) -> dict:
    u = result.context_wrapper.usage
    return {
        "input": u.input_tokens,
        "cached": u.input_tokens_details.cached_tokens or 0,
        "output": u.output_tokens,
        "reasoning": u.output_tokens_details.reasoning_tokens or 0,
        "requests": u.requests,
    }


async def run_once(task: str, variant: str, rep: int, batch: str, tracer) -> tuple[float, str | None]:
    label = f"{task}-{variant}-{rep}{'-mock' if opt.mock else ''}"
    attrs = {"bench.task": task, "bench.variant": variant, "bench.rep": rep, "bench.batch": batch, "bench.snapshot": SNAPSHOT or "live"}
    with tracer.start_as_current_span("bench.run", attributes=attrs) as span:
        trace_id = format(span.get_span_context().trace_id, "032x")
        started = time.time()
        record = {
            "batch": batch, "traceId": trace_id, "task": task, "variant": variant, "rep": rep, "model": opt.model,
            "mock": opt.mock, "startedAt": datetime.now(timezone.utc).isoformat(),
        }
        # The marker opens the system prompt, so no other run shares a cached prefix with this one.
        system = f"Run {uuid.uuid4().hex[:8]}. {SYSTEM}"
        if variant == "prefix":
            # Rebuilt on every model call: the time at the end changes the prefix each call.
            def instructions(ctx, agent) -> str:
                return f"{system}\nCurrent time: {datetime.now(timezone.utc).isoformat()}"
        else:
            instructions = system
        guard = Guard(opt.run_cap)

        def agent(phase: str) -> Agent:
            return Agent(
                name=f"reviewer-{task}",
                instructions=instructions,
                tools=TOOLS,
                model=make_model(phase),
                # Reasoning counts against max_tokens: at 6000, review answers were cut off (response.incomplete).
                model_settings=ModelSettings(max_tokens=16000, reasoning=Reasoning(effort="medium")),
            )

        config = RunConfig(workflow_name=f"reviewer-{task}")
        try:
            answer = await Runner.run(agent("answer"), TASKS[task], max_turns=opt.max_turns, hooks=guard, run_config=config)
            check_input = answer.to_input_list() + [{"role": "user", "content": CHECK["reread" if variant == "reread" else "normal"]}]
            check = await Runner.run(agent("check"), check_input, max_turns=CHECK_TURNS, hooks=guard, run_config=config)
            text = str(check.final_output or answer.final_output or "")
            g = grade(task, text)
            ua, uc = phase_usage(answer), phase_usage(check)
            record.update(
                {
                    "steps": ua["requests"] + uc["requests"],
                    "answerSteps": ua["requests"],
                    "usage": {k: ua[k] + uc[k] for k in ("input", "cached", "output", "reasoning")},
                    "grade": g,
                }
            )
            Path("out", f"{batch}-{label}.md").write_text(text or "(no answer)\n", encoding="utf-8")
            u = record["usage"]
            failed = ",".join(k for k, v in g["checks"].items() if not v)
            print(
                f"{label:<24} {record['steps']:>2} steps  in {u['input']}  cached {u['cached']}  out {u['output']} "
                f"(reasoning {u['reasoning']})  ~${guard.usd:.3f}  {'pass' if g['pass'] else 'FAIL ' + failed}"
            )
        except (RunCapReached, MaxTurnsExceeded, Exception) as e:  # noqa: B014 - named for the reader
            record["error"] = f"{type(e).__name__}: {e}"
            span.record_exception(e)
            print(f"{label}: {record['error']}", file=sys.stderr)
        finally:
            record["usd"] = round(guard.usd, 4)
            record["seconds"] = round(time.time() - started)
            with open(Path("out", "runs.jsonl"), "a", encoding="utf-8") as f:
                f.write(json.dumps(record) + "\n")
    return guard.usd, record.get("error")


def receiver_up(url: str) -> None:
    u = urlparse(url)
    try:
        socket.create_connection((u.hostname, u.port or (443 if u.scheme == "https" else 80)), timeout=2).close()
    except OSError:
        sys.exit(f"no trace receiver at {u.netloc}; start it first, at the repo root: node dist/cli.js record -o captures/<name>.jsonl")


def only_openinference_processor() -> None:
    """The SDK uploads traces to OpenAI by default; OpenInference's exclusive mode replaces that. Make sure."""
    from agents.tracing import get_trace_provider

    processors = getattr(getattr(get_trace_provider(), "_multi_processor", None), "_processors", None)
    if processors is None:
        sys.exit("can't see the Agents SDK's trace processors to check that nothing is uploaded to OpenAI; refusing to run")
    names = [type(x).__name__ for x in processors]
    if names != ["OpenInferenceTracingProcessor"]:
        sys.exit(f"unexpected Agents SDK trace processors {names}; refusing to run (traces could go to OpenAI)")


async def main() -> None:
    tasks = opt.tasks.split(",")
    variants = opt.variants.split(",")
    for t in tasks:
        if t not in TASKS:
            sys.exit(f"unknown task {t}")
    for v in variants:
        if v not in VARIANTS:
            sys.exit(f"unknown variant {v} ({', '.join(VARIANTS)})")
    if not opt.mock and not os.environ.get("OPENAI_API_KEY"):
        sys.exit("OPENAI_API_KEY is not set (or use --mock)")
    if os.environ.get("OPENAI_AGENTS_DISABLE_TRACING", "").lower() in ("1", "true"):
        sys.exit("OPENAI_AGENTS_DISABLE_TRACING is set: no spans would be recorded")

    endpoint = os.environ.get("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT") or (
        os.environ["OTEL_EXPORTER_OTLP_ENDPOINT"].rstrip("/") + "/v1/traces" if os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT") else "http://127.0.0.1:4318/v1/traces"
    )
    # A run without a receiver, or with broken tools, is paid for and worthless: check before spending.
    receiver_up(endpoint)
    tools_work()
    provider = TracerProvider(
        # Scripted runs are named apart, so they can't pass for real ones in a shared capture.
        resource=Resource.create({"service.name": "burnlint-bench-agents-MOCK" if opt.mock else "burnlint-bench-agents"}),
        # OpenInference writes each message as separate attributes. At the SDK's default of 128
        # per span, a long conversation's model spans drop their oldest attributes, token counts
        # included (the first capture lost usage on 5 of 10 calls).
        span_limits=SpanLimits(max_span_attributes=100_000),
    )
    provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(endpoint=endpoint)))
    trace.set_tracer_provider(provider)
    OpenAIAgentsInstrumentor().instrument(tracer_provider=provider)
    only_openinference_processor()
    tracer = trace.get_tracer("burnlint-bench")

    Path("out").mkdir(exist_ok=True)
    batch = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%S")
    total = opt.repeat * len(tasks) * len(variants)
    print(f"batch {batch}: {total} runs ({len(tasks)} tasks x {len(variants)} variants x {opt.repeat}), model {opt.model}, budget ${opt.budget}")
    spent, failures = 0.0, 0
    stop = False
    # Repeat-major order, so a budget stop leaves complete rounds rather than missing cells.
    for rep in range(1, opt.repeat + 1):
        for task in tasks:
            for variant in variants:
                if spent >= opt.budget:
                    print(f"budget of ${opt.budget} reached (${spent:.2f} spent), stopping")
                    stop = True
                    break
                usd, error = await run_once(task, variant, rep, batch, tracer)
                spent += usd
                provider.force_flush()
                if error:
                    failures += 1
                    if failures >= 3 and spent == 0:
                        print("3 runs failed before spending anything; stopping (check the API key)")
                        stop = True
                        break
            if stop:
                break
        if stop:
            break
    provider.shutdown()
    print(f"done, ~${spent:.2f} spent by this script's estimate; results in out/runs.jsonl (batch {batch})")


if __name__ == "__main__":
    if opt.grade:
        for f in sorted(Path(opt.grade).glob("*.md")):
            task = next((t for t in TASKS if re.search(rf"(^|-){t}-", f.name)), None)
            if not task:
                continue
            g = grade(task, f.read_text(encoding="utf-8"))
            failed = ",".join(k for k, v in g["checks"].items() if not v)
            print(f"{f.name:<48} {'pass' if g['pass'] else 'FAIL ' + failed}  ({g['citations']} citations, {g['invalid']} invalid)")
    else:
        asyncio.run(main())
