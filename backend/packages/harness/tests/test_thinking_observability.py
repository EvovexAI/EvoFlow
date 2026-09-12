"""Tests for thinking/reasoning observability recording."""

from __future__ import annotations

import json
import sqlite3
from unittest.mock import MagicMock

import pytest

from evoflow.observability import thinking_context as tc
from evoflow.observability.recorder import reset_observability_store_for_tests
from evoflow.observability.sqlite_store import ObservabilitySqliteStore


def test_infer_thinking_modern_api_ignores_legacy_budget() -> None:
    payload = {
        "thinking": {"type": "enabled"},
        "reasoning": {"effort": "low"},
    }
    out = tc.infer_thinking_from_vendor_payload(payload)
    assert out["reasoning_effort"] == "low"
    assert out.get("thinking_budget_tokens") is None
    assert tc.format_thinking_label(out) == "轻度"


def test_infer_thinking_from_volc_vendor_payload() -> None:
    payload = {
        "extra_body": {
            "thinking": {"type": "enabled", "budget_tokens": 16384},
        }
    }
    out = tc.infer_thinking_from_vendor_payload(payload)
    assert out["thinking_enabled"] is True
    assert out["thinking_budget_tokens"] == 16384
    assert out.get("reasoning_effort_inferred") == "medium"


def test_merge_thinking_context_runtime_wins_effort() -> None:
    merged = tc.merge_thinking_context(
        {"thinking_enabled": True, "reasoning_effort": "high", "thinking_type": "manual"},
        {"thinking_budget_tokens": 8192, "reasoning_effort_inferred": "low"},
    )
    assert merged["reasoning_effort"] == "high"
    assert merged["thinking_budget_tokens"] == 8192


def test_resolve_vendor_request_from_stored() -> None:
    vendor = {
        "model": "doubao",
        "messages": [{"role": "user", "content": "hi"}],
        "extra_body": {"thinking": {"type": "enabled", "budget_tokens": 8192}},
    }
    assert tc.resolve_vendor_request_from_stored(vendor) == vendor
    assert tc.resolve_vendor_request_from_stored({"vendor_request": vendor}) == vendor
    legacy = {
        "stage": "final_payload",
        "system_prompt_full": "SYS",
        "payload": vendor,
    }
    assert tc.resolve_vendor_request_from_stored(legacy) == vendor
    assert tc.resolve_vendor_request_from_stored({"stage": "final_payload"}) is None


def test_format_thinking_label() -> None:
    assert tc.format_thinking_label({"reasoning_effort": "medium", "thinking_budget_tokens": 16384}) == "中度"
    assert (
        tc.format_thinking_label({"reasoning_effort_inferred": "medium", "thinking_budget_tokens": 16384})
        == "中度 (16384 tokens)"
    )
    assert tc.format_thinking_label({"thinking_enabled": False}) == "关闭"


@pytest.fixture
def obs_db(tmp_path):
    reset_observability_store_for_tests()
    db_path = tmp_path / "obs.db"
    store = ObservabilitySqliteStore(str(db_path))
    yield store
    store.close()
    reset_observability_store_for_tests()


