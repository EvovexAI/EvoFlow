"""Hydration before_model must not kill the agent run on db_process_lock_timeout.

Regression (2026-11-23 20:37): after a successful tool hop,
SessionTranscriptHydrationMiddleware.before_model → get_session_hydration_watermark
→ get_db() raised on the LangGraph asyncio bg-loop. LangGraph serde redacted it to
「An internal error occurred」, so the UI blamed the model and did not retry
(middleware abort ≠ model SERVER_ERROR path).
"""

from __future__ import annotations

import sqlite3

import pytest


def test_get_session_hydration_watermark_soft_fails_on_process_lock(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from evoflow.persistence import chat_message_repositories as cmr

    def _boom_get_db(**_kw):
        raise sqlite3.OperationalError(
            "db_process_lock_timeout: 另一个线程正持有进程内数据库锁；"
            "等 0.50s 未拿到，直接重试这条操作即可 —— 原错误：database is locked"
        )

    monkeypatch.setattr(cmr, "get_db", _boom_get_db)
    assert cmr.get_session_hydration_watermark("agent:main:lock-test") == (0, None)


def test_hydration_before_model_soft_fails_on_process_lock(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from evoflow.agents.middlewares.session_transcript_hydration_middleware import (
        SessionTranscriptHydrationMiddleware,
    )

    mw = SessionTranscriptHydrationMiddleware()

    class _Rt:
        context = {"thread_id": "tid-lock"}

    monkeypatch.setattr(
        "evoflow.agents.middlewares.session_transcript_hydration_middleware._thread_id_from_runtime",
        lambda _rt: "tid-lock",
    )
    monkeypatch.setattr(
        "evoflow.agents.middlewares.session_transcript_hydration_middleware._session_key_from_runtime",
        lambda _rt, _tid: "agent:main:lock-test",
    )

    def _boom(*_a, **_k):
        raise sqlite3.OperationalError(
            "db_process_lock_timeout: 另一个线程正持有进程内数据库锁"
        )

    monkeypatch.setattr(
        "evoflow.agents.middlewares.session_transcript_hydration_middleware._drain_pending_injects_into_transcript",
        _boom,
    )
    # Must not raise — keep runtime messages and continue the model hop.
    assert mw.before_model({"messages": []}, _Rt()) is None
