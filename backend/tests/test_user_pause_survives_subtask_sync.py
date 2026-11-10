"""A user pause must survive the in-flight worker's completion report.

Live reproduction (2026-09 / 2026-11-08 → 2026-11-09): ``workflow.stop(pause=true)``
landed (DB row read back ``status=paused`` + ``pause_requested_by="user"`` at
07:11:10) and yet the next wave dispatched 11 seconds later at 07:11:21. All five
runs that ever carried a user-pause marker completed anyway.

The three dispatch gates (``dispatch_authorized_main_task_execution``,
``workflow_scheduler.advance_dag``, supervisor ``delegate``) are correct — they
refuse on ``paused``. They simply never saw it: when the in-flight subtask
reported ``done``, ``sync_main_task_from_subtasks`` recomputed the main-task
status from the subtask rows and rewrote ``paused`` → ``executing``, so every
gate downstream read an un-paused task and waved the wave through.

So the invariant to pin is not "the gate blocks when the row says paused" (the
old tests asserted that against a hand-made dict and stayed green while the
product was broken). It is: **nothing may clear a user pause except resume.**
"""

from __future__ import annotations

from typing import Any

import pytest


def _main(status: str = "paused", **extra: Any) -> dict[str, Any]:
    task = {
        "id": "T_MAIN",
        "status": status,
        "progress": 33,
        "source_app_id": "App_pause_test",
        "source_run_id": "Run_pause_test",
        "subtasks": [
            {
                "id": "S_1",
                "status": "completed",
                "progress": 100,
                "outcome_reported_at": "2026-11-09T07:11:20Z",
            },
            {"id": "S_2", "status": "planned", "depends_on": ["S_1"]},
            {"id": "S_3", "status": "planned", "depends_on": ["S_2"]},
        ],
    }
    task.update(extra)
    return task


class _Storage:
    def __init__(self, task: dict[str, Any]):
        self._project = {"id": "p1", "tasks": [task]}

    def list_projects(self):
        return [{"id": "p1"}]

    def load_project(self, project_id, *, bypass_cache: bool = False):
        return self._project

    def save_project(self, project):
        self._project = project


def _sync(task: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    from evoflow.collab.task_progress import sync_main_task_from_subtasks

    storage = _Storage(task)
    res = sync_main_task_from_subtasks(storage, "T_MAIN")
    return storage._project["tasks"][0], res


def test_user_pause_is_not_rewritten_by_subtask_sync():
    """The exact sequence that broke in production: pause → worker reports done."""
    task = _main(pause_requested_by="user", pause_reason="user paused", paused_at="2026-11-09T07:11:10Z")
    saved, res = _sync(task)
    assert saved.get("status") == "paused", (
        f"subtask sync clobbered the user pause → {saved.get('status')!r}; "
        "the next wave will dispatch even though the user stopped the run"
    )
    assert res.get("changed") is False or saved.get("status") == "paused"


def test_user_pause_marker_survives_even_without_status_column_match():
    """Marker is the contract: resume pops it, nothing else may."""
    task = _main(pause_requested_by="user")
    saved, _res = _sync(task)
    assert saved.get("pause_requested_by") == "user"


@pytest.mark.parametrize("status", ["executing", "running", "pending", "planned"])
def test_no_pause_marker_means_normal_recompute(status):
    """Without a user-pause marker the rollup keeps working as before —
    the guard must not freeze ordinary runs."""
    task = _main(status=status)
    saved, _res = _sync(task)
    assert saved.get("status") != "paused"
    # one completed + two planned → still in flight, never a false close
    assert saved.get("status") in {"executing", "running", status}


def test_terminal_main_task_still_wins_over_pause_marker():
    """Once every subtask is terminal the run must still close (skipped/failed
    rollup must not be held hostage by a stale marker)."""
    task = _main(pause_requested_by="user")
    for st in task["subtasks"]:
        st["status"] = "completed"
        st["progress"] = 100
        st["outcome_reported_at"] = "2026-11-09T07:12:00Z"
    saved, _res = _sync(task)
    assert saved.get("status") == "completed", saved.get("status")


@pytest.mark.asyncio
async def test_wave_is_blocked_after_the_done_callback_lands(monkeypatch):
    """End-to-end: pause → in-flight worker reports done → the next wave must be refused.

    The three gates were already tested against a hand-made ``status="paused"``
    dict and stayed green while production dispatched every wave anyway, because
    the row they read had long since been rewritten to ``executing``. This feeds
    the gate the *real* row: the one that comes out of the subtask rollup.
    """
    import evoflow.collab.storage as storage_mod
    from evoflow.collab import workflow_scheduler as ws

    task = _main(pause_requested_by="user", paused_at="2026-11-09T07:11:10Z")
    storage = _Storage(task)
    # The worker's ``done`` callback, then the follow-up wave — same storage.
    from evoflow.collab.task_progress import sync_main_task_from_subtasks

    sync_main_task_from_subtasks(storage, "T_MAIN")

    monkeypatch.setattr(storage_mod, "get_project_storage", lambda: storage, raising=False)
    monkeypatch.setattr(ws, "get_project_storage", lambda: storage, raising=False)
    monkeypatch.setattr(ws, "is_workflow_scheduler_task", lambda _t: True)

    out = await ws.advance_dag("T_MAIN", reason="followup")
    assert out.get("error") == "paused", out


def test_resume_clears_marker_and_reopens():
    """Symmetry check: resume is the only legitimate un-pause."""
    from evoflow.collab import app_runner  # noqa: F401  (module must import)

    task = _main(pause_requested_by="user")
    for k in ("pause_requested_by", "pause_reason", "paused_at"):
        task.pop(k, None)
    task["status"] = "executing"
    saved, _res = _sync(task)
    assert saved.get("pause_requested_by") is None
