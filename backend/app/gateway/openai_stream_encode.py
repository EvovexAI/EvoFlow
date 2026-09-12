"""Encode standard OpenAI ``chat.completion.chunk`` SSE frames."""

from __future__ import annotations

import json
import time
import uuid
from typing import Any


def new_completion_id() -> str:
    return f"chatcmpl-{uuid.uuid4().hex[:24]}"


def encode_openai_chunk(
    completion_id: str,
    delta: dict[str, Any],
    *,
    finish_reason: str | None = None,
    model: str = "evoflow",
) -> bytes:
    payload: dict[str, Any] = {
        "id": completion_id,
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "model": model,
        "choices": [
            {
                "index": 0,
                "delta": delta,
                "finish_reason": finish_reason,
            }
        ],
    }
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    return f"data: {body}\n\n".encode()


def encode_openai_done() -> bytes:
    return b"data: [DONE]\n\n"


def encode_meta_event(payload: dict[str, Any]) -> bytes:
    """Side-channel UI metadata (thread_state, usage, tool_result, run_end, …)."""
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    return f"event: meta\ndata: {body}\n\n".encode()


def decode_sse_payload(raw: bytes) -> dict[str, Any] | None:
    text = raw.decode("utf-8", errors="ignore")
    for line in text.splitlines():
        if line.startswith("data:"):
            data_raw = line[5:].strip()
            if not data_raw or data_raw == "[DONE]":
                return None
            try:
                parsed = json.loads(data_raw)
            except json.JSONDecodeError:
                return None
            return parsed if isinstance(parsed, dict) else None
    return None


def decode_evf_payload(raw: bytes) -> dict[str, Any] | None:
    text = raw.decode("utf-8", errors="ignore")
    for line in text.splitlines():
        if line.startswith("data:"):
            data_raw = line[5:].strip()
            if not data_raw:
                return None
            try:
                parsed = json.loads(data_raw)
            except json.JSONDecodeError:
                return None
            return parsed if isinstance(parsed, dict) else None
    return None
