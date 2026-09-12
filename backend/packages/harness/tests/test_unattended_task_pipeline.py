"""Gateway unattended task pipeline and task status normalization tests."""

from __future__ import annotations

import asyncio
import gc
import tempfile
from typing import Any
from unittest.mock import AsyncMock

import pytest

from app.gateway.routers.tasks import _normalized_task_status, _public_task_dict, _status_matches_filter
from app.gateway.unattended_task_pipeline import (
    _finalize_executing_task,
    advance_unattended_task,
    count_active_unattended_tasks,
    is_unattended_task,
    list_unattended_in_progress,
)
from evoflow.collab.storage import ProjectStorage, get_project_storage, new_project_bundle_root_task
from evoflow.persistence.db import reset_db_for_tests


@pytest.fixture
def sqlite_tmp(monkeypatch: pytest.MonkeyPatch):
    # ignore_cleanup_errors: Windows WAL mode keeps evoflow.db/-shm briefly locked
    # after reset_db_for_tests(); a PermissionError during rmtree is a teardown
    # noise only (assertions already ran). Prevents a spurious WinError 32 exit 1.
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
        monkeypatch.setenv("EVOFLOW_HOME", tmp)
        reset_db_for_tests()
        yield tmp
        reset_db_for_tests()
        gc.collect()


def _save_unattended_task(
    storage: ProjectStorage,
    *,
    status: str = "pending",
    plan: bool = False,
    subtasks: list[dict[str, Any]] | None = None,
    run_mode: str = "unattended",
    **extra: Any,
) -> str:
    project, task = new_project_bundle_root_task("Test task", "desc")
    task_id = str(task["id"])
    project["id"] = task_id
    task["run_mode"] = run_mode
    task["status"] = status
    if plan:
        task["plan_goal"] = "Do the thing"
        task["plan_steps"] = [{"id": "s1", "title": "Step 1"}]
        task["plan_bound_at"] = "2026-06-12T00:00:00Z"
    if subtasks is not None:
        task["subtasks"] = subtasks
    task.update(extra)
    project["tasks"] = [task]
    assert storage.save_project(project)
    return task_id


def test_list_in_progress_includes_planning_with_bound_plan(sqlite_tmp: str) -> None:
    del sqlite_tmp
    storage = get_project_storage()
    task_id = _save_unattended_task(storage, status="planning", plan=True)
    rows = list_unattended_in_progress()
    assert any(r.get("id") == task_id for r in rows)


def test_list_in_progress_includes_planned_with_pending_subtasks(sqlite_tmp: str) -> None:
    """Workflow / bound-plan tasks must stay in the queue until subtasks are actually dispatched."""
    del sqlite_tmp
    storage = get_project_storage()
    subs = [{"id": "Sub_1", "name": "Step", "status": "pending", "assigned_to": "general-purpose"}]
    task_id = _save_unattended_task(
        storage,
        status="planned",
        plan=True,
        subtasks=subs,
        execution_authorized=True,
    )
    rows = list_unattended_in_progress()
    assert any(r.get("id") == task_id for r in rows)


def test_list_in_progress_excludes_planned_when_subtasks_in_flight(sqlite_tmp: str) -> None:
    del sqlite_tmp
    storage = get_project_storage()
    subs = [{"id": "Sub_1", "name": "Step", "status": "executing", "assigned_to": "general-purpose"}]
    task_id = _save_unattended_task(
        storage,
        status="planned",
        plan=True,
        subtasks=subs,
        execution_authorized=True,
    )
    rows = list_unattended_in_progress()
    assert not any(r.get("id") == task_id for r in rows)


def test_list_in_progress_excludes_executing_when_subtasks_all_terminal(sqlite_tmp: str) -> None:
    del sqlite_tmp
    storage = get_project_storage()
    subs = [
        {"id": "Sub_1", "status": "completed"},
        {"id": "Sub_2", "status": "done"},
    ]
    task_id = _save_unattended_task(storage, status="executing", plan=True, subtasks=subs)
    rows = list_unattended_in_progress()
    assert not any(r.get("id") == task_id for r in rows)


def test_finalize_executing_marks_completed_when_all_subtasks_success(sqlite_tmp: str) -> None:
    del sqlite_tmp
    storage = get_project_storage()
    subs = [{"id": "Sub_1", "status": "completed"}, {"id": "Sub_2", "status": "success"}]
    task_id = _save_unattended_task(storage, status="executing", plan=True, subtasks=subs)
    result = _finalize_executing_task(task_id)
    assert result is not None
    assert result.get("action") == "completed"
    loaded = storage.load_project(task_id)
    assert loaded is not None
    task = loaded["tasks"][0]
    assert task["status"] == "completed"
    assert task.get("progress") == 100


