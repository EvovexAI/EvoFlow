"""Tests for Volcengine ASR binary protocol helpers."""

from __future__ import annotations

import json

from app.gateway.speech.volcengine_asr_ws import _SER_JSON, _CMP_NONE, _decode_payload


def test_decode_payload_empty_json_body_returns_none() -> None:
    assert _decode_payload(_SER_JSON, _CMP_NONE, b"") is None
    assert _decode_payload(_SER_JSON, _CMP_NONE, b"   ") is None


def test_decode_payload_json_object() -> None:
    body = json.dumps({"ok": True}).encode("utf-8")
    assert _decode_payload(_SER_JSON, _CMP_NONE, body) == {"ok": True}
