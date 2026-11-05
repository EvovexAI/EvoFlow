"""Ops/debug observability must keep full vendor transcripts by default."""

from __future__ import annotations

from evoflow.models.vendor_roundtrip import (
    _obs_stored_json_budget,
    _serialize_obs_request_record,
    serialize_vendor_request_json,
)
from evoflow.observability.sqlite_store import _truncate_stored_json


def test_obs_budget_default_unlimited(monkeypatch):
    monkeypatch.delenv("EVOFLOW_OBS_REQUEST_JSON_BUDGET", raising=False)
    assert _obs_stored_json_budget() == 0


def test_serialize_keeps_all_messages_when_unlimited(monkeypatch):
    monkeypatch.delenv("EVOFLOW_OBS_REQUEST_JSON_BUDGET", raising=False)
    # Build a payload larger than the old 500KB shrink threshold.
    blob = "x" * 20_000
    messages = [
        {"role": "system", "content": "sys-" + blob},
        *[{"role": "user", "content": f"u{i}-" + blob} for i in range(30)],
    ]
    raw = serialize_vendor_request_json({"model": "m", "messages": messages})
    assert raw is not None
    assert "messages_truncated" not in raw
    assert raw.count('"role": "user"') == 30
    assert "sys-" in raw


def test_sqlite_store_default_keeps_full_json(monkeypatch):
    monkeypatch.delenv("EVOFLOW_OBS_STORED_MODEL_JSON_LIMIT", raising=False)
    huge = '{"messages":[' + ",".join(f'{{"role":"user","content":"{"y"*8000}"}}' for _ in range(80)) + "]}"
    assert len(huge) > 512 * 1024
    out = _truncate_stored_json(huge)
    assert out == huge
    assert "messages_truncated" not in (out or "")


def test_opt_in_budget_still_shrinks(monkeypatch):
    monkeypatch.setenv("EVOFLOW_OBS_REQUEST_JSON_BUDGET", "20000")
    msgs = [{"role": "system", "content": "s"}, *[{"role": "user", "content": "u" * 5000} for _ in range(10)]]
    record = {"message_count": len(msgs), "messages": msgs, "model": "m"}
    raw = _serialize_obs_request_record(record)
    assert "messages_truncated" in raw