def test_count_active_includes_fresh_planning_excludes_paused(sqlite_tmp: str) -> None:
    del sqlite_tmp
    from evoflow.timeutil import utc_now_iso_z

    storage = get_project_storage()
    _save_unattended_task(
        storage,
        status="planning",
        unattended_plan_triggered_at=utc_now_iso_z(),
    )
    _save_unattended_task(storage, status="paused")
    assert count_active_unattended_tasks() == 1


def test_count_active_excludes_stale_planning_without_worker(sqlite_tmp: str) -> None:
    del sqlite_tmp
    storage = get_project_storage()
    _save_unattended_task(
        storage,
        status="planning",
        unattended_plan_triggered_at="2026-08-23T10:00:00+08:00",
    )
    assert count_active_unattended_tasks() == 0


def test_count_active_excludes_planned_waiting_for_dispatch(sqlite_tmp: str) -> None:
    del sqlite_tmp
    storage = get_project_storage()
    _save_unattended_task(storage, status="planned", plan=True)
    assert count_active_unattended_tasks() == 0


def test_count_active_includes_executing_with_in_flight_subtasks(sqlite_tmp: str) -> None:
    del sqlite_tmp
    storage = get_project_storage()
    subs = [{"id": "Sub_1", "status": "executing", "assigned_to": "general-purpose"}]
    _save_unattended_task(storage, status="executing", plan=True, subtasks=subs)
    assert count_active_unattended_tasks() == 1


def test_advance_promotes_planning_when_plan_bound(sqlite_tmp: str, monkeypatch: pytest.MonkeyPatch) -> None:
    _ = sqlite_tmp

    async def _run() -> None:
        storage = get_project_storage()
        task_id = _save_unattended_task(
            storage,
            status="planning",
            plan=True,
            subtasks=[{"id": "Sub_1", "name": "Step", "status": "pending"}],
            thread_id="00000000-0000-4000-8000-000000000099",
        )

        async def _fake_thread(tid: str, task: dict[str, Any]) -> str:
            return str(task.get("thread_id") or "00000000-0000-4000-8000-000000000099")

        monkeypatch.setattr(
            "app.gateway.unattended_task_pipeline._ensure_langgraph_thread",
            _fake_thread,
        )
        monkeypatch.setattr(
            "app.gateway.unattended_task_pipeline._prepare_unattended_plan_context",
            lambda *a, **k: None,
        )
        monkeypatch.setattr(
            "evoflow.collab.plan_subtasks_sync.ensure_subtasks_synced_before_start_execution",
            lambda *a, **k: None,
        )
        monkeypatch.setattr(
            "evoflow.collab.authorize_execution.authorize_main_task_execution",
            lambda storage, tid, by: (True, "ok"),
        )
        monkeypatch.setattr(
            "evoflow.collab.user_execution_confirm.mark_user_execution_confirmed",
            lambda *a, **k: None,
        )
        monkeypatch.setattr(
            "app.gateway.unattended_task_pipeline.advance_collab_phase_to_awaiting_exec_for_task",
            lambda *a, **k: None,
        )
        monkeypatch.setattr(
            "app.gateway.unattended_task_pipeline.dispatch_authorized_main_task_execution",
            AsyncMock(return_value={"success": True, "delegatedSubtasks": [{"ok": True}]}),
        )
        monkeypatch.setattr(
            "app.gateway.unattended_task_pipeline.advance_collab_phase_to_executing_for_task",
            lambda *a, **k: None,
        )

        result = await advance_unattended_task(task_id)
        assert result.get("ok") is True
        assert result.get("action") == "dispatched"
        loaded = storage.load_project(task_id)
        assert loaded is not None
        assert loaded["tasks"][0]["status"] == "executing"

    asyncio.run(_run())


