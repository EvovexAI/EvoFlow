"""Tests for dedicated goal trace file logging."""

from __future__ import annotations

from pathlib import Path

import pytest

from evoflow.agents.goal import goal_trace_log as gt


def test_clip_goal_trace_text() -> None:
    assert gt.clip_goal_trace_text("") == "（空）"
    assert gt.clip_goal_trace_text("a" * 600).endswith("…")


def test_log_goal_trace_writes_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    log_file = tmp_path / "goal-trace.log"
    monkeypatch.setenv("EVOFLOW_GOAL_TRACE_LOG_FILE", str(log_file))
    monkeypatch.setattr(gt, "_CONFIGURED", False)

    gt.log_goal_trace(
        "测试事件",
        session_key="agent:main:sk1",
        turn_no=2,
        max_steps=8,
        goal_text="完成模块 A",
        user_input="用户说了什么",
        assistant_output="hello",
        judgment="测试判定",
        decision="续跑",
        action="jump_to=model",
        nudge_input="[Goal 续跑 · 第3轮] ...",
        state_patch="status=running step_count=3",
    )

    assert log_file.is_file()
    text = log_file.read_text(encoding="utf-8")
    assert "目标模式" in text
    assert "轮次=2/8" in text
    assert "用户输入" in text
    assert "助手输出" in text
    assert "判定" in text
    assert "续跑输入" in text
    assert "状态写入" in text
    assert "---" in text


def test_log_goal_trace_not_in_console_by_default(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    import logging

    log_file = tmp_path / "goal-trace.log"
    monkeypatch.setenv("EVOFLOW_GOAL_TRACE_LOG_FILE", str(log_file))
    monkeypatch.delenv("EVOFLOW_GOAL_TRACE_CONSOLE", raising=False)
    monkeypatch.setattr(gt, "_CONFIGURED", False)

    with caplog.at_level(logging.INFO):
        gt.log_goal_trace("隔离测试", session_key="sk", decision="不应出现在 caplog")

    assert log_file.is_file()
    assert "隔离测试" in log_file.read_text(encoding="utf-8")
    assert "隔离测试" not in caplog.text


def test_format_goal_state_patch() -> None:
    assert gt.format_goal_state_patch(status="running", step_count=2) == "status=running step_count=2"


def test_file_logging_disabled(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("EVOFLOW_GOAL_TRACE_LOG", "0")
    monkeypatch.setenv("EVOFLOW_GOAL_TRACE_LOG_FILE", str(tmp_path / "goal-trace.log"))
    monkeypatch.setattr(gt, "_CONFIGURED", False)

    gt.log_goal_trace("不应写入")
    assert not (tmp_path / "goal-trace.log").exists()
