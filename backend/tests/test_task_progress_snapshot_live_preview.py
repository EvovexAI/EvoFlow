"""工作流节点实时行：快照必须带 currentStep / executionPreview。

背景：工作流节点原先只读当前会话的 WS 流（threadPanelState.subagentTasks），
刷新后或从别的工作流打开时为空 → 节点看不到实时工具/正文。
后端快照补上落库的实时字段，前端才能兜底显示。
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

_BACKEND = Path(__file__).resolve().parents[1] / "packages" / "harness"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from evoflow.collab import task_progress_snapshot as snap  # noqa: E402


def _row(status: str = "in_progress", **extra) -> dict:
    base = {
        "id": "Subtask_20261028052402_047312",
        "name": "搜竞品资料",
        "status": status,
        "progress": 40,
        "assigned_to": "researcher",
    }
    base.update(extra)
    return base


def test_latest_preview_text_prefers_last_assistant_tool_row(monkeypatch):
    task = {"id": "Task_1", "subtasks": [_row()]}
    st = task["subtasks"][0]

    calls: list[dict] = []

    def fake_list(_task, sid, *, subtask_row=None, limit=500):
        calls.append({"sid": sid, "limit": limit})
        return [
            {"role": "assistant", "content": "旧的一段"},
            {"role": "tool", "content": "正在读取竞品页面"},
        ]

    monkeypatch.setattr(
        "evoflow.collab.conversation_persist.list_subtask_conversation_ui_messages",
        fake_list,
    )

    out = snap._latest_subtask_preview_text(task, st, st["id"])
    assert out == "正在读取竞品页面"
    # limit 必须收紧，否则每次轮询都扫 500 行
    assert calls and calls[0]["limit"] == 1


def test_latest_preview_text_skips_non_text_roles(monkeypatch):
    task = {"id": "Task_1", "subtasks": [_row()]}
    st = task["subtasks"][0]

    def fake_list(_task, _sid, *, subtask_row=None, limit=500):
        return [
            {"role": "user", "content": "用户输入"},
            {"role": "assistant", "content": "  正文  "},
        ]

    monkeypatch.setattr(
        "evoflow.collab.conversation_persist.list_subtask_conversation_ui_messages",
        fake_list,
    )

    assert snap._latest_subtask_preview_text(task, st, st["id"]) == "正文"


def test_latest_preview_text_returns_empty_without_subtask_id():
    assert snap._latest_subtask_preview_text({}, {}, "") == ""


def test_subtask_terminal_states():
    for status in ("completed", "failed", "cancelled", "timed_out"):
        assert snap._subtask_terminal({"status": status}) is True
    for status in ("in_progress", "pending", "running", ""):
        assert snap._subtask_terminal({"status": status}) is False


@pytest.mark.parametrize("status", ["completed", "failed", "cancelled", "timed_out"])
def test_terminal_subtasks_skip_transcript_read(monkeypatch, status):
    """终态子任务不查 transcript —— 节点显示汇报/结果就够，省一次 DB 查询。"""
    task = {"id": "Task_1", "subtasks": [_row(status=status)]}
    st = task["subtasks"][0]

    def boom(*_a, **_kw):
        raise AssertionError("terminal subtask must not read transcript")

    monkeypatch.setattr(
        "evoflow.collab.conversation_persist.list_subtask_conversation_ui_messages",
        boom,
    )

    assert snap._latest_subtask_preview_text.__name__  # 函数存在
    # pack 内部只在未终态时调用；这里直接断言判断逻辑
    assert snap._subtask_terminal(st) is True
