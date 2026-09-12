"""Tests for structured ``tasks`` tool (duty Task board; no shell JSON)."""

from __future__ import annotations

import json
from unittest.mock import patch

from evoflow.tools.builtins.tasks_tool import TaskHandlerItem, TaskOutputItem, tasks_tool


def _invoke(**kwargs):
    """Call the langchain tool (supports .invoke or raw callable)."""
    if hasattr(tasks_tool, "invoke"):
        return tasks_tool.invoke(kwargs)
    return tasks_tool.func(**kwargs)  # type: ignore[attr-defined]


def test_tasks_state_passes_structured_handlers_list():
    handlers = [
        TaskHandlerItem(
            agent_code="frontend-dev",
            content="修闪烁",
            read_outputs=[
                TaskOutputItem(type="file", key="report", value="docs/a.md", label="报告"),
            ],
            role="前端",
        ),
        {
            "agent_code": "backend-dev",
            "content": "查超时",
            "outputs": [{"type": "file", "key": "log", "value": "logs/t.log"}],
        },
    ]
    outputs = [TaskOutputItem(type="file", key="report", value="docs/a.md")]

    with patch("evoflow.admin.tasks.set_task_state") as mock_state:
        mock_state.return_value = {
            "task_id": "Task_1",
            "status": "completed",
            "handlers": [{"agent_code": "frontend-dev"}],
        }
        raw = _invoke(
            action="state",
            task_id="Task_1",
            status="completed",
            summary="做了 UI 修复",
            outputs=outputs,
            handlers=handlers,
        )

    payload = json.loads(raw)
    assert payload["ok"] is True
    assert payload["action"] == "state"
    mock_state.assert_called_once()
    args, kwargs = mock_state.call_args
    assert args[0] == "Task_1"
    assert args[1] == "completed"
    assert kwargs["summary"] == "做了 UI 修复"
    assert isinstance(kwargs["outputs"], list)
    assert kwargs["outputs"][0]["value"] == "docs/a.md"
    assert isinstance(kwargs["handlers"], list)
    assert kwargs["handlers"][0]["agent_code"] == "frontend-dev"
    assert kwargs["handlers"][0]["content"] == "修闪烁"
    assert kwargs["handlers"][0]["read_outputs"][0]["value"] == "docs/a.md"
    assert "outputs" not in kwargs["handlers"][0]
    assert kwargs["handlers"][1]["agent_code"] == "backend-dev"
    assert kwargs["handlers"][1]["read_outputs"][0]["value"] == "logs/t.log"


def test_tasks_state_accepts_outputs_json_string():
    """Models often stringify outputs; coerce so结案 is not blocked by schema."""
    outputs_json = json.dumps(
        [{"type": "file", "key": "report", "value": "docs/roles/a.md"}],
        ensure_ascii=False,
    )
    with patch("evoflow.admin.tasks.set_task_state") as mock_state:
        mock_state.return_value = {"task_id": "Task_1", "status": "completed"}
        raw = _invoke(
            action="state",
            task_id="Task_1",
            status="completed",
            summary="拆解完成",
            outputs=outputs_json,
        )
    payload = json.loads(raw)
    assert payload["ok"] is True
    mock_state.assert_called_once()
    _, kwargs = mock_state.call_args
    assert isinstance(kwargs["outputs"], list)
    assert kwargs["outputs"][0]["value"] == "docs/roles/a.md"


def test_tasks_state_accepts_handlers_json_string():
    handlers_json = json.dumps(
        [
            {
                "agent_code": "code-agent",
                "content": "改 UI",
                "read_outputs": [{"type": "file", "key": "r", "value": "docs/a.md"}],
            }
        ],
        ensure_ascii=False,
    )
    with patch("evoflow.admin.tasks.set_task_state") as mock_state:
        mock_state.return_value = {"task_id": "Task_1", "status": "completed"}
        raw = _invoke(
            action="state",
            task_id="Task_1",
            status="completed",
            summary="交工",
            handlers=handlers_json,
        )
    assert json.loads(raw)["ok"] is True
    _, kwargs = mock_state.call_args
    assert kwargs["handlers"][0]["agent_code"] == "code-agent"
    assert kwargs["handlers"][0]["read_outputs"][0]["value"] == "docs/a.md"


def test_tasks_state_requires_task_id_and_status():
    raw = _invoke(action="state", status="completed")
    assert json.loads(raw)["ok"] is False
    raw2 = _invoke(action="state", task_id="Task_1")
    assert json.loads(raw2)["ok"] is False


