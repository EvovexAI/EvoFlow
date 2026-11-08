"""Ephemeral live footer: active session child works (subagent / collab / duty / bash).

Cheap path: one indexed ``active_only`` SELECT (LIMIT 8). Empty → no patch.
Stripped and rebuilt each ``wrap_model_call`` (not checkpointed).

Opt out: ``EVOFLOW_CHILD_WORKS_LIVE_FOOTER=0`` (default on).
"""

from __future__ import annotations

import os
from typing import Any

try:
    from typing import override
except ImportError:
    from typing import override

import logging

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain.agents.middleware.types import ModelCallResult, ModelRequest
from langchain_core.messages import BaseMessage, HumanMessage, SystemMessage, ToolMessage

logger = logging.getLogger(__name__)

_CHILD_WORKS_LIVE_NAME = "session_child_works_live"
_KIND_LABEL = {
    "subagent": "subagent",
    "collab_subtask": "workflow-node",
    "workflow": "workflow",
    "duty": "employee",
    "warm_bash": "session-shell",
}


def _env_bool(name: str, default: bool) -> bool:
    raw = (os.getenv(name) or "").strip().lower()
    if not raw:
        return default
    return raw in {"1", "true", "yes", "on"}


def _is_child_works_live_message(msg: Any) -> bool:
    return isinstance(msg, (HumanMessage, SystemMessage, ToolMessage)) and getattr(msg, "name", None) == _CHILD_WORKS_LIVE_NAME


def _strip_child_works_live(messages: list[Any]) -> list[Any]:
    return [m for m in messages if not _is_child_works_live_message(m)]


def _messages_from_request(request: ModelRequest) -> list[BaseMessage]:
    from evoflow.agents.middlewares.model_request_messages import messages_from_model_request

    return messages_from_model_request(request)


def _session_key_from_request(request: ModelRequest) -> str:
    ctx = request.runtime.context if isinstance(request.runtime.context, dict) else {}
    sk = str(ctx.get("session_key") or "").strip()
    if sk:
        return sk
    tid = str(ctx.get("thread_id") or "").strip()
    if not tid:
        return ""
    try:
        from evoflow.persistence.session_runtime_repository import resolve_session_key

        return resolve_session_key(thread_id=tid, parent_thread_id=tid)
    except Exception:
        return ""


def _build_appendix(works: list[dict[str, Any]]) -> str:
    lines = [
        "<session_child_works_live>",
        "Background work still running under this session (do not busy-poll; you will get "
        "<task-notification> or a next-turn notice when each finishes):",
    ]
    for w in works:
        kind = str(w.get("kind") or "").strip()
        label = _KIND_LABEL.get(kind, kind or "work")
        title = str(w.get("title") or label).strip()[:80]
        status = str(w.get("status") or "running").strip()
        ref = str(w.get("ref_id") or w.get("work_id") or "").strip()[:64]
        lines.append(f"- [{label}] {title} status={status} id={ref}")
    lines.append("</session_child_works_live>")
    return "\n".join(lines)


class SessionChildWorksLiveFooterMiddleware(AgentMiddleware[AgentState]):
    """Append active child-work snapshot at message tail when any are running."""

    state_schema = AgentState

    def _patch_request(self, request: ModelRequest) -> ModelRequest:
        if not _env_bool("EVOFLOW_CHILD_WORKS_LIVE_FOOTER", True):
            return request

        raw_messages = _messages_from_request(request)
        messages = _strip_child_works_live(raw_messages)
        stripped_only = len(messages) != len(raw_messages)

        sk = _session_key_from_request(request)
        if not sk:
            return request.override(messages=messages) if stripped_only else request

        works: list[dict[str, Any]] = []
        try:
            from evoflow.persistence.session_runtime_repository import list_child_works

            works = list_child_works(sk, active_only=True, limit=8)
        except Exception:
            logger.debug("SessionChildWorksLiveFooter: list failed", exc_info=True)
            return request.override(messages=messages) if stripped_only else request

        if not works:
            return request.override(messages=messages) if stripped_only else request

        try:
            hint = HumanMessage(content=_build_appendix(works), name=_CHILD_WORKS_LIVE_NAME)
            return request.override(messages=[*messages, hint])
        except Exception:
            logger.debug("SessionChildWorksLiveFooter: patch failed", exc_info=True)
            return request.override(messages=messages) if stripped_only else request

    @override
    def wrap_model_call(self, request: ModelRequest, handler) -> ModelCallResult:
        return handler(self._patch_request(request))

    @override
    async def awrap_model_call(self, request: ModelRequest, handler) -> ModelCallResult:
        return await handler(self._patch_request(request))
