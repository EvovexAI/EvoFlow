"""Tests for subtask work checklist."""

from __future__ import annotations

import pytest

from evoflow.collab.storage import get_project_storage, new_project_bundle_root_task
from evoflow.collab.work_checklist import (
    checklist_is_ready,
    checklist_progress_percent,
    format_checklist_markdown_table,
    normalize_checklist_items,
    resolve_checklist_item,
    set_subtask_work_checklist,
    update_subtask_checklist_item,
)


@pytest.fixture
def task_with_subtask(tmp_path, monkeypatch):
    monkeypatch.setenv("EVOFLOW_DATA_DIR", str(tmp_path))
    storage = get_project_storage()
    project, task = new_project_bundle_root_task("main", "x" * 30, thread_id="t_wc")
    task_id = str(task["id"])
    subtask_id = "Subtask_wc_01"
    task["subtasks"] = [{"id": subtask_id, "name": "step", "status": "pending", "assigned_to": "general-purpose"}]
    storage.save_project(project)
    return storage, task_id, subtask_id


def test_normalize_and_table():
    items = normalize_checklist_items(
        [
            {"content": "读 Plan", "status": "pending"},
            "写测试",
        ]
    )
    assert len(items) == 2
    assert items[0]["id"] == "1"
    assert items[1]["id"] == "2"
    md = format_checklist_markdown_table(items)
    assert "| 状态 | 事项 | 结果 |" in md
    assert "读 Plan" in md


def test_normalize_json_string_items():
    """Models often pass items as a JSON array string instead of a native list."""
    raw = '[{"content": "读 Plan", "status": "completed"}, {"content": "写测试", "status": "pending"}]'
    items = normalize_checklist_items(raw)
    assert len(items) == 2
    assert items[0]["content"] == "读 Plan"
    assert items[0]["status"] == "completed"
    assert items[1]["content"] == "写测试"


def test_resolve_checklist_item_by_row_number_and_legacy_id():
    items = [
        {"id": "wc_1_deadbeef", "content": "a", "status": "pending"},
        {"id": "wc_2_cafebabe", "content": "b", "status": "pending"},
    ]
    assert resolve_checklist_item(items, "2") is items[1]
    assert resolve_checklist_item(items, "wc_2_cafebabe") is items[1]
    assert resolve_checklist_item(items, "wc_2") is items[1]


def test_set_and_update_checklist(task_with_subtask):
    storage, task_id, subtask_id = task_with_subtask
    ok, _, rows = set_subtask_work_checklist(
        storage,
        task_id,
        subtask_id,
        [{"content": "实现 API"}, {"content": "跑 pytest"}],
    )
    assert ok is True
    assert checklist_is_ready(rows)
    item_id = rows[0]["id"]
    ok2, _, rows2 = update_subtask_checklist_item(
        storage,
        task_id,
        subtask_id,
        item_id,
        status="completed",
        result="pytest 12 passed",
    )
    assert ok2 is True
    assert checklist_progress_percent(rows2) == 50


def test_update_checklist_by_table_row_number(task_with_subtask):
    storage, task_id, subtask_id = task_with_subtask
    ok, _, rows = set_subtask_work_checklist(
        storage,
        task_id,
        subtask_id,
        [{"content": "读 task1.txt"}, {"content": "拼接写入 task3.txt"}],
    )
    assert ok is True
    ok2, _, rows2 = update_subtask_checklist_item(
        storage,
        task_id,
        subtask_id,
        "2",
        status="in_progress",
        result="拼接内容为「任务1执行完毕 + 任务3执行」",
    )
    assert ok2 is True
    assert rows2[1]["status"] == "in_progress"
    assert "任务3执行" in rows2[1]["result"]
