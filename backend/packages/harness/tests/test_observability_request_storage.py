"""Observability request_json layout: prompts/users before tool schemas."""

from __future__ import annotations

import json

from evoflow.models.vendor_roundtrip import (
    build_observability_request_record,
    serialize_vendor_request_json,
)


def test_build_observability_request_record_prioritizes_prompts_over_tool_schemas() -> None:
    huge_desc = "x" * 50_000
    vendor = {
        "model": "deepseek-v4-flash",
        "stream": True,
        "tools": [
            {"type": "function", "function": {"name": "read", "description": huge_desc}},
            {"type": "function", "function": {"name": "rg", "description": huge_desc}},
        ],
        "messages": [
            {"role": "system", "content": "System prompt body"},
            {"role": "user", "content": "older"},
            {"role": "user", "content": "latest user question"},
        ],
    }
    record = build_observability_request_record(vendor)
    assert "system_prompt_full" not in record
    assert record["system_prompt_stats"]["chars"] == len("System prompt body")
    assert record["latest_user_preview"] == "latest user question"
    assert record["request_tool_names"] == ["read", "rg"]
    assert record["tools"] == [
        {"type": "function", "function": {"name": "read"}},
        {"type": "function", "function": {"name": "rg"}},
    ]
    assert isinstance(record.get("request_tools_stats"), list)
    assert len(record["request_tools_stats"]) == 2
    assert record["request_tools_stats"][0]["name"] == "read"
    assert record["request_tools_stats"][0]["chars"] > 1000
    assert record["request_tools_stats"][0]["tokens"] > 0
    assert record["request_tools_tokens_total"] > record["request_tools_stats"][0]["tokens"]
    assert record["latest_user_stats"]["chars"] == len("latest user question")
    assert isinstance(record.get("messages"), list)
    assert record["messages"][-1]["content"] == "latest user question"
    assert record["messages"][0]["content"] == "System prompt body"

    raw = serialize_vendor_request_json(vendor)
    assert raw is not None
    assert "system_prompt_full" not in raw
    assert "System prompt body" in raw
    assert "request_tool_names" in raw
    assert huge_desc not in raw
    parsed = json.loads(raw)
    assert parsed["latest_user_preview"] == "latest user question"


def test_serialize_obs_request_record_preserves_system_when_tail_truncated(monkeypatch) -> None:
    from evoflow.models import vendor_roundtrip as vr

    monkeypatch.setattr(vr, "_obs_stored_json_budget", lambda: 800)
    vendor = {
        "model": "m",
        "messages": [
            {"role": "system", "content": "KEEP_SYSTEM"},
            {"role": "user", "content": "u1"},
            {"role": "user", "content": "u2"},
            {"role": "user", "content": "u3"},
            {"role": "user", "content": "u4"},
        ],
    }
    raw = serialize_vendor_request_json(vendor)
    assert raw is not None
    parsed = json.loads(raw)
    stored = parsed.get("messages") or []
    roles = [m.get("role") for m in stored if isinstance(m, dict)]
    assert roles[0] == "system"
    assert any(m.get("content") == "KEEP_SYSTEM" for m in stored if isinstance(m, dict))
    assert parsed.get("message_count") == 5


def test_sqlite_store_truncate_stored_json_preserves_system() -> None:
    from evoflow.observability.sqlite_store import _truncate_stored_json

    vendor = {
        "model": "m",
        "message_count": 5,
        "messages": [
            {"role": "system", "content": "KEEP_SYSTEM"},
            {"role": "user", "content": "u" * 500},
            {"role": "user", "content": "u" * 500},
            {"role": "user", "content": "u" * 500},
            {"role": "user", "content": "u" * 500},
        ],
    }
    raw = json.dumps(vendor, ensure_ascii=False)
    assert len(raw) > 1024  # engage the store-side cap (floor is 1024)
    out = _truncate_stored_json(raw, limit=1024)
    assert out is not None
    parsed = json.loads(out)
    stored = parsed.get("messages") or []
    roles = [m.get("role") for m in stored if isinstance(m, dict)]
    assert roles[0] == "system"
    assert any(m.get("content") == "KEEP_SYSTEM" for m in stored if isinstance(m, dict))
    assert parsed.get("message_count") == 5
    assert parsed.get("messages_truncated")
    assert len(stored) < 5
