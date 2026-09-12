"""Plan scenario binds a placeholder main task with status/progress before supervisor create."""

from __future__ import annotations

from datetime import UTC
from pathlib import Path

import pytest

from evoflow.collab.models import CollabPhase, TaskStatus
from evoflow.collab.plan_session_task import (
    PLAN_SESSION_IDLE_REUSE_SECONDS,
    bind_plan_to_thread_task,
    ensure_plan_session_task,
    try_reuse_bound_plan_root_task,
)
from evoflow.collab.storage import ProjectStorage, find_main_task
from evoflow.collab.thread_collab import load_thread_collab_state, merge_thread_collab_state, save_thread_collab_state

_MIN_STEP = {
    "name": "s1",
    "goal": "x",
    "inputs": "i",
    "outputs": "o",
    "acceptance": "a",
    "failure": "f",
    "assigned_agent": "general-purpose",
}


class _FakePaths:
    def __init__(self, base_dir: Path):
        self.base_dir = base_dir

    def thread_dir(self, thread_id: str) -> Path:
        return self.base_dir / "threads" / thread_id


@pytest.fixture
def plan_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    home = tmp_path / "home"
    home.mkdir()
    paths = _FakePaths(home)
    storage = ProjectStorage(tmp_path / "bundles")
    monkeypatch.setattr("evoflow.collab.plan_session_task.get_paths", lambda: paths)
    monkeypatch.setattr("evoflow.collab.plan_session_task.get_project_storage", lambda: storage)
    monkeypatch.setattr("evoflow.config.paths.get_paths", lambda: paths)
    import uuid

    tid = f"Thread_plan_test_{uuid.uuid4().hex[:12]}"
    return {"paths": paths, "storage": storage, "thread_id": tid}


def test_ensure_plan_session_task_creates_placeholder(plan_env):
    tid = plan_env["thread_id"]
    paths = plan_env["paths"]
    meta = ensure_plan_session_task(tid, paths=paths)
    assert meta["created"] is True
    assert meta["task_id"]
    assert meta["status"] == TaskStatus.PLANNING.value
    assert meta["progress"] == 0

    collab = load_thread_collab_state(paths, tid)
    assert collab.bound_task_id == meta["task_id"]
    assert collab.collab_phase == CollabPhase.PLANNING

    row = find_main_task(plan_env["storage"], meta["task_id"])
    assert row is not None
    _proj, task = row
    assert task.get("thread_id") == tid
    assert not task.get("subtasks")


def test_bind_plan_updates_task_and_reuse_fills_name(plan_env):
    tid = plan_env["thread_id"]
    paths = plan_env["paths"]
    storage = plan_env["storage"]
    ensure_plan_session_task(tid, paths=paths)

    bind = bind_plan_to_thread_task(tid, goal="x", steps=[_MIN_STEP], paths=paths)
    assert bind["bound"] is True
    assert bind["task_id"]
    assert bind["status"] == TaskStatus.PLANNED.value
    assert bind["progress"] == 0
    row = find_main_task(storage, bind["task_id"])
    assert row is not None
    _proj, task = row
    assert task["name"] == "x"
    assert task["description"] == "x"
    assert task.get("plan_goal") == "x"

    reused = try_reuse_bound_plan_root_task(storage, tid, "用户正式任务名", "详细描述" * 5)
    assert reused is not None
    _proj, task = reused
    assert task["name"] == "用户正式任务名"
    assert task.get("plan_goal") == "x"


def test_repeated_plan_toggle_reuses_same_task(plan_env):
    tid = plan_env["thread_id"]
    paths = plan_env["paths"]
    first = ensure_plan_session_task(tid, paths=paths)
    second = ensure_plan_session_task(tid, paths=paths)
    assert first["task_id"]
    assert second["task_id"] == first["task_id"]
    assert second["created"] is False
    assert second["reused"] is True


def test_reuses_after_bound_task_cleared_on_idle(plan_env):
    tid = plan_env["thread_id"]
    paths = plan_env["paths"]
    first = ensure_plan_session_task(tid, paths=paths)
    cur = load_thread_collab_state(paths, tid)
    save_thread_collab_state(
        paths,
        tid,
        merge_thread_collab_state(cur, {"collab_phase": CollabPhase.IDLE.value, "bound_task_id": None}),
    )
    second = ensure_plan_session_task(tid, paths=paths)
    assert second["task_id"] == first["task_id"]
    assert second["reused"] is True
    collab = load_thread_collab_state(paths, tid)
    assert collab.bound_task_id == first["task_id"]


def test_stale_placeholder_reset_after_idle_window(plan_env):
    from datetime import datetime, timedelta

    tid = plan_env["thread_id"]
    paths = plan_env["paths"]
    storage = plan_env["storage"]
    meta = ensure_plan_session_task(tid, paths=paths)
    bind_plan_to_thread_task(tid, goal="x", steps=[_MIN_STEP], paths=paths)

    row = find_main_task(storage, meta["task_id"])
    assert row is not None
    project, task = row
    old = datetime.now(UTC) - timedelta(seconds=PLAN_SESSION_IDLE_REUSE_SECONDS + 120)
    task["plan_session_last_active_at"] = old.strftime("%Y-%m-%dT%H:%M:%SZ")
    storage.save_project(project)

    again = ensure_plan_session_task(tid, paths=paths)
    assert again["task_id"] == meta["task_id"]
    assert again["reused"] is True
    assert again["staleReset"] is True

    row2 = find_main_task(storage, meta["task_id"])
    assert row2 is not None
    _p2, t2 = row2
    assert not str(t2.get("plan_goal") or "").strip()
    assert t2["status"] == TaskStatus.PLANNING.value
    assert int(t2.get("progress") or 0) == 0


def test_begin_new_plan_cycle_after_done_creates_fresh_task(plan_env):
    tid = plan_env["thread_id"]
    paths = plan_env["paths"]
    storage = plan_env["storage"]

    first = ensure_plan_session_task(tid, paths=paths)
    bind_plan_to_thread_task(tid, goal="first plan", steps=[_MIN_STEP], paths=paths)
    row = find_main_task(storage, first["task_id"])
    assert row is not None
    project, task = row
    task["status"] = TaskStatus.COMPLETED.value
    task["progress"] = 100
    storage.save_project(project)

    cur = load_thread_collab_state(paths, tid)
    save_thread_collab_state(
        paths,
        tid,
        merge_thread_collab_state(cur, {"collab_phase": CollabPhase.DONE.value}),
    )

    bind = bind_plan_to_thread_task(tid, goal="second plan", steps=[_MIN_STEP], paths=paths)
    assert bind["bound"] is True
    assert bind.get("newCycle") is True
    assert bind["previousTaskId"] == first["task_id"]
    assert bind["task_id"] != first["task_id"]

    collab = load_thread_collab_state(paths, tid)
    assert collab.collab_phase == CollabPhase.PLAN_READY
    assert collab.bound_task_id == bind["task_id"]

    row2 = find_main_task(storage, bind["task_id"])
    assert row2 is not None
    _p2, t2 = row2
    assert t2.get("plan_goal") == "second plan"
    assert t2["status"] == TaskStatus.PLANNED.value
