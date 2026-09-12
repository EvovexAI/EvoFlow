"""Single JSON blob for transcript message bodies (``evoflow_chat_messages.content_json``).

Scalar columns (tokens, run_id, tool_call_id, …) stay on the row; model/UI body lives here:

``{"content": str|blocks, "tool_calls"?: [...], "reasoning"?: str, "ui"?: {...}}``
"""

from __future__ import annotations

import json
from typing import Any

_EMPTY: dict[str, Any] = {"content": ""}


def dumps_payload(payload: dict[str, Any]) -> str:
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


def loads_payload(raw: str | None) -> dict[str, Any]:
    if not raw or not str(raw).strip():
        return dict(_EMPTY)
    try:
        parsed = json.loads(raw)
    except Exception:
        return {"content": str(raw)}
    return parsed if isinstance(parsed, dict) else {"content": parsed}


def _content_blocks_have_text(content: Any) -> bool:
    if isinstance(content, str):
        return bool(content.strip())
    if isinstance(content, list):
        return any(
            (isinstance(block, str) and block.strip())
            or (
                isinstance(block, dict)
                and block.get("type") == "text"
                and str(block.get("text") or "").strip()
            )
            for block in content
        )
    return bool(content)


def _message_fields_as_dict(msg: Any) -> dict[str, Any]:
    if isinstance(msg, dict):
        return msg
    src: dict[str, Any] = {}
    ak = getattr(msg, "additional_kwargs", None)
    if ak is not None:
        src["additional_kwargs"] = ak
    content = getattr(msg, "content", None)
    if content is not None:
        src["content"] = content
    reasoning = getattr(msg, "reasoning", None)
    if reasoning is not None:
        src["reasoning"] = reasoning
    return src


def ai_message_has_reasoning(msg: Any) -> bool:
    """True when a message carries thinking / reasoning text (incl. ``reasoning_content``)."""
    return _pick_reasoning(_message_fields_as_dict(msg)) is not None


def ai_message_has_visible_output(msg: Any) -> bool:
    """True when an AIMessage has content, tool calls, or reasoning worth treating as non-empty."""
    if msg is None:
        return False
    if isinstance(msg, dict):
        tool_calls = msg.get("tool_calls") or msg.get("toolCalls")
        content = msg.get("content")
    else:
        tool_calls = getattr(msg, "tool_calls", None)
        content = getattr(msg, "content", None)
    if tool_calls:
        return True
    if _content_blocks_have_text(content):
        return True
    return ai_message_has_reasoning(msg)


def _pick_reasoning(src: dict[str, Any]) -> str | None:
    direct = src.get("reasoning")
    if isinstance(direct, str) and direct.strip():
        return direct.strip()[:8000]
    ak = src.get("additional_kwargs")
    if isinstance(ak, dict):
        rc = ak.get("reasoning_content")
        if isinstance(rc, str) and rc.strip():
            return rc.strip()[:8000]
    content = src.get("content")
    if isinstance(content, list):
        for part in content:
            if isinstance(part, dict) and part.get("type") == "thinking":
                t = part.get("thinking")
                if isinstance(t, str) and t.strip():
                    return t.strip()[:8000]
    return None


def _ui_from_src(src: dict[str, Any]) -> dict[str, Any]:
    ui = src.get("ui")
    return dict(ui) if isinstance(ui, dict) else {}


def pack_payload(
    *,
    role: str,
    content: Any = None,
    raw: dict[str, Any] | None = None,
    content_json: dict[str, Any] | str | None = None,
) -> dict[str, Any]:
    """Build the ``content_json`` object stored on a transcript row."""
    if isinstance(content_json, dict):
        return content_json
    if isinstance(content_json, str) and content_json.strip():
        loaded = loads_payload(content_json)
        if loaded:
            return loaded

    src = raw if isinstance(raw, dict) else {}
    if isinstance(content, dict) and any(k in content for k in ("content", "tool_calls", "reasoning", "ui")):
        return content

    body = content if content is not None else src.get("content")
    payload: dict[str, Any] = {"content": body if body is not None else ""}

    tool_calls = src.get("tool_calls") or src.get("toolCalls")
    if isinstance(tool_calls, list) and tool_calls:
        payload["tool_calls"] = tool_calls

    reasoning = _pick_reasoning(src)
    if reasoning:
        payload["reasoning"] = reasoning

    ui = _ui_from_src(src)
    if ui:
        payload["ui"] = ui

    return payload


def plain_text(payload: dict[str, Any]) -> str:
    """Plain text for dedupe / search / model fallback."""
    body = payload.get("content")
    if isinstance(body, str):
        text = body.strip()
        if text:
            return text
    if isinstance(body, list):
        parts: list[str] = []
        for item in body:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                if item.get("type") == "text" and isinstance(item.get("text"), str):
                    parts.append(item["text"])
                elif isinstance(item.get("text"), str):
                    parts.append(item["text"])
        joined = "\n".join(p for p in parts if p).strip()
        if joined:
            return joined
    reason = payload.get("reasoning")
    if isinstance(reason, str) and reason.strip():
        return reason.strip()
    return ""


def model_body_text(payload: dict[str, Any]) -> str:
    """Primary assistant/user text for model hydration."""
    return plain_text(payload)


def tool_calls(payload: dict[str, Any]) -> list[dict[str, Any]] | None:
    tc = payload.get("tool_calls")
    return tc if isinstance(tc, list) and tc else None


def reasoning_text(payload: dict[str, Any]) -> str:
    r = payload.get("reasoning")
    return str(r).strip() if isinstance(r, str) else ""


def tool_body_text(payload: dict[str, Any]) -> str:
    body = payload.get("content")
    if isinstance(body, str):
        return body
    if body is None:
        return ""
    return plain_text(payload)


def flatten_display_segments_text(segments: Any) -> str:
    if not segments:
        return ""
    try:
        segs = json.loads(segments) if isinstance(segments, str) else segments
    except Exception:
        return ""
    if not isinstance(segs, list):
        return ""
    parts: list[str] = []
    for seg in segs:
        if isinstance(seg, dict) and str(seg.get("kind") or "") == "text" and seg.get("text"):
            parts.append(str(seg["text"]))
    return "\n".join(parts).strip()
