"""Model invocation list must not SELECT request/response blobs."""

from __future__ import annotations

import json
from pathlib import Path

import pytest


@pytest.fixture()
def obs_store(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    from evoflow.observability import queries
    from evoflow.observability.recorder import reset_observability_store_for_tests
    from evoflow.observability.sqlite_store import ObservabilitySqliteStore

    reset_observability_store_for_tests()
    db = tmp_path / "evoflow_observability.db"
    store = ObservabilitySqliteStore(str(db))
    monkeypatch.setattr(queries, "_store", lambda: store)
    yield store
    store.close()
    reset_observability_store_for_tests()


def test_list_model_invocations_omits_blobs_and_uses_projection(obs_store) -> None:
    from evoflow.observability import queries

    # Inflate payloads so a SELECT * of blobs would be obviously expensive.
    huge_req = json.dumps(
        {
            "message_count": 12,
            "messages": [{"role": "user", "content": "x" * 8000}],
            "pad": "p" * 50_000,
        },
        ensure_ascii=False,
    )
    huge_resp = json.dumps(
        {
            "generations": [
                [{"text": "hello from model", "message": {"content": "hello from model"}}]
            ],
            "pad": "q" * 50_000,
        },
        ensure_ascii=False,
    )

    obs_store.insert_model_invocation(
        thread_id="thread-slim-1",
        run_id="run-1",
        model_call_seq=1,
        provider="test",
        model="test-model",
        stage="chat",
        trace_id=None,
        requested_at="2026-10-30T00:00:00+00:00",
        latency_ms=123.0,
        request_json=huge_req,
        response_json=huge_resp,
        usage_json=json.dumps({"input_tokens": 10, "output_tokens": 5, "total_tokens": 15}),
    )

    out = queries.list_model_invocations(thread_id="thread-slim-1", page=1, page_size=20)
    assert out.get("enabled") is True
    items = out.get("items") or []
    assert len(items) == 1
    row = items[0]
    assert "request_json" not in row
    assert "response_json" not in row
    assert row.get("message_count") == 12
    summary = row.get("response_summary")
    assert isinstance(summary, dict)
    preview = str(summary.get("contentPreview") or summary.get("content_preview") or "")
    assert "hello from model" in preview
    assert row.get("usage_input_tokens") == 10


def test_list_projection_written_on_complete(obs_store) -> None:
    from evoflow.observability import queries

    row_id = obs_store.insert_model_invocation_pending(
        thread_id="thread-slim-2",
        run_id="run-2",
        model_call_seq=1,
        provider="test",
        model="m",
        stage="chat",
        trace_id=None,
        requested_at="2026-10-30T01:00:00+00:00",
        request_json=json.dumps({"message_count": 3, "messages": []}),
    )
    obs_store.complete_model_invocation(
        row_id=row_id,
        latency_ms=50.0,
        response_json=json.dumps(
            {"generations": [[{"text": "ok", "message": {"content": "ok"}}]]}
        ),
        usage_json=None,
        status="completed",
    )

    out = queries.list_model_invocations(thread_id="thread-slim-2", page=1, page_size=10)
    row = (out.get("items") or [])[0]
    assert row.get("message_count") == 3
    assert isinstance(row.get("response_summary"), dict)
