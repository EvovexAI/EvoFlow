"""Regression: ``executor=completed`` must never be rewritten to ``failed``.

Observed (task 2611061932_f598, 2026-11-06 19:34):

    19:34:00  step dispatched      bg=SupervisorExec_...889482
    19:34:54  status -> failed     (no error text, 54s after dispatch)
    19:34:54  subtask_requeued_after_timeout -> pending
    19:34:55  dispatched again
    19:35:05  completed

The executor had reported ``completed``; the step was only missing the explicit
``done`` call. ``task_tool`` rewrote that to ``failed`` ("未调用 done"), the
watchdog then requeued it and the wave re-ran for nothing. A missing report is a
reporting miss, not a failed step.
"""

from __future__ import annotations

import inspect


def _src() -> str:
    """Read the source file directly — ``task_tool`` is a StructuredTool, not a module."""
    from pathlib import Path

    import evoflow.tools.builtins.task_tool as _pkg  # noqa: F401  (ensures installed)

    path = Path(__file__).resolve().parents[1] / "packages/harness/evoflow/tools/builtins/task_tool.py"
    return path.read_text(encoding="utf-8")


def test_missing_done_is_not_failed():
    """The executor=completed + no-done branch must resolve to completed."""
    src = _src()
    start = src.index('if ex == "completed":')
    # The branch ends at the next executor-outcome assertion.
    end = src.index('sys_outcome = ex if ex in', start)
    branch = src[start:end]

    assert 'outcome="failed"' not in branch, (
        "executor=completed branch must not write a failed outcome "
        "(this is what killed finished steps and forced a re-run)"
    )
    assert 'outcome="completed"' in branch, "missing-done path must record completed"


def test_missing_done_schedules_followup_wave():
    """Dependents must still be released when ``done`` was skipped."""
    src = _src()
    start = src.index('if ex == "completed":')
    end = src.index('sys_outcome = ex if ex in', start)
    branch = src[start:end]
    assert "_schedule_collab_followup_wave" in branch, (
        "completing without done must still schedule the next wave, "
        "otherwise the rest of the DAG is stranded"
    )


def test_real_failures_still_fail():
    """Genuine executor failures must keep their outcome (no blanket softening)."""
    src = _src()
    assert 'sys_outcome = ex if ex in {"failed", "timed_out", "cancelled", "blocked"}' in src
    assert 'if sys_outcome == "failed" and not err and not draft:' in src
