"""Lightweight list-view projection for model invocations.

List endpoints must not ``SELECT`` ``request_json`` / ``response_json`` (each up to
512 KiB). Writers store ``message_count`` + ``response_summary_json`` here so the
Ops / session-debug lists stay fast.
"""

from __future__ import annotations

import json
from typing import Any


def compute_model_list_projection(
    *,
    request_json: str | None = None,
    response_json: str | None = None,
) -> tuple[int | None, str | None]:
    """Return ``(message_count, response_summary_json)`` for list columns."""
    # Lazy import: queries pulls sqlite_store; store calls us at write time.
    from evoflow.observability.queries import (
        _message_count_from_request_raw,
        _summarize_response_for_list,
    )

    message_count = _message_count_from_request_raw(request_json)
    summary: dict[str, Any] | None = None
    if response_json:
        try:
            resp_obj = json.loads(response_json) if isinstance(response_json, str) else response_json
            summary = _summarize_response_for_list(resp_obj)
        except (json.JSONDecodeError, TypeError, ValueError):
            summary = None
    summary_json = (
        json.dumps(summary, ensure_ascii=False, default=str) if isinstance(summary, dict) else None
    )
    return message_count, summary_json


def parse_stored_response_summary(raw: Any) -> dict[str, Any] | None:
    """Parse ``response_summary_json`` column into the list API shape."""
    if raw is None or raw == "":
        return None
    if isinstance(raw, dict):
        return raw
    try:
        obj = json.loads(str(raw))
    except (json.JSONDecodeError, TypeError, ValueError):
        return None
    return obj if isinstance(obj, dict) else None
