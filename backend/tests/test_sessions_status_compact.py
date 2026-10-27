"""platform sessions.status / sessions.compact helpers."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from evoflow.admin import sessions as sess
from evoflow.admin.errors import ValidationError
from evoflow.admin.platform_handlers import sessions_status


def test_resolve_session_key_prefers_explicit():
    assert sess.resolve_session_key(session_key=" agent:main:x ", thread_id="t1") == "agent:main:x"


def test_get_session_status_requires_key():
    with pytest.raises(ValidationError):
        sess.get_session_status()


def test_get_session_status_payload(monkeypatch):
    monkeypatch.setattr(
        "evoflow.persistence.session_repositories.get_session_row_for_ui",
        lambda sk: {
            "sessionKey": sk,
            "threadId": "tid-1",
            "title": "测试会话",
            "messageCount": 12,
            "runStatus": "idle",
            "currentRunId": None,
            "modelName": "gpt-test",
            "collabPhase": None,
            "inputTokens": 100,
            "outputTokens": 50,
            "totalTokens": 150,
        },
    )
    monkeypatch.setattr(
        "evoflow.persistence.session_context_usage.load_session_context_usage",
        lambda sk: {
            "used_tokens": 3200,
            "window_tokens": 128000,
            "pct": 2.5,
            "message_count": 12,
            "compacted": False,
        },
    )
    monkeypatch.setattr(
        "evoflow.persistence.chat_message_repositories.find_latest_compaction_seq",
        lambda sk: None,
    )

    out = sess.get_session_status(session_key="agent:main:demo")
    assert out["session_key"] == "agent:main:demo"
    assert out["running"] is False
    assert out["context_usage"]["pct"] == 2.5
    assert out["compaction"]["has_summary"] is False
    assert "上下文占用" in out["markdown"]


def test_sessions_status_handler(monkeypatch):
    monkeypatch.setattr(
        sess,
        "get_session_status",
        lambda **kwargs: {
            "session_key": kwargs.get("session_key") or "injected",
            "message_count": 3,
            "run_status": "idle",
            "running": False,
            "context_usage": {"pct": 1.0},
            "compaction": {"has_summary": False},
            "markdown": "## 当前对话状态",
        },
    )
    out = sessions_status({"session_key": "agent:main:z"})
    assert out["ok"] is True
    assert out["action"] == "sessions.status"
    assert out["session_key"] == "agent:main:z"


def test_format_compact_result_notes_running():
    result = SimpleNamespace(
        changed=True,
        reason="manual_compact",
        before_gate_tokens=9000,
        after_gate_tokens=4000,
        before_message_count=40,
        after_message_count=8,
        persisted_summary=True,
        context_usage={"used_tokens": 4000, "window_tokens": 128000, "pct": 3.1},
    )
    out = sess.format_compact_result(session_key="agent:main:x", running=True, result=result)
    assert out["changed"] is True
    assert out["running_during_compact"] is True
    assert "后续轮次" in out["markdown"]
