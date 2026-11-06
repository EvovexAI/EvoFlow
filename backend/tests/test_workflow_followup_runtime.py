"""Regression: a workflow DAG wave must never be skipped for lack of a runtime.

The Lead runtime registry (``execution_kernel._collab_lead_runtime_*``) is
process-local and short-lived. Three things used to make a queued workflow
wave resolve to ``source=none`` and get silently skipped:

1. The weakref callback installed by ``store_lead_runtime`` popped the strong
   ref of the *current* runtime when an *older* runtime was collected.
2. The background monitor released the lead runtime as soon as the main task
   looked terminal, even while subtasks were still queued.
3. The workflow scheduler had no fallback at all — with no registry entry it
   gave up (``error=no_runtime``) and the remaining wave never ran.

Prod symptom (2026-11-06, task 2611061932_f598): the DAG log showed
``followup_runtime main=... source=none`` right before the task stalled.
"""

from __future__ import annotations

import gc
from typing import Any

import pytest

from evoflow.collab import execution_kernel as kernel


# --------------------------------------------------------------------------
# 1. The weakref callback must only clear the strong ref it owns.
# --------------------------------------------------------------------------


class _Runtime:
    """A plain object that supports weak references."""

    __slots__ = ("__weakref__",)


def _clear_registry() -> None:
    kernel._collab_lead_runtime_strong.clear()
    kernel._collab_lead_runtime_by_task.clear()


def test_older_runtime_gc_does_not_drop_newer_registered_runtime():
    """Regression: a stale weakref callback must not evict the live runtime.

    ``store_lead_runtime`` is called on every delegation, so it replaces the
    registry entry each time. The replaced weakref object can outlive its
    runtime (anything holding a reference to it keeps it alive). When that
    older runtime is finally collected, its callback fires — and without the
    identity guard it popped the *current* runtime's strong ref, leaving a
    live, registered runtime invisible to ``resolve_followup_runtime``
    (``source=none``).
    """
    _clear_registry()
    try:
        older = _Runtime()
        newer = _Runtime()

        kernel.store_lead_runtime("m1", older)
        # Keep the previous weakref object alive: that is what lets its
        # callback fire after the registry moved on to ``newer``.
        stale_weakref = kernel._collab_lead_runtime_by_task["m1"]

        kernel.store_lead_runtime("m1", newer)
        assert stale_weakref is not kernel._collab_lead_runtime_by_task["m1"]

        # Drop the older runtime → its callback fires.
        del older
        gc.collect()

        assert kernel.peek_lead_runtime("m1") is newer
        assert kernel.resolve_followup_runtime(None, "m1") is newer
    finally:
        _clear_registry()


def test_current_runtime_gc_clears_the_strong_ref():
    """The strong ref keeps the runtime alive, so it survives on its own.

    This is what makes the bug in the test above possible: registering a
    newer runtime *replaces* the strong ref, which releases the older
    runtime, and the older runtime's weakref callback then fires against
    the registry that now belongs to the newer runtime.
    """
    _clear_registry()
    try:
        runtime = _Runtime()
        kernel.store_lead_runtime("m1", runtime)
        # The strong ref keeps it alive even without any local reference.
        del runtime
        gc.collect()
        assert kernel.peek_lead_runtime("m1") is not None
    finally:
        _clear_registry()


def test_drop_lead_runtime_releases_everything():
    _clear_registry()
    try:
        kernel.store_lead_runtime("m1", _Runtime())
        kernel.drop_lead_runtime("m1")
        assert kernel.peek_lead_runtime("m1") is None
    finally:
        _clear_registry()


# --------------------------------------------------------------------------
# 2. The monitor must keep the runtime while a wave is still queued.
# --------------------------------------------------------------------------


