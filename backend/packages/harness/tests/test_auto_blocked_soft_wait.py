"""Soft-block dependents must not pollute user-facing error fields."""

from __future__ import annotations

import pytest

from evoflow.collab.storage import ProjectStorage, new_project_bundle_root_task
from evoflow.persistence.db import reset_db_for_tests
from evoflow.tools.builtins.supervisor.dependency import _auto_finalize_unrunnable_pending_subtasks


@pytest.fixture
def storage(tmp_path, monkeypatch):
    monkeypatch.setenv("EVOFLOW_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("EVOFLOW_DB_PATH", str(tmp_path / "soft_block.sqlite"))
    reset_db_for_tests()
    yield ProjectStorage()
    reset_db_for_tests()


def _load_task(storage: ProjectStorage, task_id: str):
    project = storage.load_project(task_id, bypass_cache=True)
    assert project is not None
    task = next(t for t in (project.get("tasks") or []) if str(t.get("id")) == task_id)
    return project, task


def _seed_task(storage: ProjectStorage, *, upstream_status: str, downstream_error: str | None = None):
    project, task = new_project_bundle_root_task(
        "soft-block",
        "description long enough for soft block test",
        thread_id="t_soft_block",
    )
    task_id = str(task["id"])
    up_id = "Subtask_up_001"
    down_id = "Subtask_down_001"
    down: dict = {
        "id": down_id,
        "name": "downstream",
        "status": "pending",
        "worker_profile": {"depends_on": [up_id]},
    }
    if downstream_error:
        down["error"] = downstream_error
        down["error_text"] = downstream_error
    task["status"] = "executing"
    task["subtasks"] = [
        {"id": up_id, "name": "upstream", "status": upstream_status},
        down,
    ]
    project["tasks"] = [task]
    assert storage.save_project(project)
    return task_id, up_id, down_id


def test_auto_blocked_does_not_write_error_field(storage):
    task_id, up_id, down_id = _seed_task(storage, upstream_status="failed")

    out = _auto_finalize_unrunnable_pending_subtasks(storage, task_id)
    assert out["changed"] is True
    assert out["skipped"][0]["subtaskId"] == down_id
    assert up_id in out["skipped"][0]["reason"]

    _proj, task = _load_task(storage, task_id)
    by_id = {str(s["id"]): s for s in task["subtasks"]}
    down = by_id[down_id]
    assert down["status"] == "waiting_dispatch"
    assert str(down.get("dispatch_block_reason") or "").startswith("auto_blocked:")
    assert not down.get("error")
    assert not down.get("error_text")


def test_auto_blocked_clears_when_upstream_recovers(storage):
    stale = "auto_blocked: upstream_terminal_non_completed=['Subtask_up_001']"
    task_id, _up_id, down_id = _seed_task(
        storage,
        upstream_status="completed",
        downstream_error=stale,
    )

    proj, task = _load_task(storage, task_id)
    for st in task["subtasks"]:
        if st["id"] == down_id:
            st["status"] = "waiting_dispatch"
            st["dispatch_block_reason"] = stale
    storage.save_project(proj)

    out = _auto_finalize_unrunnable_pending_subtasks(storage, task_id)
    assert out["changed"] is True

    _proj2, task2 = _load_task(storage, task_id)
    down = next(s for s in task2["subtasks"] if s["id"] == down_id)
    assert not down.get("error")
    assert not down.get("error_text")
    assert not down.get("dispatch_block_reason")
