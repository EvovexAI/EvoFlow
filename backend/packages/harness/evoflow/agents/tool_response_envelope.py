"""Structured tool completion metadata (avoid inferring failures from loose text).

Tools may return JSON strings that include a framework-owned key ``_evoflow_tool``.
``ToolErrorHandlingMiddleware`` reads this first; string heuristics are only fallback.

Recommended for new/edited tools::

    return tool_result_json_ok("plain result")
    return tool_result_json_error("validation failed", error_type="ValidationError")

Plain strings remain supported; ambiguous phrases are no longer relied on when
tools adopt the envelope.
"""

from __future__ import annotations

import json
from typing import Any, Literal

# Namespace under private-style key so normal tool payloads rarely collide.
EVOFLOW_TOOL_META_KEY = "_evoflow_tool"


def tool_result_json_ok(
    payload: str | dict[str, Any],
    *,
    content_key: str = "content",
) -> str:
    """Successful tool return as JSON string (includes explicit ``status: ok``)."""
    if isinstance(payload, dict):
        out = dict(payload)
        meta = dict(out.get(EVOFLOW_TOOL_META_KEY) or {}) if isinstance(out.get(EVOFLOW_TOOL_META_KEY), dict) else {}
        meta["status"] = "ok"
        out[EVOFLOW_TOOL_META_KEY] = meta
        return json.dumps(out, ensure_ascii=False, default=str)
    return json.dumps(
        {
            EVOFLOW_TOOL_META_KEY: {"status": "ok"},
            content_key: payload,
        },
        ensure_ascii=False,
        default=str,
    )


def tool_result_json_error(
    message: str,
    *,
    error_type: str | None = None,
    extra: dict[str, Any] | None = None,
    content_key: str = "content",
) -> str:
    """Failed tool return as JSON string (middleware logs ``status=error`` reliably)."""
    meta: dict[str, Any] = {"status": "error", "message": message}
    if error_type:
        meta["error_type"] = error_type
    base: dict[str, Any] = dict(extra) if extra else {}
    base[EVOFLOW_TOOL_META_KEY] = meta
    # Avoid duplicating the same error string in ``content`` when structured extra fields are present.
    if content_key not in base and not base:
        base[content_key] = message
    return json.dumps(base, ensure_ascii=False, default=str)


def parse_tool_envelope(content: Any) -> dict[str, Any] | None:
    """Return ``_evoflow_tool`` meta dict if present and carries ``status``, else None."""
    if content is None:
        return None
    if isinstance(content, dict):
        meta = content.get(EVOFLOW_TOOL_META_KEY)
        return meta if isinstance(meta, dict) and meta.get("status") is not None else None
    if isinstance(content, str):
        s = content.strip()
        if len(s) < 2 or s[0] != "{":
            return None
        try:
            obj = json.loads(s)
        except json.JSONDecodeError:
            return None
        if not isinstance(obj, dict):
            return None
        meta = obj.get(EVOFLOW_TOOL_META_KEY)
        if isinstance(meta, dict) and meta.get("status") is not None:
            return meta
        # MediaToolResponse and similar: top-level ``ok`` boolean
        if "ok" in obj and isinstance(obj.get("ok"), bool):
            st = "error" if obj["ok"] is False else "ok"
            if st == "error" and str(obj.get("status") or "").lower() in ("error", "failed"):
                pass
            elif st == "ok" and str(obj.get("status") or "").lower() in ("error", "failed"):
                st = "error"
            msg = obj.get("message")
            return {"status": st, "message": str(msg) if msg is not None else ""}
        return None
    # list / other multimodal chunks: no envelope here
    return None


def envelope_status_kind(meta: dict[str, Any]) -> Literal["ok", "error", "unknown"]:
    st = str(meta.get("status") or "").strip().lower()
    if st in ("ok", "success"):
        return "ok"
    if st in ("error", "failed", "fail"):
        return "error"
    return "unknown"
