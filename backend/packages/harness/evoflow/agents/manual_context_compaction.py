"""Manual context compaction for Gateway API (same engine as model-call middleware)."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

from langchain_core.messages import BaseMessage

from evoflow.agents.context_compaction_core import compaction_token_snapshot
from evoflow.agents.context_compaction_core import get_context_compaction_engine, is_conversation_summary_human
from evoflow.agents.middlewares.context_compaction_middleware import build_ephemeral_model_messages
from evoflow.agents.middlewares.session_transcript_hydration_middleware import (
    lead_transcript_rows_to_lc_messages,
)
from evoflow.config.summarization_config import get_summarization_config
from evoflow.persistence.chat_message_repositories import (
    list_lead_chat_rows_for_model_hydration,
)
from evoflow.persistence.session_context_usage import build_context_usage_snapshot
from evoflow.utils.model_context_length import resolve_model_context_length

logger = logging.getLogger(__name__)


class ManualCompactionError(Exception):
    """User-facing manual compaction failure."""

    def __init__(self, message: str, *, status_code: int = 422) -> None:
        super().__init__(message)
        self.status_code = status_code


@dataclass(frozen=True)
class ManualCompactionResult:
    ok: bool
    changed: bool
    reason: str
    before_gate_tokens: int
    after_gate_tokens: int
    before_message_count: int
    after_message_count: int
    context_usage: dict[str, Any]
    persisted_summary: bool


class _ManualCompactionRuntime:
    """Minimal Runtime stand-in for compaction helpers."""

    __slots__ = ("context",)

    def __init__(self, *, thread_id: str, session_key: str, model_name: str | None) -> None:
        self.context = {
            "thread_id": thread_id,
            "session_key": session_key,
            "model_name": model_name,
        }


def _resolve_session_model_name(row: dict[str, Any] | None) -> str | None:
    if not row:
        return None
    for key in ("modelName", "model_name", "primaryModelName", "primary_model_name"):
        val = str(row.get(key) or "").strip()
        if val:
            return val
    ctx = row.get("context")
    if isinstance(ctx, dict):
        for key in ("model_name", "primary_model_name"):
            val = str(ctx.get(key) or "").strip()
            if val:
                return val
    return None


async def run_manual_context_compaction(
    session_key: str,
    *,
    session_row: dict[str, Any] | None = None,
) -> ManualCompactionResult:
    sk = str(session_key or "").strip()
    if not sk:
        raise ManualCompactionError("session_key required")

    row = session_row
    if row is None:
        from evoflow.persistence.session_repositories import get_session_row_for_ui

        row = get_session_row_for_ui(sk)
    if not row:
        raise ManualCompactionError("session not found", status_code=404)

    if not get_summarization_config().enabled:
        raise ManualCompactionError("context compaction is disabled")

    thread_id = str(row.get("threadId") or row.get("thread_id") or "").strip()
    if not thread_id:
        raise ManualCompactionError("session has no bound thread_id")

    rows = list_lead_chat_rows_for_model_hydration(sk)
    messages: list[BaseMessage] = lead_transcript_rows_to_lc_messages(rows)
    if len(messages) < 2:
        raise ManualCompactionError("not enough messages to compact")

    model_name = _resolve_session_model_name(row)
    context_length = resolve_model_context_length(model_name)
    runtime = _ManualCompactionRuntime(
        thread_id=thread_id,
        session_key=sk,
        model_name=model_name,
    )

    before = compaction_token_snapshot(messages, context_length=context_length)
    folded = await build_ephemeral_model_messages(messages, runtime, force=True)
    after_msgs = folded if folded is not None else messages
    after = compaction_token_snapshot(after_msgs, context_length=context_length)
    changed = folded is not None and (
        after["gate_tokens"] < before["gate_tokens"] or after["message_count"] < before["message_count"]
    )

    persisted_summary = False
    reason = "manual_compact"
    if changed and folded is not None:
        for msg in folded:
            if not is_conversation_summary_human(msg):
                continue
            content = getattr(msg, "content", None)
            if isinstance(content, str) and content.strip():
                result = get_context_compaction_engine().set_previous_summary(
                    thread_id,
                    content.strip(),
                    session_key=sk,
                    context_length=context_length,
                )
                persisted_summary = bool(result)
                break
    elif folded is None:
        reason = "no_op"

    saved = before["gate_tokens"] - after["gate_tokens"]
    context_usage = build_context_usage_snapshot(
        used_tokens=after["gate_tokens"],
        window_tokens=context_length,
        message_count=after["message_count"],
        before_tokens=before["gate_tokens"] if saved > 0 else None,
        compacted=saved > 0,
        note=reason,
    )

    if saved <= 0:
        from evoflow.persistence.session_context_usage import persist_session_context_usage

        persist_session_context_usage(sk, context_usage)

    logger.info(
        "[context-compaction] manual session=%s thread=%s changed=%s before=%d after=%d msgs=%d→%d persisted=%s",
        sk[:24],
        thread_id[:16],
        changed,
        before["gate_tokens"],
        after["gate_tokens"],
        before["message_count"],
        after["message_count"],
        persisted_summary,
    )

    return ManualCompactionResult(
        ok=True,
        changed=changed,
        reason=reason,
        before_gate_tokens=before["gate_tokens"],
        after_gate_tokens=after["gate_tokens"],
        before_message_count=before["message_count"],
        after_message_count=after["message_count"],
        context_usage=context_usage,
        persisted_summary=persisted_summary,
    )