def test_advance_executing_with_terminal_subtasks_does_not_redispatch(
    sqlite_tmp: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    _ = sqlite_tmp

    async def _run() -> None:
        storage = get_project_storage()
        subs = [{"id": "Sub_1", "status": "completed"}]
        task_id = _save_unattended_task(storage, status="executing", plan=True, subtasks=subs)
        dispatch_mock = AsyncMock(return_value={"success": True})
        monkeypatch.setattr(
            "app.gateway.unattended_task_pipeline.dispatch_authorized_main_task_execution",
            dispatch_mock,
        )

        result = await advance_unattended_task(task_id)
        assert result.get("action") == "completed"
        dispatch_mock.assert_not_called()
        loaded = storage.load_project(task_id)
        assert loaded["tasks"][0]["status"] == "completed"

    asyncio.run(_run())


def test_advance_workflow_bound_skips_langgraph_thread(sqlite_tmp: str, monkeypatch: pytest.MonkeyPatch) -> None:
    """Published-app workflow tasks must dispatch without creating a Lead thread."""
    _ = sqlite_tmp

    async def _run() -> None:
        storage = get_project_storage()
        project, task = new_project_bundle_root_task("WF", "desc")
        task_id = str(task["id"])
        project["id"] = task_id
        task["run_mode"] = "unattended"
        task["status"] = "planned"
        task["execution_authorized"] = True
        task["source_app_id"] = "demo_app"
        task["app_definition_snapshot"] = {"app_id": "demo_app", "steps": []}
        task["plan_goal"] = "Goal"
        task["plan_steps"] = [{"ref": "1", "name": "Step 1"}]
        task["plan_bound_at"] = "2026-06-12T00:00:00Z"
        task["subtasks"] = [
            {
                "id": "Sub_1",
                "name": "Step 1",
                "status": "planned",
                "assigned_to": "general-purpose",
            }
        ]
        project["tasks"] = [task]
        assert storage.save_project(project)

        async def _fake_dispatch(tid: str, *, authorized_by: str = "api") -> dict:
            return {"success": True, "delegatedSubtasks": [{"ok": True, "subtaskId": "Sub_1"}]}

        monkeypatch.setattr(
            "evoflow.collab.app_runner.dispatch_workflow_task_now",
            _fake_dispatch,
        )
        monkeypatch.setattr(
            "app.gateway.unattended_task_pipeline._ensure_langgraph_thread",
            AsyncMock(side_effect=AssertionError("workflow must not create lead thread")),
        )

        result = await advance_unattended_task(task_id)
        assert result.get("ok") is True
        assert result.get("action") == "dispatched"

    asyncio.run(_run())


def test_public_task_dict_normalizes_planning_with_plan_to_planned() -> None:
    task = {
        "id": "t1",
        "status": "planning",
        "plan_bound_at": "2026-06-12T00:00:00Z",
        "plan_goal": "Goal",
        "plan_steps": [{"id": "s1"}],
    }
    pub = _public_task_dict(task)
    assert pub["status"] == "planned"
    assert _normalized_task_status(task) == "planned"


def test_status_matches_filter_executing_aliases() -> None:
    for alias in ("running", "in_progress", "waiting_dispatch"):
        task = {"status": alias}
        assert _status_matches_filter(task, "executing") is True
    planned = {"status": "planning", "plan_bound_at": "x", "plan_goal": "g", "plan_steps": [1]}
    assert _status_matches_filter(planned, "planning") is True


def test_list_in_progress_excludes_paused(sqlite_tmp: str) -> None:
    del sqlite_tmp
    storage = get_project_storage()
    task_id = _save_unattended_task(storage, status="paused", plan=True)
    rows = list_unattended_in_progress()
    assert not any(r.get("id") == task_id for r in rows)


def test_is_unattended_requires_explicit_run_mode(sqlite_tmp: str) -> None:
    del sqlite_tmp
    storage = get_project_storage()
    implicit_id = _save_unattended_task(storage, status="planned", plan=True, run_mode="")
    explicit_id = _save_unattended_task(storage, status="planned", plan=True, run_mode="unattended")
    loaded_implicit = storage.load_project(implicit_id)
    loaded_explicit = storage.load_project(explicit_id)
    assert loaded_implicit is not None and loaded_explicit is not None
    assert is_unattended_task(loaded_implicit["tasks"][0]) is False
    assert is_unattended_task(loaded_explicit["tasks"][0]) is True
    # planned rows waiting for dispatch do not consume concurrency slots
    assert count_active_unattended_tasks() == 0


def test_plan_session_placeholder_never_unattended(sqlite_tmp: str) -> None:
    del sqlite_tmp
    storage = get_project_storage()
    project, task = new_project_bundle_root_task("Chat plan", "desc", thread_id="00000000-0000-4000-8000-000001")
    task_id = str(task["id"])
    project["id"] = task_id
    task["run_mode"] = "unattended"
    task["plan_session_placeholder"] = True
    task["status"] = "planned"
    task["plan_goal"] = "Goal"
    task["plan_steps"] = [{"id": "s1"}]
    task["plan_bound_at"] = "2026-06-12T00:00:00Z"
    project["tasks"] = [task]
    assert storage.save_project(project)
    assert is_unattended_task(task) is False
    assert count_active_unattended_tasks() == 0


def test_inbox_never_unattended_even_with_run_mode():
    assert is_unattended_task({"status": "inbox", "run_mode": "unattended"}) is False
    assert is_unattended_task({"status": "pending", "run_mode": "unattended"}) is True
