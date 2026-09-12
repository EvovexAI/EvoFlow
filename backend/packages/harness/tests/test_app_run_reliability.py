"""App run reliability: workflow auto-authorize, AppRun status writeback."""

from __future__ import annotations

import tempfile
from pathlib import Path
from unittest.mock import patch

import pytest

from evoflow.persistence.db import get_db, reset_db_for_tests


@pytest.fixture
def sqlite_tmp(monkeypatch: pytest.MonkeyPatch):
    with tempfile.TemporaryDirectory() as tmp:
        monkeypatch.setenv("EVOFLOW_HOME", tmp)
        reset_db_for_tests()
        yield Path(tmp)
        reset_db_for_tests()
        import gc

        gc.collect()


def test_run_app_workflow_always_auto_authorizes(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    from evoflow.collab import app_runner
    from evoflow.persistence import app_repositories

    get_db()
    app_repositories.save_app(
        "App_wf1",
        {
            "name": "WF",
            "steps": [
                {
                    "ref": "1",
                    "goal": "g",
                    "tools": [],
                    "depends_on": [],
                    "assigned_agent": "researcher",
                }
            ],
            "parameters": [],
            "goal_template": "do it",
            "execution_mode": "workflow",
            "auto_run": False,
            "version": 1,
            "status": "published",
        },
    )

    with patch.object(app_runner, "run_app_workflow", return_value={"ok": True}) as mocked:
        app_runner.run_app("App_wf1", {})
        mocked.assert_called_once()
        assert mocked.call_args.kwargs.get("auto_authorize") is True or (
            len(mocked.call_args.args) >= 3 and mocked.call_args.args[2] is True
        )


def test_get_run_status_writes_back_task_completion(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    from evoflow.collab import app_runner
    from evoflow.persistence import app_repositories

    get_db()
    app_repositories.save_run(
        "Run_sync1",
        {
            "app_id": "App_x",
            "app_version": 1,
            "parameters": {},
            "execution_mode": "workflow",
            "task_id": "Task_x",
            "status": "executing",
            "progress": 10,
        },
    )

    fake_bundle = {
        "tasks": [
            {
                "id": "Task_x",
                "status": "completed",
                "progress": 100,
                "result_summary": "done",
                "subtasks": [{"ref": "1", "status": "completed"}],
            }
        ]
    }
    with patch(
        "evoflow.persistence.task_repositories.load_task_bundle",
        return_value=fake_bundle,
    ):
        status = app_runner.get_run_status("Run_sync1")

    assert status is not None
    assert status["status"] == "completed"
    assert status["progress"] == 100
    stored = app_repositories.load_run("Run_sync1")
    assert stored["status"] == "completed"
    assert int(stored.get("progress") or 0) == 100


def test_get_run_status_mirrors_semantic_ref_aliases(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    from evoflow.collab import app_runner
    from evoflow.persistence import app_repositories

    get_db()
    app_repositories.save_app(
        "App_sem",
        {
            "name": "Semantic",
            "steps": [
                {"ref": "brief", "name": "分镜", "goal": "g1", "depends_on": []},
                {"ref": "assemble", "name": "成片", "goal": "g2", "depends_on": ["brief"]},
            ],
            "parameters": [],
            "goal_template": "do it",
            "execution_mode": "workflow",
            "answer_from_ref": "assemble",
            "version": 1,
            "status": "published",
        },
    )
    app_repositories.save_run(
        "Run_sem",
        {
            "app_id": "App_sem",
            "app_version": 1,
            "parameters": {},
            "execution_mode": "workflow",
            "task_id": "Task_sem",
            "status": "executing",
            "progress": 50,
            "answer_from_ref": "assemble",
        },
    )

    fake_bundle = {
        "tasks": [
            {
                "id": "Task_sem",
                "status": "completed",
                "progress": 100,
                "subtasks": [
                    {
                        "id": "Subtask_brief",
                        "ref": "1",
                        "semantic_ref": "brief",
                        "name": "Step 1: 分镜",
                        "status": "completed",
                        "outputs": [],
                    },
                    {
                        "id": "Subtask_assemble",
                        "ref": "2",
                        "semantic_ref": "assemble",
                        "name": "Step 2: 成片",
                        "status": "completed",
                        "outputs": [
                            {"type": "file", "key": "final", "value": "outputs/final.mp4"}
                        ],
                    },
                ],
            }
        ]
    }
    with patch(
        "evoflow.persistence.task_repositories.load_task_bundle",
        return_value=fake_bundle,
    ):
        status = app_runner.get_run_status("Run_sem")

    assert status is not None
    assert status["subtask_status"]["assemble"] == "completed"
    assert status["step_ref_to_subtask_id"]["assemble"] == "Subtask_assemble"
    assert status["outputs"]
    assert "final.mp4" in str(status["outputs"][0].get("value") or "")
    assert status["steps"][1]["display_name"] == "成片"


def test_lead_creates_thread_when_missing(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    from evoflow.collab import app_runner
    from evoflow.persistence import app_repositories

    get_db()
    app_repositories.save_app(
        "App_lead1",
        {
            "name": "Lead",
            "steps": [
                {
                    "ref": "1",
                    "goal": "g",
                    "tools": [],
                    "depends_on": [],
                    "assigned_agent": "researcher",
                }
            ],
            "parameters": [],
            "goal_template": "lead it",
            "execution_mode": "lead_supervised",
            "version": 1,
            "status": "published",
        },
    )

    with (
        patch.object(app_runner, "_create_lead_thread", return_value="thread-abc") as create_tid,
        patch.object(app_runner, "run_app_lead_supervised", return_value={"run_id": "r"}) as lead,
    ):
        app_runner.run_app("App_lead1", {})
        create_tid.assert_called_once()
        lead.assert_called_once_with("App_lead1", {}, "thread-abc")
