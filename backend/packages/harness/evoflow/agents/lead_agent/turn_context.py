"""Legacy turn-context helpers (injection disabled — conversation messages are authoritative)."""

from __future__ import annotations

from typing import Any

_COMPACTION_MARKERS = (
    "[CONTEXT COMPACTION",
    "[上下文摘要",
    "[深度压缩摘要",
)


def _message_type(msg: Any) -> str:
    return str(getattr(msg, "type", None) or "").strip().lower()


def _text_from_content(content: Any) -> str:
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict):
                if block.get("type") == "text" and isinstance(block.get("text"), str):
                    parts.append(block["text"])
                elif isinstance(block.get("text"), str):
                    parts.append(block["text"])
        return "\n".join(parts).strip()
    return str(content or "").strip()


def _is_compaction_text(text: str) -> bool:
    head = (text or "").strip()
    if not head:
        return False
    upper = head.upper()
    return any(head.startswith(m) or upper.startswith(m.upper()) for m in _COMPACTION_MARKERS)


def _tool_call_names(msg: Any) -> list[str]:
    names: list[str] = []
    for tc in getattr(msg, "tool_calls", None) or []:
        if isinstance(tc, dict):
            n = tc.get("name") or (tc.get("function") or {}).get("name")
        else:
            n = getattr(tc, "name", None)
        if n:
            names.append(str(n))
    return names


def extract_last_assistant_preview(messages: list[Any], *, max_chars: int = 1500) -> str:
    """Text from the last assistant message before the latest user turn."""
    if not messages:
        return ""

    human_idx = -1
    for i in range(len(messages) - 1, -1, -1):
        if _message_type(messages[i]) in {"human", "user"}:
            human_idx = i
            break

    search_end = human_idx if human_idx >= 0 else len(messages)
    for i in range(search_end - 1, -1, -1):
        msg = messages[i]
        if _message_type(msg) not in {"ai", "assistant"}:
            continue
        text = _text_from_content(getattr(msg, "content", ""))
        if _is_compaction_text(text):
            continue
        name = getattr(msg, "name", None)
        if name and str(name).strip() in {"conversation_summary", "tool_history", "collab_phase_hint", "session_mind_map"}:
            continue
        tools = _tool_call_names(msg)
        if text:
            return text[:max_chars]
        if tools:
            joined = ", ".join(tools[:12])
            suffix = " …" if len(tools) > 12 else ""
            return f"[上轮主要为工具调用: {joined}{suffix}]"[:max_chars]
    return ""


def build_turn_context_section(
    *,
    user_question: str = "",
    last_assistant_summary: str = "",
    prompt_language: str | None = None,
) -> str:
    """Deprecated: user/assistant turns live in message history; do not duplicate in system prompt."""
    _ = (user_question, last_assistant_summary, prompt_language)
    return ""
