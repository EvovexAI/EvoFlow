"""Automation fire → Task Center unattended enqueue."""

from __future__ import annotations

import gc
import tempfile

import pytest

from evoflow.collab.storage import get_project_storage
from evoflow.collab.task_source import TASK_SOURCE_WORKFLOW
from evoflow.persistence.db import reset_db_for_tests


@pytest.fixture
def sqlite_tmp(monkeypatch: pytest.MonkeyPatch):
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
        monkeypatch.setenv("EVOFLOW_HOME", tmp)
        reset_db_for_tests()
        # Reset singleton storage so it picks up the temp home.
        import evoflow.collab.storage as stor

        stor._storage_instance = None
        yield tmp
        reset_db_for_tests()
        stor._storage_instance = None
        gc.collect()


def test_prompt_automation_defaults_to_direct_langgraph() -> None:
    from app.gateway.automation_runner import _automation_via_task_center

    assert _automation_via_task_center() is False
    assert _automation_via_task_center({"name": "每日AI日报", "prompt": "x"}) is False


def test_prompt_automation_opt_in_task_center_via_env(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.gateway.automation_runner import _automation_via_task_center

    monkeypatch.setenv("EVOFLOW_AUTOMATION_VIA_TASK", "1")
    assert _automation_via_task_center() is True
    assert _automation_via_task_center({"prompt": "x"}) is True


def test_prompt_automation_opt_in_task_center_via_task_field() -> None:
    from app.gateway.automation_runner import _automation_via_task_center

    assert _automation_via_task_center({"execution_mode": "task_center"}) is True
    assert _automation_via_task_center({"execution_mode": "direct_langgraph"}) is False


def test_enqueue_automation_creates_unattended_task(sqlite_tmp: str, monkeypatch: pytest.MonkeyPatch) -> None:
    del sqlite_tmp
    from app.gateway.automation_runner import (
        _automation_via_task_center,
        _enqueue_automation_as_unattended_task,
    )

    monkeypatch.setenv("EVOFLOW_AUTOMATION_VIA_TASK", "1")
    assert _automation_via_task_center() is True

    result = _enqueue_automation_as_unattended_task(
        "auto-abc",
        {
            "name": "每日巡检",
            "prompt": "检查系统健康并汇报",
            "model_name": "test-model",
            "agent_code": "lead_agent",
            "feishu_push_enabled": True,
            "push_channel": "feishu",
            "push_target_id": "oc_test",
        },
        run_id="run123",
        trigger_type="manual",
        prompt="检查系统健康并汇报",
    )
    assert result["ok"] is True
    collab_id = result["collab_task_id"]
    assert collab_id

    storage = get_project_storage()
    project = storage.load_project(collab_id)
    assert project is not None
    task = (project.get("tasks") or [None])[0]
    assert isinstance(task, dict)
    assert task.get("run_mode") == "unattended"
    assert task.get("status") == "pending"
    assert task.get("unattended_stage") == "queued"
    assert task.get("source") == TASK_SOURCE_WORKFLOW
    assert task.get("source_channel") == "automation"
    assert task.get("automation_id") == "auto-abc"
    assert task.get("automation_run_id") == "run123"
    assert "检查系统健康并汇报" in str(task.get("description") or "")
    assert "交付文件" in str(task.get("description") or "")
    assert task.get("automation_output_path")
    assert str(task.get("automation_output_rel") or "").startswith("outputs/automations/auto-abc/")
    assert task.get("execution_authorized") is True
    assert task.get("authorized_by") == "automation"
    assert task.get("automation_feishu_push") is True
    assert task.get("session_model_name") == "test-model"


def test_enqueue_rejects_empty_prompt(sqlite_tmp: str) -> None:
    del sqlite_tmp
    from app.gateway.automation_runner import _enqueue_automation_as_unattended_task

    result = _enqueue_automation_as_unattended_task(
        "auto-x",
        {"name": "x"},
        run_id="r1",
        trigger_type="schedule",
        prompt="  ",
    )
    assert result["ok"] is False
    assert "empty" in str(result.get("error") or "")


def test_bound_app_helpers() -> None:
    from app.gateway.automation_runner import _bound_app_id, _coerce_app_parameters

    assert _bound_app_id({"app_id": " app1 "}) == "app1"
    assert _bound_app_id({"workflow_id": "wf2"}) == "wf2"
    assert _bound_app_id({}) == ""
    assert _coerce_app_parameters({"a": 1, "b": None, "": "x"}) == {"a": "1", "b": ""}


def test_run_bound_app_requires_published(sqlite_tmp: str, monkeypatch: pytest.MonkeyPatch) -> None:
    del sqlite_tmp
    from app.gateway import automation_runner as ar

    monkeypatch.setattr(
        "evoflow.persistence.app_repositories.load_app",
        lambda _aid: {"id": "a1", "name": "Demo", "status": "draft"},
    )
    result = ar._run_bound_app_for_automation(
        "auto1",
        {"app_id": "a1", "name": "cron"},
        run_id="r1",
        trigger_type="manual",
    )
    assert result["ok"] is False
    assert "published" in str(result.get("error") or "")
