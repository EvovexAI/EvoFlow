"""Tests for stream activity label formatting."""

from __future__ import annotations

from evoflow.tools.tool_activity_ui import format_activity_detail_from_tool_calls


def test_search_code_index_label() -> None:
    out = format_activity_detail_from_tool_calls([{"name": "search_code_index"}])
    assert out == "调用：🔍 工作区搜索"


def test_worker_expands_inner_tasks() -> None:
    out = format_activity_detail_from_tool_calls(
        [
            {
                "name": "worker",
                "args": {
                    "tasks": [
                        {"action": "search"},
                        {"action": "locate"},
                    ]
                },
            }
        ]
    )
    assert out == "调用：🔍 工作区搜索 · 📂 找文件"


def test_worker_hidden_when_no_tasks() -> None:
    out = format_activity_detail_from_tool_calls([{"name": "worker", "args": {}}])
    assert out == "调用工具…"


def test_latest_only_uses_last_tool_call() -> None:
    out = format_activity_detail_from_tool_calls(
        [
            {"name": "search_code_index"},
            {"name": "read_file"},
        ],
        latest_only=True,
    )
    assert out == "调用：📄 读取"
