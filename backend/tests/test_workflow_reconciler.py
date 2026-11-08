"""Workflow crash/node recover reconciler."""

from __future__ import annotations

import time

from evoflow.collab.runner_epoch import current_runner_epoch, reset_runner_epoch_for_tests
from evoflow.collab.workflow_reconciler import is_zombie_executing_subtask


def test_zombie_when_epoch_mismatches():
    reset_runner_epoch_for_tests("ep-live")
    st = {
        "status": "executing",
        "runner_epoch": "ep-old",
        "lease_until_ts": time.time() + 9999,
    }
    assert is_zombie_executing_subtask(st, reason="tick") is True


def test_not_zombie_when_same_epoch_and_lease_valid():
    ep = reset_runner_epoch_for_tests()
    st = {
        "status": "executing",
        "runner_epoch": ep,
        "lease_until_ts": time.time() + 9999,
    }
    assert is_zombie_executing_subtask(st, reason="tick") is False
    assert current_runner_epoch() == ep


def test_zombie_when_lease_expired():
    ep = reset_runner_epoch_for_tests()
    st = {
        "status": "executing",
        "runner_epoch": ep,
        "lease_until_ts": time.time() - 10,
    }
    assert is_zombie_executing_subtask(st, reason="tick") is True


def test_boot_treats_pre_epoch_executing_as_zombie():
    reset_runner_epoch_for_tests("ep-boot")
    st = {"status": "executing", "lease_until_ts": time.time() + 9999}
    assert is_zombie_executing_subtask(st, reason="boot") is True
    assert is_zombie_executing_subtask(st, reason="tick") is False


# ── Desktop split process model (Gateway ticks vs LangGraph claims) ─────────
#
# Regression: the reconciler ticks in the Gateway process while task_tool
# claims run in the LangGraph process.  When the epoch was a per-process uuid,
# the Gateway never matched the row epoch and "healed" a *live* Step 2 back to
# pending on the very next tick (observed as error_text="reconcile:tick:zombie_executing"
# on a subtask that then completed normally 16s later).


def test_epoch_uses_boot_cycle_id_so_processes_share_it(monkeypatch):
    reset_runner_epoch_for_tests()
    monkeypatch.delenv("EVOFLOW_RUNNER_EPOCH", raising=False)
    monkeypatch.setenv("EVOFLOW_BOOT_CYCLE_ID", "bc-1792907086215-45008")
    from evoflow.collab import runner_epoch

    runner_epoch._EPOCH = None
    runner_epoch._OVERRIDE = None
    assert current_runner_epoch() == "bc-1792907086215-45008"
    assert runner_epoch.runner_epoch_is_shared() is True


def test_epoch_falls_back_to_process_id_without_boot_env(monkeypatch):
    reset_runner_epoch_for_tests()
    monkeypatch.delenv("EVOFLOW_RUNNER_EPOCH", raising=False)
    monkeypatch.delenv("EVOFLOW_BOOT_CYCLE_ID", raising=False)
    from evoflow.collab import runner_epoch

    runner_epoch._EPOCH = None
    runner_epoch._OVERRIDE = None
    assert current_runner_epoch().startswith("ep-")
    # Not comparable across processes → epoch mismatch must NOT be conclusive.
    assert runner_epoch.runner_epoch_is_shared() is False


def test_cross_process_epoch_mismatch_is_not_zombie_when_epoch_unscoped(monkeypatch):
    """Per-process epoch must not be used to condemn a live worker."""
    monkeypatch.delenv("EVOFLOW_RUNNER_EPOCH", raising=False)
    monkeypatch.delenv("EVOFLOW_BOOT_CYCLE_ID", raising=False)
    reset_runner_epoch_for_tests()
    from evoflow.collab import runner_epoch

    runner_epoch._EPOCH = None
    runner_epoch._OVERRIDE = None

    st = {
        "status": "executing",
        "runner_epoch": "ep-some-other-process",
        "lease_until_ts": time.time() + 9999,
        "updated_at": "2026-10-25T13:46:24.675852+08:00",
    }
    # Lease valid + epoch not comparable → must stay alive (regression guard).
    assert is_zombie_executing_subtask(st, reason="tick") is False


def test_cross_process_epoch_mismatch_is_zombie_when_epoch_boot_scoped(monkeypatch):
    """With a boot-scoped epoch, a row from a *previous* boot must still heal."""
    monkeypatch.delenv("EVOFLOW_RUNNER_EPOCH", raising=False)
    monkeypatch.setenv("EVOFLOW_BOOT_CYCLE_ID", "bc-current-boot")
    reset_runner_epoch_for_tests()
    from evoflow.collab import runner_epoch

    runner_epoch._EPOCH = None
    runner_epoch._OVERRIDE = None

    st = {
        "status": "executing",
        "runner_epoch": "bc-previous-boot",
        "lease_until_ts": time.time() + 9999,
    }
    assert is_zombie_executing_subtask(st, reason="tick") is True

    st_same = {
        "status": "executing",
        "runner_epoch": "bc-current-boot",
        "lease_until_ts": time.time() + 9999,
    }
    assert is_zombie_executing_subtask(st_same, reason="tick") is False


