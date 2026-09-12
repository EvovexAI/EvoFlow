"""Shared filtering of LangChain messages for long-term memory and external sync."""

from __future__ import annotations

import re
from copy import copy
from typing import Any

from evoflow.agents.message_analysis_utils import _message_type, is_real_user_message, latest_real_user_index

# Middleware-injected HumanMessages — must not be treated as real user input for
# long-term memory or external memory sync (see external_memory_plugin_middleware).
_SYNTHETIC_HUMAN_NAMES = frozenset(
    {
        "external_memory_prefetch",
        "todo_reminder",
    }
)


def format_message_plain_text(msg: Any) -> str:
    content = getattr(msg, "content", "")
    if isinstance(content, list):
        parts: list[str] = []
        for p in content:
            if isinstance(p, str):
                parts.append(p)
            elif isinstance(p, dict):
                text_val = p.get("text")
                if isinstance(text_val, str):
                    parts.append(text_val)
        return " ".join(parts) if parts else str(content)
    return str(content)


def _is_final_assistant_message(msg: Any) -> bool:
    if _message_type(msg) not in {"ai", "assistant"}:
        return False
    tool_calls = getattr(msg, "tool_calls", None)
    return not tool_calls


def _last_assistant_text_after_index(messages: list[Any], start_index: int) -> str | None:
    for i in range(len(messages) - 1, start_index, -1):
        msg = messages[i]
        if not _is_final_assistant_message(msg):
            continue
        text = format_message_plain_text(msg).strip()
        if text:
            return text
    return None


def extract_last_user_assistant_texts(messages: list[Any]) -> tuple[str, str] | None:
    """Last genuine user + final assistant text after that user turn."""
    user_idx = latest_real_user_index(messages)
    if user_idx < 0:
        return None
    last_u = format_message_plain_text(messages[user_idx]).strip()
    if not last_u:
        return None
    last_a = _last_assistant_text_after_index(messages, user_idx)
    if last_u and last_a:
        return last_u, last_a
    return None


def filter_messages_for_longterm_memory(messages: list[Any]) -> list[Any]:
    """Keep genuine user inputs and final assistant responses (see MemoryMiddleware docstring)."""
    _UPLOAD_BLOCK_RE = re.compile(r"<uploaded_files>[\s\S]*?</uploaded_files>\n*", re.IGNORECASE)

    filtered: list[Any] = []
    skip_next_ai = False
    for msg in messages:
        kind = _message_type(msg)

        if kind in {"human", "user"}:
            if getattr(msg, "name", None) in _SYNTHETIC_HUMAN_NAMES:
                continue
            if not is_real_user_message(msg):
                continue
            content_str = format_message_plain_text(msg)
            if "<uploaded_files>" in content_str:
                stripped = _UPLOAD_BLOCK_RE.sub("", content_str).strip()
                if not stripped:
                    skip_next_ai = True
                    continue
                clean_msg = copy(msg)
                clean_msg.content = stripped
                filtered.append(clean_msg)
                skip_next_ai = False
            else:
                filtered.append(msg)
                skip_next_ai = False
        elif kind in {"ai", "assistant"}:
            if not _is_final_assistant_message(msg):
                continue
            if skip_next_ai:
                skip_next_ai = False
                continue
            filtered.append(msg)

    return filtered


def describe_memory_message_shape(messages: list[Any]) -> str:
    """Short diagnostic summary for memory skip logs."""
    total = len(messages or [])
    real_user = sum(1 for m in messages or [] if is_real_user_message(m))
    human_named = sum(1 for m in messages or [] if _message_type(m) in {"human", "user"})
    ai_final = sum(1 for m in messages or [] if _is_final_assistant_message(m))
    pair = extract_last_user_assistant_texts(messages)
    pair_ok = "有" if pair else "无"
    return (
        f"总消息={total} human/user行={human_named} 真实用户={real_user} "
        f"最终AI={ai_final} 可整理轮次={pair_ok}"
    )
