"""Plan revision clears execution authorization on the main task."""

from __future__ import annotations

from pathlib import Path

import pytest

from evoflow.collab.authorize_execution import authorize_main_task_execution, revoke_main_task_execution_authorization
from evoflow.collab.plan_session_task import bind_plan_to_thread_task
from evoflow.collab.storage import ProjectStorage, find_main_task


def _step(goal: str) -> dict[str, str]:
    return {
        "name": "s1",
        "goal": goal,
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
    paths = _FakePaths(tmp_path / "home")
    storage = ProjectStorage(tmp_path / "bundles")
    monkeypatch.setattr("evoflow.collab.plan_session_task.get_paths", lambda: paths)
    monkeypatch.setattr("evoflow.collab.plan_session_task.get_project_storage", lambda: storage)
    monkeypatch.setattr("evoflow.collab.storage.get_project_storage", lambda: storage)
    monkeypatch.setattr("evoflow.config.paths.get_paths", lambda: paths)
    return {"paths": paths, "storage": storage, "thread_id": "Thread_revoke_test"}


def test_bind_plan_revision_revokes_authorization(plan_env) -> None:
    tid = plan_env["thread_id"]
    paths = plan_env["paths"]
    storage = plan_env["storage"]

    meta = bind_plan_to_thread_task(tid, goal="first", steps=[_step("first")], paths=paths)
    task_id = meta["task_id"]
    assert task_id

    ok_auth, _ = authorize_main_task_execution(storage, task_id, "user")
    assert ok_auth
    row = find_main_task(storage, task_id)
    assert row is not None
    assert row[1].get("execution_authorized") is True

    again = bind_plan_to_thread_task(tid, goal="revised", steps=[_step("revised")], paths=paths)
    assert again.get("task_id") == task_id
    assert again.get("planRevised") is True
    assert again.get("authorizationRevoked") is True

    row2 = find_main_task(storage, task_id)
    assert row2 is not None
    assert not row2[1].get("execution_authorized")
    assert row2[1].get("plan_goal") == "revised"


def test_revoke_authorization_helper(plan_env) -> None:
    storage = plan_env["storage"]
    from evoflow.collab.storage import new_project_bundle_root_task

    project, task = new_project_bundle_root_task("t", "d" * 25, thread_id=plan_env["thread_id"])
    task["execution_authorized"] = True
    storage.save_project(project)
    tid = task["id"]
    ok, _ = revoke_main_task_execution_authorization(storage, tid)
    assert ok
    row = find_main_task(storage, tid)
    assert row is not None
    assert not row[1].get("execution_authorized")
