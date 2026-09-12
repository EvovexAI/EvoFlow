"""Encode AG-UI protocol events as SSE frames (``event: ag-ui``)."""

from __future__ import annotations

import json
from typing import Any


def encode_agui_event(event: dict[str, Any]) -> bytes:
    body = json.dumps(event, ensure_ascii=False, separators=(",", ":"))
    return f"event: ag-ui\ndata: {body}\n\n".encode()


def decode_agui_payload(raw: bytes) -> dict[str, Any] | None:
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
