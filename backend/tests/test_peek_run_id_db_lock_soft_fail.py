"""peek_current_run_id must not kill the agent run on db_process_lock_timeout.

Regression (2026-11-23): after a successful bash tool hop, TranscriptMiddleware
.before_model → peek_current_run_id → get_db() raised on the LangGraph asyncio
bg-loop (0.5s process-lock fail-fast). LangGraph serde redacted it to
「An internal error occurred」, so the UI blamed the model.
"""

from __future__ import annotations

import sqlite3

import pytest


def test_peek_current_run_id_soft_fails_on_process_lock(monkeypatch: pytest.MonkeyPatch) -> None:
    from evoflow.persistence import session_run_state as srs

    monkeypatch.setattr(
        srs,
        "_resolve_session_key",
        lambda **_kw: "agent:main:lock-test",
    )

    def _boom_get_db(**_kw):
        raise sqlite3.OperationalError(
            "db_process_lock_timeout: 另一个线程正持有进程内数据库锁；"
            "等 0.50s 未拿到，直接重试这条操作即可 —— 原错误：database is locked"
        )

    monkeypatch.setattr(srs, "get_db", _boom_get_db)
    assert srs.peek_current_run_id(session_key="agent:main:lock-test") is None


def test_mark_run_active_continues_when_run_id_lookup_locks(monkeypatch: pytest.MonkeyPatch) -> None:
    from evoflow.agents.middlewares.transcript_middleware import TranscriptMiddleware

    mw = TranscriptMiddleware()

    class _Rt:
        context = {"thread_id": "tid-lock"}

    monkeypatch.setattr(
        "evoflow.agents.middlewares.transcript_middleware._thread_id_from_runtime",
        lambda _rt: "tid-lock",
    )
    monkeypatch.setattr(
        "evoflow.agents.middlewares.transcript_middleware._session_key_for_thread",
        lambda _tid: "agent:main:lock-test",
    )

    def _boom(*_a, **_k):
        raise sqlite3.OperationalError(
            "db_process_lock_timeout: 另一个线程正持有进程内数据库锁"
        )

    monkeypatch.setattr(
        "evoflow.agents.middlewares.transcript_middleware._run_id_for_transcript",
        _boom,
    )
    # Must not raise — model call continues without run stamp.
    mw._mark_run_active(_Rt())
