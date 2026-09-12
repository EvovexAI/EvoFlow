"""Per-invocation dynamic prompt metadata (``make_lead_agent`` → model middleware)."""

from __future__ import annotations

from contextvars import ContextVar
from typing import Any

_DYNAMIC_PROMPT_META: ContextVar[dict[str, Any] | None] = ContextVar("evf_dynamic_prompt_meta", default=None)


def bind_dynamic_prompt_meta(meta: dict[str, Any]) -> None:
    """Called from ``make_lead_agent`` each run so middleware can rebuild the system prompt."""
    _DYNAMIC_PROMPT_META.set(dict(meta))


def get_bound_dynamic_prompt_meta() -> dict[str, Any] | None:
    raw = _DYNAMIC_PROMPT_META.get()
    if isinstance(raw, dict) and raw:
        return raw
    return None
