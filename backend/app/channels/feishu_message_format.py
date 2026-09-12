"""Format agent payloads for Feishu IM (avoid raw JSON blobs for ask_clarification)."""

from __future__ import annotations

import json
from typing import Any


def _as_str(v: Any) -> str:
    return str(v).strip() if v is not None else ""


def _option_label(item: Any) -> str:
    if isinstance(item, str):
        return item.strip()
    if isinstance(item, dict):
        lab = item.get("label") or item.get("text") or item.get("title")
        return _as_str(lab)
    return ""


def format_ask_clarification_payload_for_feishu(payload: Any) -> str | None:
    """Build short Markdown for Feishu from ask_clarification tool args / JSON body."""
    obj: dict[str, Any] | None = None
    if isinstance(payload, dict):
        obj = payload
    elif isinstance(payload, str):
        s = payload.strip()
        if not s:
            return None
        if not s.startswith("{"):
            return None
        try:
            parsed = json.loads(s)
        except json.JSONDecodeError:
            return None
        if isinstance(parsed, dict):
            obj = parsed
        else:
            return None
    else:
        return None

    if not obj:
        return None

    # Heuristic: only rewrite when it looks like clarification schema
    hint_keys = frozenset(obj.keys()) & frozenset({"question", "questions", "options", "clarification_type", "title", "context"})
    if not hint_keys:
        return None

    lines: list[str] = ["❔ **需要您确认 / 选择**", ""]

    title = _as_str(obj.get("title"))
    if title:
        lines.append(f"**{title}**")
        lines.append("")

    ctype = _as_str(obj.get("clarification_type"))
    if ctype:
        lines.append(f"_类型：{ctype}_")
        lines.append("")

    questions = obj.get("questions")
    if isinstance(questions, list) and questions:
        for i, q in enumerate(questions, start=1):
            if not isinstance(q, dict):
                continue
            prompt = _as_str(q.get("prompt"))
            ctx = _as_str(q.get("context"))
            if ctx:
                lines.append(ctx)
            if prompt:
                lines.append(f"**{i}.** {prompt}")
            opts = q.get("options")
            if isinstance(opts, list) and opts:
                lines.append("")
                for j, opt in enumerate(opts, start=1):
                    lab = _option_label(opt)
                    if lab:
                        lines.append(f"- {j}. {lab}")
            lines.append("")
    else:
        ctx = _as_str(obj.get("context"))
        q = _as_str(obj.get("question"))
        if ctx:
            lines.append(ctx)
            lines.append("")
        if q:
            lines.append(f"**{q}**")
            lines.append("")
        opts = obj.get("options")
        if isinstance(opts, list) and opts:
            for j, opt in enumerate(opts, start=1):
                lab = _option_label(opt)
                if lab:
                    lines.append(f"- {j}. {lab}")
            lines.append("")

    while lines and lines[-1] == "":
        lines.pop()

    lines.append("")
    lines.append("---")
    lines.append("在 **EvoPanel 桌面端** 该对话侧栏点选即可继续；也可在本群直接回复你的选择（助手会尽量理解）。")

    body = "\n".join(lines).strip()
    return body or None


def feishu_outbound_text(text: str) -> str:
    """If outbound text is a raw ask_clarification JSON string, replace with Markdown."""
    raw = text or ""
    s = raw.strip()
    if len(s) < 2 or s[0] != "{":
        return raw
    # Fast reject: huge blobs stay as-is (avoid slow parse)
    if len(s) > 120_000:
        return raw
    formatted = format_ask_clarification_payload_for_feishu(s)
    return formatted if formatted else raw


def maybe_format_tool_message_content_for_im(name: str | None, content: Any) -> str | None:
    """For LangGraph tool messages: return formatted text, or None to keep default handling."""
    if str(name or "").strip().lower() != "ask_clarification":
        return None
    if isinstance(content, (dict, list)):
        try:
            dumped = json.dumps(content, ensure_ascii=False)
        except (TypeError, ValueError):
            return None
        return format_ask_clarification_payload_for_feishu(dumped)
    if isinstance(content, str):
        return format_ask_clarification_payload_for_feishu(content)
    return None