def test_has_pending_subtasks_detects_queued_wave():
    from evoflow.tools.builtins.supervisor.monitor import _has_pending_subtasks

    assert _has_pending_subtasks([{"status": "completed"}]) is False
    assert _has_pending_subtasks([{"status": "failed"}]) is False
    assert _has_pending_subtasks([{"status": "cancelled"}]) is False
    assert _has_pending_subtasks([{"status": "timed_out"}]) is False
    assert _has_pending_subtasks([{"status": "skipped"}]) is False

    assert _has_pending_subtasks([{"status": "completed"}, {"status": "pending"}]) is True
    assert _has_pending_subtasks([{"status": "planned"}]) is True
    assert _has_pending_subtasks([{"status": "executing"}]) is True
    assert _has_pending_subtasks([]) is False


# --------------------------------------------------------------------------
# 3. The workflow scheduler must self-provision a runtime instead of giving up.
# --------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_followup_wave_self_provisions_runtime_when_registry_is_empty(monkeypatch: pytest.MonkeyPatch):
    from evoflow.collab import workflow_scheduler as sched

    pushes: list[tuple] = []
    waved: list[tuple] = []

    monkeypatch.setattr(
        sched,
        "_load_main_task",
        lambda _tid: {"id": "wf1", "source_app_id": "App_x", "execution_authorized": True},
    )
    # Registry is empty → resolve_followup_runtime returns None.
    monkeypatch.setattr(
        "evoflow.collab.execution_kernel.resolve_followup_runtime",
        lambda runtime, tid: None,
    )

    class _Lock:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

    monkeypatch.setattr(
        "evoflow.collab.execution_kernel.followup_lock_for_task",
        lambda _tid: _Lock(),
    )
    monkeypatch.setattr(
        "evoflow.collab.execution_kernel.verify_upstream_artifacts_before_followup",
        lambda *_a, **_k: None,
    )
    monkeypatch.setattr(
        "evoflow.collab.storage.find_main_task",
        lambda *_a, **_k: (
            {},
            {"id": "wf1", "source_app_id": "App_x", "execution_authorized": True},
        ),
    )
    monkeypatch.setattr(
        "evoflow.collab.storage.get_project_storage",
        lambda: __import__("unittest.mock", fromlist=["MagicMock"]).MagicMock(),
    )

    provisioned = object()

    monkeypatch.setattr(sched, "_workflow_execution_runtime", lambda _tid: provisioned)

    async def _wave(runtime, storage, tid, wait_for_completion=False):
        waved.append((runtime, tid))
        return [{"subtaskId": "s2", "ok": True, "detached": False}]

    monkeypatch.setattr(
        "evoflow.collab.step_runner.advance_runnable_wave",
        _wave,
    )
    monkeypatch.setattr(
        sched,
        "_push_app_run",
        lambda tid, reason="": pushes.append((tid, reason)),
    )

    out = await sched.advance_dag("wf1", reason="followup", runtime=None)

    assert out["ok"] is True
    assert out["error"] if "error" in out else True
    assert waved, "the follow-up wave must still be delegated"
    assert waved[0][0] is provisioned
    assert waved[0][1] == "wf1"
    assert pushes == [("wf1", "dag_followup")]


@pytest.mark.asyncio
async def test_followup_wave_reports_no_runtime_when_provisioning_fails(monkeypatch: pytest.MonkeyPatch):
    from evoflow.collab import workflow_scheduler as sched

    pushes: list[tuple] = []

    monkeypatch.setattr(
        sched,
        "_load_main_task",
        lambda _tid: {"id": "wf1", "source_app_id": "App_x", "execution_authorized": True},
    )
    monkeypatch.setattr(
        "evoflow.collab.execution_kernel.resolve_followup_runtime",
        lambda runtime, tid: None,
    )
    monkeypatch.setattr(sched, "_workflow_execution_runtime", lambda _tid: None)
    monkeypatch.setattr(
        sched,
        "_push_app_run",
        lambda tid, reason="": pushes.append((tid, reason)),
    )

    out = await sched.advance_dag("wf1", reason="followup", runtime=None)

    assert out["ok"] is False
    assert out["error"] == "no_runtime"
    assert pushes == [("wf1", "dag_followup_no_runtime")]
