"""Middleware to fix mismatched tool_call / tool_result pairs before the LLM call.

Vendors (e.g. Volc Ark ``11148``) reject histories where:

- an AIMessage ``tool_calls`` entry has no matching ToolMessage, or
- a ToolMessage ``tool_call_id`` has no matching AIMessage tool_call

Common causes: user interrupt, cancelled runs, compaction dropping the AIMessage
while leaving results, or transcript hydration gaps.

This middleware patches ``request.messages`` (not only state) via
``wrap_model_call`` so stubs land immediately after each dangling AIMessage.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable

try:
    from typing import override
except ImportError:  # pragma: no cover
    from typing import override  # type: ignore

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain.agents.middleware.types import ModelCallResult, ModelRequest, ModelResponse
from langchain_core.messages import ToolMessage

logger = logging.getLogger(__name__)

_INTERRUPTED_STUB = "[Tool call was interrupted and did not return a result.]"


def _tool_call_id(tc: object) -> str:
    if isinstance(tc, dict):
        return str(tc.get("id") or "").strip()
    return str(getattr(tc, "id", "") or "").strip()


def _tool_call_name(tc: object) -> str:
    if isinstance(tc, dict):
        return str(tc.get("name") or "unknown")
    return str(getattr(tc, "name", "") or "unknown")


def sanitize_tool_call_pairs(messages: list) -> list | None:
    """Return a patched message list, or None when already well-formed.

    - Drops ToolMessages whose tool_call_id is not referenced by any AIMessage
    - Inserts stub ToolMessages for AIMessage tool_calls missing a result
    """
    surviving_call_ids: set[str] = set()
    for msg in messages:
        if getattr(msg, "type", None) != "ai":
            continue
        for tc in getattr(msg, "tool_calls", None) or []:
            tc_id = _tool_call_id(tc)
            if tc_id:
                surviving_call_ids.add(tc_id)

    result_call_ids: set[str] = set()
    for msg in messages:
        if isinstance(msg, ToolMessage):
            cid = str(getattr(msg, "tool_call_id", "") or "").strip()
            if cid:
                result_call_ids.add(cid)

    orphaned = result_call_ids - surviving_call_ids
    missing = surviving_call_ids - result_call_ids
    if not orphaned and not missing:
        return None

    without_orphans = [
        msg
        for msg in messages
        if not (
            isinstance(msg, ToolMessage)
            and str(getattr(msg, "tool_call_id", "") or "").strip() in orphaned
        )
    ]

    if not missing:
        logger.warning("Dropped %d orphan ToolMessage(s) with no matching tool_call", len(orphaned))
        return without_orphans

    patched: list = []
    patched_ids: set[str] = set()
    stub_count = 0
    for msg in without_orphans:
        patched.append(msg)
        if getattr(msg, "type", None) != "ai":
            continue
        for tc in getattr(msg, "tool_calls", None) or []:
            tc_id = _tool_call_id(tc)
            if tc_id and tc_id in missing and tc_id not in patched_ids:
                patched.append(
                    ToolMessage(
                        content=_INTERRUPTED_STUB,
                        tool_call_id=tc_id,
                        name=_tool_call_name(tc),
                        status="error",
                    )
                )
                patched_ids.add(tc_id)
                stub_count += 1

    logger.warning(
        "Tool-pair sanitize: dropped_orphans=%d stubbed_missing=%d",
        len(orphaned),
        stub_count,
    )
    return patched


class DanglingToolCallMiddleware(AgentMiddleware[AgentState]):
    """Sanitize tool_call / tool_result pairs on ``request.messages`` before the model."""

    def _build_patched_messages(self, messages: list) -> list | None:
        return sanitize_tool_call_pairs(messages)

    @override
    def wrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], ModelResponse],
    ) -> ModelCallResult:
        patched = self._build_patched_messages(request.messages)
        if patched is not None:
            request = request.override(messages=patched)
        return handler(request)

    @override
    async def awrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], Awaitable[ModelResponse]],
    ) -> ModelCallResult:
        patched = self._build_patched_messages(request.messages)
        if patched is not None:
            request = request.override(messages=patched)
        return await handler(request)
