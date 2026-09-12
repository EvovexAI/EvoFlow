"""Detect real API / runtime errors inside stored model ``response_json``."""

from __future__ import annotations

import json
from typing import Any


def _parse_response_dict(response_json: Any) -> dict[str, Any] | None:
    if not response_json:
        return None
    try:
        resp = json.loads(response_json) if isinstance(response_json, str) else response_json
    except (json.JSONDecodeError, TypeError, ValueError):
        return None
    return resp if isinstance(resp, dict) else None


def _string_looks_like_api_error(text: str) -> bool:
    lower = text.lower()
    needles = (
        "error",
        "exception",
        "timeout",
        "timed out",
        "failed",
        "invalid",
        "rate limit",
        "unauthorized",
        "forbidden",
        "bad request",
        "traceback",
        "upstream",
        "503",
        "502",
        "500",
        "429",
        "404",
    )
    if any(n in lower for n in needles):
        return True
    # Short single-line technical messages only; prose / markdown replies are not errors.
    if len(text) <= 120 and "\n" not in text and "**" not in text and "。" not in text:
        return True
    return False


def extract_response_error_message(resp: dict[str, Any]) -> str | None:
    """Return a human-readable error string, or ``None`` when ``error`` is absent or not a real failure."""
    err = resp.get("error")
    if err is None or err is False:
        return None
    if isinstance(err, dict):
        msg = str(err.get("message") or err.get("detail") or "").strip()
        typ = str(err.get("type") or err.get("code") or err.get("status") or "").strip()
        if not msg and not typ:
            return None
        if msg and typ:
            return f"{typ}: {msg}"
        return msg or typ
    if isinstance(err, str):
        text = err.strip()
        if not text:
            return None
        if not _string_looks_like_api_error(text):
            return None
        return text
    return str(err)


def extract_response_error_message_from_json(response_json: Any) -> str | None:
    resp = _parse_response_dict(response_json)
    if resp is None:
        return None
    return extract_response_error_message(resp)


def response_json_indicates_error(response_json: Any) -> bool:
    return extract_response_error_message_from_json(response_json) is not None
