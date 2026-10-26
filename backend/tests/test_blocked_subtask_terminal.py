"""Regression: worker-reported ``blocked`` subtask must be terminal for DAG + rollup.

Before the fix, ``blocked`` was absent from dependency._TERMINAL_SUBTASK, so the
follow-up wave kept treating the blocked step as runnable, step_runner refused to
claim it (not_claimable) and the wave aborted every ~60s while the main task
stayed ``executing`` (observed on task 2610250214_8c61).
"""

from __future__ import annotations

from evoflow.collab.task_progress import infer_main_status_from_subtasks
from evoflow.tools.builtins.supervisor.dependency import (
    _FAILED_UPSTREAM_STATUSES,
    _TERMINAL_SUBTASK,
    _auto_finalize_unrunnable_pending_subtasks,
    _resolve_subtasks_for_start_execution,
)


class _Storage:
    """Minimal project storage stub exposing one main task row."""

    def __init__(self, task: dict):
        self._project = {"id": "p1", "tasks": [task]}

    def list_projects(self):
        return [{"id": "p1"}]

    def load_project(self, project_id, *, bypass_cache: bool = False):
        return self._project

    def save_project(self, project):
        self._project = project


def _task(subtasks: list[dict]) -> dict:
    return {"id": "T_MAIN", "status": "executing", "progress": 5, "subtasks": subtasks}


def _sub(sid: str, status: str, *, deps=(), ref: str = "") -> dict:
    return {
        "id": sid,
        "name": sid,
        "status": status,
        "assigned_to": "general-purpose",
        "worker_profile": {"depends_on": list(deps), "base_subagent": "general-purpose"},
        "ref": ref,
    }


def test_blocked_is_terminal_for_dag():
    assert "blocked" in _TERMINAL_SUBTASK
    assert "blocked" in _FAILED_UPSTREAM_STATUSES


def test_runnable_never_contains_blocked_subtask():
    """The dead step must not be handed to delegate (step_runner would abort)."""
    storage = _Storage(_task([_sub("S1", "blocked"), _sub("S2", "planned", deps=["S1"])]))
    runnable, blocked = _resolve_subtasks_for_start_execution(storage, "T_MAIN", None)
    # S1 (blocked) is terminal -> not runnable. S2 waits on it -> reported blocked, not runnable.
    assert runnable == []
    assert "S1" not in [row.get("subtaskId") for row in blocked if row.get("reason") != "waiting_on_dependencies"]
    assert any(row.get("subtaskId") == "S2" for row in blocked)


def test_explicit_request_for_blocked_subtask_is_reported_terminal():
    """A wave that explicitly names the blocked step must get already_terminal (no silent re-dispatch)."""
    storage = _Storage(_task([_sub("S1", "blocked")]))
    runnable, blocked = _resolve_subtasks_for_start_execution(storage, "T_MAIN", ["S1"])
    assert runnable == []
    assert blocked and blocked[0].get("reason") == "already_terminal" and blocked[0].get("status") == "blocked"


def test_downstream_of_blocked_upstream_is_not_dispatched():
    """Live case 2610250214_8c61: Step1 blocked, Step2 depends on it.

    Before the fix both steps sat in a 60s re-dispatch loop. After the fix Step1 is
    terminal so it is dropped from the wave; Step2 must NOT be handed to a worker
    (its upstream produced nothing) — it is parked by the auto-finalize pass instead.
    """
    storage = _Storage(_task([_sub("S1", "blocked", ref="1"), _sub("S2", "planned", deps=["1"], ref="2")]))
    runnable, blocked = _resolve_subtasks_for_start_execution(storage, "T_MAIN", None)
    assert runnable == []
    assert any(row.get("subtaskId") == "S2" for row in blocked)
    report = _auto_finalize_unrunnable_pending_subtasks(storage, "T_MAIN")
    assert report.get("changed") is True
    park = {s["id"]: s["status"] for s in storage._project["tasks"][0]["subtasks"]}
    assert park["S1"] == "blocked"
    assert park["S2"] == "waiting_dispatch"


def test_blocked_rolls_main_task_to_failed():
    # blocked + not-yet-terminal dependent -> nothing terminal to infer yet (stays executing)
    subs = [_sub("S1", "blocked"), _sub("S2", "planned", deps=["S1"])]
    assert infer_main_status_from_subtasks(subs) is None
    # once the dependent is skipped, every subtask is terminal and one of them failed
    # -> the main task converges to failed instead of spinning at executing/5%.
    subs[1]["status"] = "failed"
    assert infer_main_status_from_subtasks(subs) == "failed"
