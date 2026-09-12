"""Tests for persisting context usage on chat sessions."""

from __future__ import annotations

import json

import pytest

from evoflow.persistence import session_repositories as sess_repo
from evoflow.persistence.session_context_usage import (
    build_context_usage_snapshot,
    persist_session_context_usage,
)


@pytest.fixture
def session_db(tmp_path, monkeypatch):
    db_path = tmp_path / "ctx_usage.db"
    monkeypatch.setenv("EVOFLOW_DB_PATH", str(db_path))
    from evoflow.persistence.db import init_db

    init_db()
    return db_path


def test_build_context_usage_snapshot_includes_before_tokens():
    snap = build_context_usage_snapshot(
        used_tokens=12_000,
        window_tokens=256_000,
        message_count=8,
        before_tokens=90_000,
        compacted=True,
        note="conversation_fold",
    )
    assert snap["used_tokens"] == 12_000
    assert snap["window_tokens"] == 256_000
    assert snap["before_tokens"] == 90_000
    assert snap["compacted"] is True
    assert snap["pct"] == pytest.approx(4.7, abs=0.1)
    assert isinstance(snap["updated_at_ms"], int)


def test_persist_session_context_usage_roundtrip(session_db):
    sk = "agent:test:ctx-usage"
    sess_repo.upsert_session_row(sk, thread_id="tid-ctx", title="ctx usage")
    snap = build_context_usage_snapshot(
        used_tokens=42_000,
        window_tokens=256_000,
        message_count=15,
        note="after_model",
    )
    persist_session_context_usage(sk, snap)

    row = sess_repo.get_session_row_for_ui(sk)
    assert row is not None
    ctx = row.get("context") or {}
    stored = ctx.get("context_usage")
    assert isinstance(stored, dict)
    assert stored["used_tokens"] == 42_000
    assert stored["window_tokens"] == 256_000
    assert stored["message_count"] == 15
    assert stored["note"] == "after_model"

    from evoflow.persistence.db import get_db

    raw = get_db().execute(
        "SELECT context_json FROM evoflow_chat_sessions WHERE session_key = ?",
        (sk,),
    ).fetchone()
    extra = json.loads(raw[0] or "{}")
    assert extra["context_usage"]["used_tokens"] == 42_000


def test_emit_context_usage_persists_when_session_key_provided(session_db, monkeypatch):
    from evoflow.agents.context_compaction_events import emit_context_usage

    sk = "agent:test:emit-persist"
    sess_repo.upsert_session_row(sk, thread_id="tid-emit")

    captured: list = []

    def _writer(payload):
        captured.append(payload)

    monkeypatch.setattr("langgraph.config.get_stream_writer", lambda: _writer)

    emit_context_usage(
        used_tokens=18_000,
        window_tokens=128_000,
        message_count=12,
        before_tokens=98_000,
        compacted=True,
        note="conversation_fold",
        session_key=sk,
    )

    assert len(captured) == 1
    assert captured[0]["type"] == "context_usage"
    row = sess_repo.get_session_row_for_ui(sk)
    stored = (row.get("context") or {}).get("context_usage")
    assert stored["used_tokens"] == 18_000
    assert stored["before_tokens"] == 98_000
