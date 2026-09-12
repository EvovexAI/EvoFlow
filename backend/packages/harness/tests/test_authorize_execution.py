"""Execution authorization: only user-facing actors may authorize."""

from __future__ import annotations

from evoflow.collab.authorize_execution import authorize_main_task_execution
from evoflow.collab.storage import ProjectStorage, new_project_bundle_root_task


def test_lead_cannot_authorize(tmp_path) -> None:
    storage = ProjectStorage(tmp_path / "bundles")
    project, task = new_project_bundle_root_task("t", "description long enough here", thread_id="t1")
    task["status"] = "planned"
    storage.save_project(project)
    tid = str(task["id"])
    ok, msg = authorize_main_task_execution(storage, tid, "lead")
    assert ok is False
    assert "用户" in msg or "Lead" in msg


def test_user_can_authorize(tmp_path) -> None:
    storage = ProjectStorage(tmp_path / "bundles")
    project, task = new_project_bundle_root_task("t", "description long enough here", thread_id="t2")
    task["status"] = "planned"
    storage.save_project(project)
    tid = str(task["id"])
    ok, msg = authorize_main_task_execution(storage, tid, "user")
    assert ok is True
    assert "authorized" in msg.lower() or "Execution" in msg
