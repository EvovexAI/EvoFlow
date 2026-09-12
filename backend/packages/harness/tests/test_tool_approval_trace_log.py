"""Tests for dedicated tool approval trace file logging."""

from __future__ import annotations

from pathlib import Path

import pytest

from evoflow.agents import tool_approval_trace_log as tat


def test_log_tool_approval_trace_writes_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    log_file = tmp_path / "tool-approval-trace.log"
    monkeypatch.setenv("EVOFLOW_TOOL_APPROVAL_TRACE_LOG_FILE", str(log_file))
    monkeypatch.setattr(tat, "_CONFIGURED", False)

    tat.log_tool_approval_trace(
        "闸门拦截",
        thread_id="thread-1",
        session_key="agent:main:sk1",
        tool_name="delete",
        tool_call_id="call_abc",
        决策="Command.goto=END",
        摘要="outputs/foo.txt",
        有效策略="prompt",
    )

    assert log_file.is_file()
    text = log_file.read_text(encoding="utf-8")
    assert "工具授权" in text
    assert "闸门拦截" in text
    assert "thread=thread-1" in text
    assert "delete" in text
    assert "Command.goto=END" in text
    assert "---" in text


def test_file_logging_disabled(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("EVOFLOW_TOOL_APPROVAL_TRACE_LOG", "0")
    monkeypatch.setenv("EVOFLOW_TOOL_APPROVAL_TRACE_LOG_FILE", str(tmp_path / "tool-approval-trace.log"))
    monkeypatch.setattr(tat, "_CONFIGURED", False)

    tat.log_tool_approval_trace("不应写入")
    assert not (tmp_path / "tool-approval-trace.log").exists()


def test_log_tool_approval_trace_no_duplicate_tool_call_id_kwarg(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Regression: named tool_call_id + fields['tool_call_id'] must not raise TypeError."""
    log_file = tmp_path / "tool-approval-trace.log"
    monkeypatch.setenv("EVOFLOW_TOOL_APPROVAL_TRACE_LOG_FILE", str(log_file))
    monkeypatch.setattr(tat, "_CONFIGURED", False)

    tat.log_tool_approval_trace(
        "wrap_tool_call 进入",
        thread_id="thread-1",
        tool_name="write",
        tool_call_id="call_xyz",
        原始工具名="write",
        规范工具名="write",
        args摘要="path=foo.txt",
    )
    assert log_file.is_file()


def test_delete_file_alias_requires_approval() -> None:
    from evoflow.agents.tool_approval_config import RISK_CONFIRM, tool_requires_approval, tool_risk_level

    args = {"path": "foo.txt"}
    assert tool_risk_level("delete_file", args) == RISK_CONFIRM
    assert tool_requires_approval("delete_file", args) is True