# ── Requeue must not leave the previous failure text on the row ─────────────
#
# Regression: Step 2 reported 「子智能体异常结束 (failed)」, the reconciler
# requeued it, and the panel kept rendering that error while the retry was
# already writing thousands of lines — the row looked crashed but was alive,
# and ``is_subtask_outcome_reported()`` still returned True for a pending row.


def _failed_row() -> dict:
    return {
        "id": "s2",
        "status": "failed",
        "summary": "子智能体异常结束 (failed)",
        "error": "子智能体异常结束 (failed)",
        "error_kind": "business",
        "task_report": "attempt-1 report",
        "result": "attempt-1 result",
        "outcome_reported_at": "2026-10-31T22:24:56Z",
        "outcome_reported_by": "system",
        "failed_at": "2026-10-31T22:24:56Z",
        "completed_at": "2026-10-31T22:24:56Z",
        "auto_retry_count": 0,
    }


def test_failed_retry_clears_previous_outcome_residue(monkeypatch):
    from evoflow.collab import workflow_reconciler

    monkeypatch.setenv("EVOFLOW_SUBTASK_AUTO_RETRY_MAX", "3")
    st = _failed_row()
    healed = workflow_reconciler._heal_subtasks(
        {"subtasks": [st]}, reason="tick", now_ts=time.time()
    )

    assert [h["why"] for h in healed] == ["failed_retry"]
    assert st["status"] == "pending"
    for key in (
        "outcome_reported_at",
        "outcome_reported_by",
        "task_report",
        "summary",
        "result",
        "failed_at",
        "completed_at",
    ):
        assert key not in st, f"{key} should be cleared before re-dispatch"
    assert st["error"].startswith("reconcile:tick:retry_failed")
    assert st["auto_retry_count"] == 1

    from evoflow.collab.subtask_outcome import is_subtask_outcome_reported

    assert is_subtask_outcome_reported(st) is False


def test_zombie_heal_clears_previous_outcome_residue():
    from evoflow.collab import workflow_reconciler

    st = _failed_row() | {"status": "executing", "lease_until_ts": time.time() - 10}
    healed = workflow_reconciler._heal_subtasks(
        {"subtasks": [st]}, reason="tick", now_ts=time.time()
    )

    assert [h["why"] for h in healed] == ["zombie_executing"]
    assert st["status"] == "pending"
    assert "task_report" not in st
    assert "outcome_reported_at" not in st


def test_terminal_but_unreported_row_is_restamped_and_releases_dependents():
    """The one deadlock the healer used to miss.

    The dependency gate reads ``outcome_reported_at``, not ``status``, so a row
    that is completed but never stamped shows as 完成 in the panel while every
    tick answers ``no_runnable_subtasks`` for its dependents forever (real case:
    a template node left a 4-step run stuck at 75%). Healing must re-stamp from
    the row's own completion data and **not** downgrade it to pending, which
    would re-run finished work and duplicate its artifacts.
    """
    from evoflow.collab import workflow_reconciler
    from evoflow.collab.subtask_outcome import (
        is_subtask_outcome_reported,
        is_upstream_subtask_dependency_met,
    )

    st = {
        "id": "s3",
        "status": "completed",
        "progress": 100,
        "task_report": "模板渲染结果",
        "result_summary": "模板渲染结果",
        "completed_at": "2026-11-08T01:39:51+08:00",
    }
    assert is_upstream_subtask_dependency_met(st) is False  # stuck: gate closed

    healed = workflow_reconciler._heal_subtasks(
        {"subtasks": [st]}, reason="tick", now_ts=time.time()
    )

    assert [h["why"] for h in healed] == ["restamp_unreported_terminal"]
    assert st["status"] == "completed", "must not re-run finished work"
    assert is_subtask_outcome_reported(st) is True
    assert is_upstream_subtask_dependency_met(st) is True  # gate open now
    # Stamp reuses the real completion time rather than inventing "now".
    assert st["outcome_reported_at"] == "2026-11-08T01:39:51+08:00"
    assert st["outcome_reported_by"] == "system"


def test_reported_completed_row_is_left_alone():
    """Already-stamped rows must not be touched (no churn, no overwritten provenance)."""
    from evoflow.collab import workflow_reconciler

    st = {
        "id": "s3",
        "status": "completed",
        "outcome_reported_at": "2026-11-08T01:39:51+08:00",
        "outcome_reported_by": "worker",
    }
    before = dict(st)
    healed = workflow_reconciler._heal_subtasks(
        {"subtasks": [st]}, reason="tick", now_ts=time.time()
    )
    assert healed == []
    assert st == before


def test_retry_budget_exhausted_keeps_failure_text(monkeypatch):
    """No retry left ⇒ row stays failed and must keep its report for the user."""
    from evoflow.collab import workflow_reconciler

    monkeypatch.setenv("EVOFLOW_SUBTASK_AUTO_RETRY_MAX", "1")
    st = _failed_row() | {"auto_retry_count": 1}
    healed = workflow_reconciler._heal_subtasks(
        {"subtasks": [st]}, reason="tick", now_ts=time.time()
    )

    assert healed == []
    assert st["status"] == "failed"
    assert st["task_report"] == "attempt-1 report"
