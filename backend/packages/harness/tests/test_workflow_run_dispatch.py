"""Workflow run must dispatch from every sync entry (platform tool, run_app)."""

from __future__ import annotations

import tempfile
from unittest.mock import AsyncMock, patch

import pytest

from evoflow.persistence.db import get_db, reset_db_for_tests


@pytest.fixture
def sqlite_tmp(monkeypatch: pytest.MonkeyPatch):
    with tempfile.TemporaryDirectory() as tmp:
        monkeypatch.setenv("EVOFLOW_HOME", tmp)
        reset_db_for_tests()
        yield tmp
        reset_db_for_tests()


def _save_published_workflow_app(app_id: str = "wf_dispatch_demo") -> None:
    from evoflow.persistence import app_repositories

    get_db()
    app_repositories.save_app(
        app_id,
        {
            "name": "Dispatch Demo",
            "steps": [
                {
                    "ref": "1",
                    "goal": "step one",
                    "tools": [],
                    "depends_on": [],
                    "assigned_agent": "general-purpose",
                }
            ],
            "parameters": [],
            "goal_template": "do {{topic}}",
            "execution_mode": "workflow",
            "auto_run": False,
            "version": 1,
            "status": "published",
        },
    )


def test_run_app_applies_workflow_dispatch_sync(sqlite_tmp: str) -> None:
    del sqlite_tmp
    from evoflow.collab import app_runner

    _save_published_workflow_app()
    fake_dispatch = {"success": True, "action": "start_execution", "taskId": "t1"}

    with patch.object(app_runner, "run_app_workflow", return_value={
        "run_id": "Run_x",
        "task_id": "Task_x",
        "execution_mode": "workflow",
        "status": "planned",
    }) as mocked_wf:
        with patch.object(
            app_runner,
            "dispatch_workflow_task_sync",
            return_value=fake_dispatch,
        ) as mocked_dispatch:
            out = app_runner.run_app("wf_dispatch_demo", {})

    mocked_wf.assert_called_once()
    mocked_dispatch.assert_called_once_with("Task_x", authorized_by="api")
    assert out["dispatch"] == fake_dispatch
    assert out["status"] == "executing"


def test_platform_workflow_run_includes_dispatch(sqlite_tmp: str) -> None:
    del sqlite_tmp
    from evoflow.admin import platform_handlers as ph
    from evoflow.collab import app_runner

    _save_published_workflow_app("content_ops_short_video_demo")
    fake_dispatch = {"success": True, "action": "start_execution"}

    with patch.object(
        app_runner,
        "run_app_workflow",
        return_value={
            "run_id": "Run_plat",
            "task_id": "2608240904_0c37",
            "execution_mode": "workflow",
            "status": "planned",
        },
    ):
        with patch.object(
            app_runner,
            "dispatch_workflow_task_sync",
            return_value=fake_dispatch,
        ):
            out = ph.workflow_run({"appId": "content_ops_short_video_demo", "parameters": {}})

    assert out.get("ok") is True
    run = out.get("run") if isinstance(out.get("run"), dict) else {}
    assert run.get("status") == "executing"
    assert run.get("dispatch") == fake_dispatch


def test_apply_workflow_dispatch_falls_back_to_detached_poll(sqlite_tmp: str) -> None:
    del sqlite_tmp
    from evoflow.collab import app_runner

    with patch.object(
        app_runner,
        "dispatch_workflow_task_sync",
        return_value={"success": False, "error": "boom"},
    ):
        with patch.object(app_runner, "_schedule_workflow_dispatch") as mocked_schedule:
            out = app_runner.apply_workflow_dispatch(
                {
                    "run_id": "Run_y",
                    "task_id": "Task_y",
                    "execution_mode": "workflow",
                    "status": "planned",
                }
            )

    mocked_schedule.assert_called_once_with("Task_y", "Run_y")
    assert out["dispatch"]["success"] is False
    assert out["status"] == "planned"