def test_sqlite_thinking_columns_roundtrip(obs_db: ObservabilitySqliteStore) -> None:
    row_id = obs_db.insert_model_invocation_pending(
        thread_id="t1",
        run_id="r1",
        model_call_seq=2,
        provider="patched_openai",
        model="doubao",
        stage="final_payload",
        trace_id=None,
        requested_at="2026-07-08T12:00:01+08:00",
        request_json=None,
        thinking_enabled=1,
        reasoning_effort="high",
        thinking_type="manual",
        thinking_budget_tokens=32768,
        session_mode="agent",
    )
    vendor = {
        "model": "doubao",
        "extra_body": {"thinking": {"type": "enabled", "budget_tokens": 32768}},
    }
    obs_db.complete_model_invocation(
        row_id=row_id,
        latency_ms=120.0,
        request_json=json.dumps(vendor, ensure_ascii=False),
        thinking_enabled=1,
        reasoning_effort="high",
        thinking_type="manual",
        thinking_budget_tokens=32768,
        session_mode="agent",
    )
    conn = obs_db._connection()
    conn.row_factory = None
    row = conn.execute(
        "SELECT reasoning_effort, thinking_budget_tokens, request_json FROM evoflow_obs_model_invocations WHERE id = ?",
        (row_id,),
    ).fetchone()
    assert row[0] == "high"
    assert row[1] == 32768
    stored = json.loads(row[2])
    assert stored["model"] == "doubao"
    assert stored["extra_body"]["thinking"]["budget_tokens"] == 32768
    assert "vendor_request" not in stored
    assert "evoflow_thinking" not in stored


def test_sqlite_v7_db_migrates_to_v8_thinking_columns(tmp_path) -> None:
    """Existing v7 DB must open without CREATE INDEX on missing reasoning_effort."""
    reset_observability_store_for_tests()
    db_path = tmp_path / "v7.db"
    conn = sqlite3.connect(str(db_path))
    conn.executescript(
        """
        PRAGMA user_version = 7;
        CREATE TABLE evoflow_obs_model_invocations (
            id TEXT PRIMARY KEY,
            thread_id TEXT,
            run_id TEXT,
            model_call_seq INTEGER,
            provider TEXT,
            model TEXT,
            stage TEXT,
            trace_id TEXT,
            requested_at TEXT NOT NULL,
            latency_ms REAL,
            first_token_latency_ms REAL,
            request_json TEXT,
            response_json TEXT,
            usage_json TEXT,
            cache_read_tokens INTEGER,
            cache_creation_tokens INTEGER,
            cache_miss_tokens INTEGER,
            collab_phase TEXT,
            checkpoint_id TEXT,
            invocation_kind TEXT,
            started_at TEXT,
            status TEXT NOT NULL DEFAULT 'completed'
        );
        """
    )
    conn.close()

    store = ObservabilitySqliteStore(str(db_path))
    c = store._connection()
    cols = {str(r[1]) for r in c.execute("PRAGMA table_info(evoflow_obs_model_invocations)")}
    assert "reasoning_effort" in cols
    assert int(c.execute("PRAGMA user_version").fetchone()[0]) == 8
    store.close()
    reset_observability_store_for_tests()


def test_log_model_request_payload_includes_thinking(monkeypatch) -> None:
    from evoflow.models import request_payload_logger as rpl

    pending: list[dict] = []

    class _Rec:
        def record_model_invocation_pending(self, **kwargs):
            pending.append(kwargs)
            return "row-1"

    monkeypatch.setattr(rpl, "_thread_id_for_log", lambda: "thread-x")
    monkeypatch.setattr(
        "evoflow.models.vendor_roundtrip.roundtrip_enabled",
        lambda: False,
    )
    monkeypatch.setattr(
        "evoflow.observability.recorder.get_observability_recorder",
        lambda: _Rec(),
    )
    monkeypatch.setattr(
        "evoflow.observability.thinking_context.collect_runtime_thinking_context",
        lambda model_instance=None: {
            "thinking_enabled": True,
            "reasoning_effort": "medium",
            "thinking_type": "manual",
        },
    )

    model = MagicMock()
    rpl.log_model_request_payload(
        "patched_openai",
        "doubao",
        {"extra_body": {"thinking": {"type": "enabled", "budget_tokens": 16384}}},
        model_instance=model,
    )
    assert len(pending) == 1
    assert pending[0].get("reasoning_effort") == "medium"
    assert pending[0].get("thinking_type") == "manual"
    req = json.loads(pending[0]["request_json"])
    assert req["extra_body"]["thinking"]["budget_tokens"] == 16384
    assert "evoflow_thinking" not in req
