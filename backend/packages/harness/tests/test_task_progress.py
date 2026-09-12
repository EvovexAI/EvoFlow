"""Tests for collaboration task progress helpers and worker tool."""

from __future__ import annotations

import pytest

from evoflow.collab.storage import get_project_storage, new_project_bundle_root_task
from evoflow.collab.task_progress import (
    aggregate_subtasks_progress_percent,
    apply_subtask_progress_report,
    clamp_task_progress,
    infer_main_status_from_subtasks,
    subtask_row_progress_percent,
    sync_main_task_from_subtasks,
)
from evoflow.collab.work_checklist import checklist_progress_percent, normalize_checklist_items


@pytest.fixture
def task_with_subtask(tmp_path, monkeypatch):
    monkeypatch.setenv("EVOFLOW_DATA_DIR", str(tmp_path))
    storage = get_project_storage()
    project, task = new_project_bundle_root_task("main", "x" * 30, thread_id="t_prog")
    task_id = str(task["id"])
    subtask_id = "Subtask_prog_01"
    task["subtasks"] = [{"id": subtask_id, "name": "step", "status": "pending", "progress": 0, "assigned_to": "general-purpose"}]
    task["progress"] = 0
    storage.save_project(project)
    return storage, task_id, subtask_id


def test_clamp_task_progress():
    assert clamp_task_progress(-5) == 0
    assert clamp_task_progress(150) == 100
    assert clamp_task_progress("42") == 42
    assert clamp_task_progress(None) == 0


def test_cap_auto_sync_main_progress():
    from evoflow.collab.task_progress import cap_auto_sync_main_progress

    assert cap_auto_sync_main_progress(100, main_status="executing") == 99
    assert cap_auto_sync_main_progress(70, main_status="executing") == 70
    assert cap_auto_sync_main_progress(100, main_status="completed") == 100


def test_checklist_progress_weights_in_progress():
    items = normalize_checklist_items(
        [
            {"content": "a", "status": "completed"},
            {"content": "b", "status": "in_progress"},
        ]
    )
    assert checklist_progress_percent(items) == 75


def test_subtask_row_and_aggregate_progress():
    subs = [
        {"status": "completed", "progress": 100},
        {"status": "in_progress", "progress": 40},
        {"status": "pending", "progress": 0},
    ]
    assert subtask_row_progress_percent(subs[0]) == 100
    assert subtask_row_progress_percent(subs[1]) == 40
    assert subtask_row_progress_percent(subs[2]) == 0
    assert aggregate_subtasks_progress_percent(subs) == 47


@pytest.mark.asyncio
async def test_apply_subtask_progress_report(task_with_subtask):
    storage, task_id, subtask_id = task_with_subtask
    res = await apply_subtask_progress_report(
        main_task_id=task_id,
        subtask_id=subtask_id,
        progress=35,
        current_step="Running tests",
        storage=storage,
    )
    assert res["ok"] is True
    assert res["progress"] == 35
    assert res["status"] == "in_progress"

    st = storage.load_project(task_id)
    assert st is not None
    row = next(x for x in st["tasks"][0]["subtasks"] if x["id"] == subtask_id)
    assert row["progress"] == 35
    assert row["status"] == "in_progress"


@pytest.mark.asyncio
async def test_apply_subtask_progress_report_terminal_blocked(task_with_subtask):
    storage, task_id, subtask_id = task_with_subtask
    project = storage.load_project(task_id)
    project["tasks"][0]["subtasks"][0]["status"] = "completed"
    project["tasks"][0]["subtasks"][0]["progress"] = 100
    storage.save_project(project)

    res = await apply_subtask_progress_report(
        main_task_id=task_id,
        subtask_id=subtask_id,
        progress=50,
        storage=storage,
    )
    assert res["ok"] is False


def test_subtask_progress_tool_json_shape():
    from evoflow.tools.builtins.subtask_progress_tool import subtask_progress_report_tool

    assert subtask_progress_report_tool.name == "subtask_progress_report"
    schema = subtask_progress_report_tool.args_schema.model_json_schema() if subtask_progress_report_tool.args_schema else {}
    props = schema.get("properties") or {}
    assert "progress" in props


def test_infer_main_status_from_subtasks():
    assert infer_main_status_from_subtasks([{"status": "completed"}, {"status": "completed"}]) is None
    assert infer_main_status_from_subtasks([{"status": "completed"}, {"status": "in_progress", "progress": 20}]) == "executing"
    assert infer_main_status_from_subtasks([{"status": "failed"}, {"status": "completed"}]) == "failed"
    assert infer_main_status_from_subtasks([{"status": "pending"}, {"status": "pending"}]) is None


def test_sync_main_task_from_subtasks(task_with_subtask):
    storage, task_id, _subtask_id = task_with_subtask
    project = storage.load_project(task_id)
    project["tasks"][0]["status"] = "executing"
    project["tasks"][0]["progress"] = 10
    project["tasks"][0]["subtasks"][0]["status"] = "completed"
    project["tasks"][0]["subtasks"][0]["progress"] = 100
    storage.save_project(project)

    result = sync_main_task_from_subtasks(storage, task_id)
    assert result["ok"] is True
    assert result["changed"] is True
    assert result["status"] == "executing"
    assert result["progress"] == 99

    found = storage.load_project(task_id)
    assert found is not None
    row = found["tasks"][0]
    assert row["status"] == "executing"
    assert row["progress"] == 99


def test_update_progress_promotes_pending_to_executing(task_with_subtask):
    from evoflow.admin.tasks import update_progress

    _storage, task_id, _sid = task_with_subtask
    out = update_progress(task_id, 70)
    assert out["progress"] == 70
    assert out["status"] == "executing"
    assert out["status_zh"] == "处理中"