def test_tasks_delete_requires_confirm():
    with patch("evoflow.admin.tasks.delete_task") as mock_del:
        raw = _invoke(action="delete", task_id="Task_1", confirm=False)
        assert json.loads(raw)["ok"] is False
        mock_del.assert_not_called()

        mock_del.return_value = {"task_id": "Task_1", "deleted": True}
        raw2 = _invoke(action="delete", task_id="Task_1", confirm=True)
        assert json.loads(raw2)["ok"] is True
        mock_del.assert_called_once_with("Task_1")


def test_tasks_progress_calls_admin():
    with patch("evoflow.admin.tasks.update_progress") as mock_prog:
        mock_prog.return_value = {"task_id": "Task_1", "progress": 80}
        raw = _invoke(action="progress", task_id="Task_1", progress=80)
    assert json.loads(raw)["ok"] is True
    mock_prog.assert_called_once()
    args, kwargs = mock_prog.call_args
    assert args[0] == "Task_1"
    assert args[1] == 80


def test_tasks_list_defaults_to_limited_page():
    """Tool list must not dump the whole board; default limit=20 with pagination meta."""
    with patch("evoflow.admin.tasks.list_tasks") as mock_list:
        mock_list.return_value = {
            "count": 2,
            "total": 40,
            "limit": 20,
            "offset": 0,
            "has_more": True,
            "tasks": [{"task_id": "Task_1"}, {"task_id": "Task_2"}],
        }
        raw = _invoke(action="list", role="前端")
    payload = json.loads(raw)
    assert payload["ok"] is True
    assert payload["result"]["has_more"] is True
    assert payload["result"]["total"] == 40
    mock_list.assert_called_once()
    _, kwargs = mock_list.call_args
    assert kwargs["role"] == "前端"
    assert kwargs["limit"] == 20
    assert kwargs["offset"] == 0


def test_tasks_list_respects_limit_offset_and_caps_at_100():
    with patch("evoflow.admin.tasks.list_tasks") as mock_list:
        mock_list.return_value = {
            "count": 0,
            "total": 0,
            "limit": 100,
            "offset": 20,
            "has_more": False,
            "tasks": [],
        }
        _invoke(action="list", limit=500, offset=20)
    _, kwargs = mock_list.call_args
    assert kwargs["limit"] == 100
    assert kwargs["offset"] == 20


def test_tasks_create_stamps_duty_patrol_defaults():
    with (
        patch("evoflow.tools.builtins.tasks_tool._agent_from_duty_context", return_value="code-agent"),
        patch("evoflow.tools.builtins.tasks_tool._resolve_employee_by_code", return_value=("代码助手", "code-agent")),
        patch("evoflow.tools.builtins.tasks_tool._session_key_from_context", return_value=""),
        patch("evoflow.admin.tasks.create_task") as mock_create,
    ):
        mock_create.return_value = {"task_id": "Task_patrol", "source": "role"}
        raw = _invoke(
            action="create",
            name="【巡检】代码助手 2026-08-28 值班",
            description="本轮巡检",
        )
    assert json.loads(raw)["ok"] is True
    mock_create.assert_called_once()
    _, kwargs = mock_create.call_args
    assert kwargs["assignee"] == "code-agent"
    assert kwargs["assigned_role"] == "代码助手"
    assert kwargs["source"] == "proactive_patrol"
    assert kwargs["raised_by"] == "code-agent"


def test_tasks_create_stamps_session_key_as_source_ref():
    """One conversation may own many tasks; create stamps session_key into source_ref."""
    sk = "proactive:ops-bot:chat:round-1"
    with (
        patch("evoflow.tools.builtins.tasks_tool._agent_from_duty_context", return_value="ops-bot"),
        patch("evoflow.tools.builtins.tasks_tool._resolve_employee_by_code", return_value=("运维", "ops-bot")),
        patch("evoflow.tools.builtins.tasks_tool._session_key_from_context", return_value=sk),
        patch("evoflow.admin.tasks.create_task") as mock_create,
    ):
        mock_create.return_value = {"task_id": "Task_new"}
        raw = _invoke(action="create", name="跟进项")
    assert json.loads(raw)["ok"] is True
    _, kwargs = mock_create.call_args
    assert kwargs["source_ref"] == sk


def test_tasks_tool_description_stresses_frequent_updates():
    desc = str(getattr(tasks_tool, "description", "") or "")
    assert "progress" in desc
    assert "completed" in desc or "结案" in desc
    assert "summary" in desc
    assert "经常" in desc or "立刻" in desc
    assert "空等" in desc or "等待用户" in desc or "等待" in desc
    assert "completed" in desc
    assert "list" in desc.lower() or "20" in desc
