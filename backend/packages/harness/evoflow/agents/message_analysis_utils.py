"""Helpers for intent / mission analyzers: skip synthetic user rows."""

from __future__ import annotations

import hashlib
from typing import Any

from langchain_core.messages import HumanMessage

_SYNTHETIC_USER_NAMES = frozenset(
    {
        "conversation_summary",
        "tool_history",
        "todo_reminder",
        "collab_phase_hint",
        "external_memory_prefetch",
        "goal",
        "goal_controller",
        "hosted_autofollow",
        "task_autofollow",
    }
)


def _text_from_content(content: Any) -> str:
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict):
                text = block.get("text")
                if isinstance(text, str):
                    parts.append(text)
        return "\n".join(parts).strip()
    return str(content or "").strip()


def is_real_user_message(msg: Any) -> bool:
    """True for genuine user turns; false for compaction / tool-history / hint injections."""
    if isinstance(msg, HumanMessage):
        from evoflow.agents.context_compaction_core import is_compaction_message, is_tool_history_human

        if is_compaction_message(msg) or is_tool_history_human(msg):
            return False
        name = str(getattr(msg, "name", None) or "").strip()
        if name in _SYNTHETIC_USER_NAMES:
            return False
        return bool(_text_from_content(getattr(msg, "content", "")))
    if isinstance(msg, dict):
        role = str(msg.get("role") or msg.get("type") or "").strip().lower()
        if role not in {"human", "user"}:
            return False
        text = _text_from_content(msg.get("content"))
        if not text:
            return False
        lower = text.lower()
        if lower.startswith("here is a summary of the conversation to date"):
            return False
        if lower.startswith("here's a summary of the conversation to date"):
            return False
        markers = (
            "[CONTEXT COMPACTION",
            "[上下文摘要",
            "[深度压缩摘要",
            "[tool:history]",
            "[tool:summary]",
        )
        return not any(text.startswith(m) for m in markers)
    msg_type = str(getattr(msg, "type", None) or "").strip().lower()
    if msg_type not in {"human", "user"}:
        return False
    text = _text_from_content(getattr(msg, "content", ""))
    if not text:
        return False
    return not text.startswith("[CONTEXT COMPACTION")


def _message_type(msg: Any) -> str:
    if isinstance(msg, dict):
        return str(msg.get("type") or msg.get("role") or "").strip().lower()
    return str(getattr(msg, "type", None) or "").strip().lower()


def latest_real_user_index(messages: list[Any]) -> int:
    for i in range(len(messages or []) - 1, -1, -1):
        if is_real_user_message(messages[i]):
            return i
    return -1


def latest_real_user_turn_key(messages: list[Any]) -> str:
    """Stable id for the latest genuine user turn (message id or content hash)."""
    for m in reversed(messages or []):
        if not is_real_user_message(m):
            continue
        mid = str(getattr(m, "id", None) or "").strip()
        if mid:
            return mid
        text = _text_from_content(getattr(m, "content", ""))
        if text:
            return hashlib.sha256(text.encode("utf-8")).hexdigest()[:20]
    return ""


def is_first_model_response_after_user(messages: list[Any]) -> bool:
    """True immediately after the first assistant reply to the latest real user message."""
    idx = latest_real_user_index(messages)
    if idx < 0:
        return False
    tail = list(messages[idx + 1 :])
    if len(tail) != 1:
        return False
    return _message_type(tail[0]) in {"ai", "assistant"}


def resolve_transcript_messages_for_analysis(*, thread_id: str, runtime_messages: list[Any]) -> list[Any]:
    """Prefer ``evoflow_chat_messages`` transcript over checkpoint when available."""
    tid = str(thread_id or "").strip()
    if not tid:
        return list(runtime_messages or [])
    try:
        from evoflow.agents.middlewares.session_transcript_hydration_middleware import (
            lead_transcript_rows_to_lc_messages,
        )
        from evoflow.persistence.chat_message_repositories import list_lead_chat_rows_for_model_hydration
        from evoflow.persistence.session_repositories import find_session_key_by_thread_id

        session_key = find_session_key_by_thread_id(tid) or ""
        if not session_key:
            return list(runtime_messages or [])
        rows = list_lead_chat_rows_for_model_hydration(session_key)
        if not rows:
            return list(runtime_messages or [])
        db_lc = lead_transcript_rows_to_lc_messages(rows)
        return db_lc if db_lc else list(runtime_messages or [])
    except Exception:
        return list(runtime_messages or [])


def _user_question_from_configurable(cfg: dict[str, Any]) -> str:
    for key in ("evf_user_question", "user_message", "latest_user_message", "user_input"):
        raw = cfg.get(key)
        if isinstance(raw, str) and raw.strip():
            return raw.strip()
    return ""


def resolve_user_question_for_model_payload(
    original_messages: list[Any],
    *,
    thread_id: str | None = None,
    session_key: str | None = None,
    runtime_context: dict[str, Any] | None = None,
) -> str:
    """Best-effort user question when the serialized API payload lacks a user turn."""
    ctx = runtime_context if isinstance(runtime_context, dict) else {}
    for key in ("evf_user_question", "user_message", "latest_user_message", "user_input"):
        raw = ctx.get(key)
        if isinstance(raw, str) and raw.strip():
            return raw.strip()

    try:
        from langgraph.config import get_config

        cfg = get_config().get("configurable") or {}
        if isinstance(cfg, dict):
            from_cfg = _user_question_from_configurable(cfg)
            if from_cfg:
                return from_cfg
            sk_cfg = str(cfg.get("session_key") or "").strip()
            if sk_cfg and not session_key:
                session_key = sk_cfg
            tid_cfg = str(cfg.get("thread_id") or "").strip()
            if tid_cfg and not thread_id:
                thread_id = tid_cfg
    except Exception:
        pass

    idx = latest_real_user_index(original_messages)
    if idx >= 0:
        text = _text_from_content(getattr(original_messages[idx], "content", ""))
        if text:
            return text

    try:
        from evoflow.persistence.chat_message_repositories import latest_real_user_question_text

        db_text = latest_real_user_question_text(
            str(session_key or ""),
            thread_id=thread_id,
        )
        if db_text:
            return db_text
    except Exception:
        pass

    return "Continue."
