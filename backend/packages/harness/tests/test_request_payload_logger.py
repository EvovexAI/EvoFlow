"""request_payload_logger: full system prompt in logs and long system bodies in payload."""

from __future__ import annotations

import json

from evoflow.models import request_payload_logger as rpl


def test_extract_system_prompt_full_merges_segments() -> None:
    payload = {
        "instructions": "A",
        "messages": [
            {"role": "system", "content": "B"},
            {"role": "user", "content": "hi"},
            {"role": "system", "content": [{"type": "text", "text": "C"}]},
        ],
    }
    out = rpl.extract_system_prompt_full_from_vendor_payload(payload)
    assert "A" in out and "B" in out and "C" in out
    assert "system segment" in out


def test_extract_system_prompt_full_dedupes_identical_system_messages() -> None:
    dup = "<collab_phase_context>\nphase planning\n</collab_phase_context>"
    payload = {
        "messages": [
            {"role": "system", "content": "base"},
            {"role": "system", "content": dup},
            {"role": "system", "content": dup},
            {"role": "user", "content": "hi"},
        ],
    }
    out = rpl.extract_system_prompt_full_from_vendor_payload(payload)
    assert out.count(dup) == 1
    assert "system segment 3/3" not in out


def test_extract_effective_system_prompt_falls_back_to_user_message() -> None:
    payload = {
        "messages": [
            {
                "role": "user",
                "content": "You are a memory management system. Analyze the conversation.",
            }
        ],
    }
    out = rpl.extract_effective_system_prompt_for_ui(payload)
    assert "memory management system" in out


def test_truncate_payload_keeps_long_system_message() -> None:
    long_sys = "S" * 9000
    payload = {
        "model": "x",
        "messages": [
            {"role": "system", "content": long_sys},
            {"role": "user", "content": "U" * 9000},
        ],
    }
    slim = rpl._truncate_payload_for_log(payload)
    sys_msg = next(m for m in slim["messages"] if m["role"] == "system")
    user_msg = next(m for m in slim["messages"] if m["role"] == "user")
    assert len(sys_msg["content"]) == 9000
    assert len(user_msg["content"]) < 9000
    assert "truncated" in user_msg["content"]


def test_log_writes_system_prompt_full(monkeypatch) -> None:
    recorded: list[dict] = []

    class _Rec:
        def record_model_invocation_pending(self, **kwargs):
            recorded.append(kwargs)
            return "row-pending"

    monkeypatch.setenv("EVOFLOW_MODEL_REQUEST_LOG_SYSTEM_PROMPT_MAX_CHARS", "0")
    monkeypatch.setattr(rpl, "_thread_id_for_log", lambda: "t-test-thread")
    monkeypatch.setattr(
        "evoflow.models.vendor_roundtrip.roundtrip_enabled",
        lambda: False,
    )
    monkeypatch.setattr(
        "evoflow.observability.recorder.get_observability_recorder",
        lambda: _Rec(),
    )

    long_sys = "Z" * 6000
    payload = {"messages": [{"role": "system", "content": long_sys}], "model": "m"}

    rpl.log_model_request_payload("p", "m", payload)

    assert len(recorded) == 1
    rec = json.loads(recorded[0]["request_json"])
    sys_msg = next(m for m in rec["messages"] if m["role"] == "system")
    assert sys_msg["content"] == long_sys
    assert "system_prompt_full" not in rec
