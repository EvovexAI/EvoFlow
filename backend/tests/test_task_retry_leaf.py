"""Leaf / employee work-item retry must not 400 when there are no failed subtasks."""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


@pytest.fixture()
def retry_client(monkeypatch: pytest.MonkeyPatch):
    from app.gateway.deps.license import require_premium
    from app.gateway.routers import tasks as tasks_router

    app = FastAPI()
    app.include_router(tasks_router.router)
    app.dependency_overrides[require_premium] = lambda: None

    monkeypatch.setattr(tasks_router, "require_task_visible", lambda *a, **k: None)
    storage = MagicMock()
    monkeypatch.setattr(tasks_router, "get_project_storage", lambda: storage)

    return TestClient(app), tasks_router, storage


def test_retry_leaf_failed_main_task_without_subtasks(retry_client, monkeypatch: pytest.MonkeyPatch):
    client, tasks_router, _storage = retry_client
    task = {
        "id": "2610190658_1c8a",
        "status": "failed",
        "subtasks": [],
        "assigned_to": "code-agent",
        "proactive_work_item": True,
        "error": "员工执行失败：timeout",
        "retry_attempts": 0,
    }
    project = {"id": "p1", "tasks": [task]}

    monkeypatch.setattr(tasks_router, "find_main_task", lambda *_a, **_k: (project, task))
    patch_calls: list[dict] = []

    def _patch(_storage, mid, updates):
        patch_calls.append({"id": mid, **updates})
        return True

    monkeypatch.setattr(
        "evoflow.collab.storage.patch_collab_main_task_in_project_storage",
        _patch,
    )
    kick = MagicMock()
    monkeypatch.setattr(tasks_router, "_kick_work_item_retry", kick)

    resp = client.post(
        "/api/tasks/2610190658_1c8a/retry",
        json={"retry_all_failed": True},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["success"] is True
    assert body["data"]["mode"] == "main_task"
    assert body["data"]["total_retried"] == 1
    assert patch_calls and patch_calls[0]["status"] == "pending"
    kick.assert_called_once()


def test_retry_failed_subtasks_still_works(retry_client, monkeypatch: pytest.MonkeyPatch):
    client, tasks_router, storage = retry_client
    sub_ok = {"id": "s1", "status": "completed", "name": "done"}
    sub_bad = {"id": "s2", "status": "failed", "name": "broke", "error": "boom"}
    task = {
        "id": "task_plan_1",
        "status": "failed",
        "subtasks": [sub_ok, sub_bad],
    }
    project = {"id": "p1", "tasks": [task]}
    storage.save_project.return_value = True

    monkeypatch.setattr(tasks_router, "find_main_task", lambda *_a, **_k: (project, task))
    kick = MagicMock()
    monkeypatch.setattr(tasks_router, "_kick_work_item_retry", kick)

    resp = client.post(
        "/api/tasks/task_plan_1/retry",
        json={"retry_all_failed": True},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["data"]["mode"] == "subtasks"
    assert body["data"]["retried_subtasks"] == ["s2"]
    assert sub_ok["status"] == "completed"
    assert sub_bad["status"] == "pending"
    assert task["status"] == "executing"
    kick.assert_not_called()


def test_retry_no_failed_anything_still_400(retry_client, monkeypatch: pytest.MonkeyPatch):
    client, tasks_router, _storage = retry_client
    task = {"id": "t1", "status": "completed", "subtasks": []}
    monkeypatch.setattr(
        tasks_router,
        "find_main_task",
        lambda *_a, **_k: ({"id": "p1", "tasks": [task]}, task),
    )
    resp = client.post("/api/tasks/t1/retry", json={"retry_all_failed": True})
    assert resp.status_code == 400


def test_failed_can_transition_to_pending_and_executing():
    from evoflow.tools.builtins.supervisor_tool import _can_transition_task_state

    assert _can_transition_task_state("failed", "pending")
    assert _can_transition_task_state("failed", "executing")
