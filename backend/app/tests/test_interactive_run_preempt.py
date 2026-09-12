"""Unit tests for interactive chat preempting proactive LangGraph runs."""

from __future__ import annotations

from app.gateway.interactive_run_preempt import (
    _is_preemptible_background_run,
    chat_preempt_proactive_enabled,
)


def test_preempt_disabled_by_default(monkeypatch):
    monkeypatch.delenv("EVOFLOW_CHAT_PREEMPT_PROACTIVE", raising=False)
    assert chat_preempt_proactive_enabled() is False


def test_preempt_opt_in(monkeypatch):
    monkeypatch.setenv("EVOFLOW_CHAT_PREEMPT_PROACTIVE", "1")
    assert chat_preempt_proactive_enabled() is True


def test_preempt_proactive_session_key():
    run = {
        "thread_id": "t-pro",
        "status": "running",
        "kwargs": {
            "config": {"configurable": {"session_key": "proactive:dev-backend"}},
        },
    }
    assert _is_preemptible_background_run(run, except_thread_id="t-chat") is True


def test_skip_same_thread():
    run = {
        "thread_id": "t-chat",
        "status": "running",
        "kwargs": {
            "config": {"configurable": {"session_key": "proactive:x"}},
        },
    }
    assert _is_preemptible_background_run(run, except_thread_id="t-chat") is False


def test_skip_interactive_flag():
    run = {
        "thread_id": "t-other",
        "status": "running",
        "kwargs": {
            "context": {"evf_interactive": True, "session_key": "agent:main:new"},
        },
    }
    assert _is_preemptible_background_run(run, except_thread_id="t-chat") is False


def test_preempt_explicit_non_interactive():
    run = {
        "thread_id": "t-auto",
        "status": "pending",
        "kwargs": {"context": {"evf_interactive": False}},
    }
    assert _is_preemptible_background_run(run, except_thread_id="t-chat") is True
