"""Shared helpers for reading ``ModelRequest`` message lists in live-footer middlewares.

Prefer ``request.messages`` when already patched by an earlier middleware. Preferring
the longer ``state.messages`` reintroduces checkpoint noise (empty Human rows,
stale ephemeral footers) that outer middlewares already stripped.
"""

from __future__ import annotations

from typing import Any

from langchain.agents.middleware.types import ModelRequest
from langchain_core.messages import BaseMessage, HumanMessage


def messages_from_model_request(request: ModelRequest) -> list[BaseMessage]:
    """Return message list for the upcoming model call.

    Prefer ``request.messages`` when present (may already be stripped/appended by
    earlier wrap_model_call middlewares). Fall back to ``state.messages``.
    """
    req_msgs: list[Any] = list(request.messages or []) if getattr(request, "messages", None) else []
    if req_msgs:
        return [m for m in req_msgs if isinstance(m, BaseMessage)]
    state_msgs: list[Any] = (
        list((request.state or {}).get("messages") or []) if isinstance(request.state, dict) else []
    )
    return [m for m in state_msgs if isinstance(m, BaseMessage)]


def _human_plain_text(content: Any) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict):
                t = block.get("text")
                if isinstance(t, str):
                    parts.append(t)
        return "\n".join(parts)
    return str(content)


def _human_has_non_text_parts(content: Any) -> bool:
    if not isinstance(content, list):
        return False
    for block in content:
        if not isinstance(block, dict):
            continue
        typ = str(block.get("type") or "").strip().lower()
        if typ in {"image", "image_url", "input_image", "file", "input_file", "audio", "input_audio"}:
            return True
        if block.get("source") or block.get("image_url") or block.get("file"):
            return True
    return False


def is_blank_unnamed_human_message(msg: Any) -> bool:
    """True for unnamed HumanMessage with no usable text and no media parts."""
    if not isinstance(msg, HumanMessage):
        return False
    if getattr(msg, "name", None):
        return False
    content = getattr(msg, "content", None)
    if _human_has_non_text_parts(content):
        return False
    return not _human_plain_text(content).strip()


def strip_blank_unnamed_human_messages(messages: list[Any]) -> list[Any]:
    return [m for m in messages if not is_blank_unnamed_human_message(m)]
