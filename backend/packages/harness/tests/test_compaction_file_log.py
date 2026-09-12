"""Tests for dedicated context compaction trace file logging."""

from __future__ import annotations

import logging
from pathlib import Path

import pytest
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from evoflow.observability import compaction_file_log as cfl


def test_count_message_rounds() -> None:
    msgs = [
        HumanMessage(content="hi"),
        AIMessage(content="hello"),
        ToolMessage(content="ok", tool_call_id="t1"),
    ]
    rounds = cfl.count_message_rounds(msgs)
    assert rounds == {
        "model_round": 1,
        "human_turns": 1,
        "tool_results": 1,
        "message_count": 3,
    }


def test_log_compaction_trace_writes_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    log_file = tmp_path / "context-compaction.log"
    monkeypatch.setenv("EVOFLOW_COMPACTION_TRACE_LOG_FILE", str(log_file))
    monkeypatch.setattr(cfl, "_CONFIGURED", False)

    cfl.log_compaction_trace(
        "gate检查",
        thread_id="thread-abc-123",
        session_key="agent:main:sk1",
        model_name="gpt-4o",
        phase="before_conversation_fold",
        context_length=32_000,
        model_context="32k",
        gate_tokens=18_500,
        history_tokens=17_000,
        overhead_tokens=1_500,
        pct_of_context=57.8,
        threshold=16_000,
        should_trigger=True,
        model_round=5,
        human_turns=3,
        tool_results=4,
    )

    assert log_file.is_file()
    text = log_file.read_text(encoding="utf-8")
    assert "上下文压缩" in text
    assert "gate检查" in text
    assert "thread=thread-abc-123" in text
    assert "model=gpt-4o" in text
    assert "gate_tokens" in text
    assert "应触发压缩" in text
    assert "---" in text


def test_log_compaction_trace_not_in_console_by_default(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    log_file = tmp_path / "context-compaction.log"
    monkeypatch.setenv("EVOFLOW_COMPACTION_TRACE_LOG_FILE", str(log_file))
    monkeypatch.delenv("EVOFLOW_COMPACTION_TRACE_CONSOLE", raising=False)
    monkeypatch.setattr(cfl, "_CONFIGURED", False)

    with caplog.at_level(logging.INFO):
        cfl.log_compaction_trace("隔离测试", thread_id="t1", reason="below_threshold")

    assert log_file.is_file()
    assert "隔离测试" in log_file.read_text(encoding="utf-8")
    assert "隔离测试" not in caplog.text


def test_file_logging_disabled(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("EVOFLOW_COMPACTION_TRACE_LOG", "0")
    monkeypatch.setenv("EVOFLOW_COMPACTION_TRACE_LOG_FILE", str(tmp_path / "context-compaction.log"))
    monkeypatch.setattr(cfl, "_CONFIGURED", False)

    cfl.log_compaction_trace("不应写入")
    assert not (tmp_path / "context-compaction.log").exists()


def test_log_model_response_diagnosis_writes_verdict(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    log_file = tmp_path / "context-compaction.log"
    monkeypatch.setenv("EVOFLOW_COMPACTION_TRACE_LOG_FILE", str(log_file))
    monkeypatch.delenv("EVOFLOW_COMPACTION_TRACE_LOG", raising=False)
    monkeypatch.setattr(cfl, "_CONFIGURED", False)

    cfl.log_model_response_diagnosis(
        "模型空返回",
        diagnosis="压缩后厂商空返回（API output=0，非系统剥工具）",
        thread_id="t-diag",
        output_tokens=0,
        input_tokens=22185,
        finish_reason="stop",
        compaction_folded=True,
        msgs_before_fold=22,
        msgs_after_fold=3,
    )

    text = log_file.read_text(encoding="utf-8")
    assert "判定" in text or "diagnosis" in text
    assert "压缩后厂商空返回" in text
    assert "output_tokens" in text
    assert "本轮已压缩" in text or "compaction_folded" in text
