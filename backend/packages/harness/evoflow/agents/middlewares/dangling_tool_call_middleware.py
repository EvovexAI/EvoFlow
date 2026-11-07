"""Middleware to fix mismatched tool_call / tool_result pairs before the LLM call.

Vendors (OpenAI / Volc Ark ``11148``) reject histories where:

- an AIMessage ``tool_calls`` entry has no matching ToolMessage, or
- a ToolMessage ``tool_call_id`` has no matching AIMessage tool_call, or
- tool results are not **immediately after** the assistant ``tool_calls`` message
  (``insufficient tool messages following tool_calls message``)

Common causes: user interrupt, cancelled runs, compaction folding a Human/summary
between an AIMessage and its ToolMessages, or transcript hydration gaps.

This middleware patches ``request.messages`` (not only state) via
``wrap_model_call`` so results land immediately after each AIMessage with
``tool_calls``.
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


def _msg_tool_call_id(msg: object) -> str:
    return str(getattr(msg, "tool_call_id", "") or "").strip()


def sanitize_tool_call_pairs(messages: list) -> list | None:
    """Return a patched message list, or None when already well-formed.

    - Drops ToolMessages whose tool_call_id is not referenced by any AIMessage
    - Ensures every AIMessage ``tool_calls`` is followed by ToolMessages for each id
      (pulls late results forward; stubs still-missing ids)
    """
    surviving_call_ids: set[str] = set()
    for msg in messages:
        if getattr(msg, "type", None) != "ai":
            continue
        for tc in getattr(msg, "tool_calls", None) or []:
            tc_id = _tool_call_id(tc)
            if tc_id:
                surviving_call_ids.add(tc_id)

    # Index first ToolMessage per id (for pulling late results forward).
    first_tool_by_id: dict[str, ToolMessage] = {}
    for msg in messages:
        if not isinstance(msg, ToolMessage):
            continue
        cid = _msg_tool_call_id(msg)
        if cid and cid not in first_tool_by_id:
            first_tool_by_id[cid] = msg

    orphaned = {cid for cid in first_tool_by_id if cid not in surviving_call_ids}

    # Detect adjacency gaps: AI tool_calls not followed by a complete consecutive
    # ToolMessage run covering every id (even if the results exist later).
    adjacency_broken = False
    missing_ids: set[str] = set()
    for i, msg in enumerate(messages):
        if getattr(msg, "type", None) != "ai":
            continue
        tool_calls = getattr(msg, "tool_calls", None) or []
        expected = [_tool_call_id(tc) for tc in tool_calls]
        expected = [cid for cid in expected if cid]
        if not expected:
            continue
        expected_set = set(expected)
        j = i + 1
        adjacent: set[str] = set()
        while j < len(messages) and isinstance(messages[j], ToolMessage):
            cid = _msg_tool_call_id(messages[j])
            if cid in expected_set:
                adjacent.add(cid)
            j += 1
        still_missing = expected_set - adjacent
        if still_missing:
            missing_ids |= still_missing
            # Results exist later but not adjacent → still a vendor reject.
            if still_missing & set(first_tool_by_id) or still_missing - set(first_tool_by_id):
                adjacency_broken = True

    if not orphaned and not missing_ids and not adjacency_broken:
        return None

    consumed_tool_ids: set[str] = set()
    patched: list = []
    stub_count = 0
    pulled_count = 0

    for msg in messages:
        if isinstance(msg, ToolMessage):
            cid = _msg_tool_call_id(msg)
            if cid in orphaned:
                continue
            # Already placed immediately after its AIMessage (pulled or adjacent).
            if cid in consumed_tool_ids:
                continue
            # Defer: will be pulled forward when we hit the owning AIMessage.
            if cid in surviving_call_ids:
                continue
            patched.append(msg)
            continue

        patched.append(msg)
        if getattr(msg, "type", None) != "ai":
            continue
        tool_calls = getattr(msg, "tool_calls", None) or []
        for tc in tool_calls:
            tc_id = _tool_call_id(tc)
            if not tc_id or tc_id in consumed_tool_ids:
                continue
            existing = first_tool_by_id.get(tc_id)
            if existing is not None:
                patched.append(existing)
                pulled_count += 1
            else:
                patched.append(
                    ToolMessage(
                        content=_INTERRUPTED_STUB,
                        tool_call_id=tc_id,
                        name=_tool_call_name(tc),
                        status="error",
                    )
                )
                stub_count += 1
            consumed_tool_ids.add(tc_id)

    # Already well-formed (same object sequence) — nothing to patch.
    if len(patched) == len(messages) and all(a is b for a, b in zip(patched, messages, strict=True)):
        return None

    logger.warning(
        "Tool-pair sanitize: dropped_orphans=%d stubbed_missing=%d placed_results=%d",
        len(orphaned),
        stub_count,
        pulled_count,
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
