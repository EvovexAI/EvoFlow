"""Prune verbose monitor tool outputs from model context.

`supervisor(action="monitor_execution_step")` is often called in a loop. Each call
produces a ToolMessage whose JSON payload can be large (subtasks list, memory snapshot),
and those messages accumulate in the LangGraph `messages` list, increasing context size.

Prunes older monitor_execution_step ToolMessages from the model-visible ``messages``
context (UI transcript is in ``evoflow_chat_messages``, not checkpoint).
"""

from __future__ import annotations

import json
import logging
from typing import Any

try:
    from typing import override
except ImportError:
    from typing import override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import RemoveMessage, ToolMessage
from langgraph.runtime import Runtime

logger = logging.getLogger(__name__)


def _tool_message_action_and_task_id(msg: ToolMessage) -> tuple[str | None, str | None]:
    """Best-effort parse supervisor tool JSON output."""
    if str(getattr(msg, "name", "") or "").strip() != "supervisor":
        return None, None
    content = getattr(msg, "content", None)
    if not isinstance(content, str) or not content.strip():
        return None, None
    try:
        payload = json.loads(content)
    except Exception:
        return None, None
    if not isinstance(payload, dict):
        return None, None
    action = payload.get("action")
    task_id = payload.get("taskId") or payload.get("task_id")
    action_s = str(action).strip() if isinstance(action, str) else None
    task_s = str(task_id).strip() if isinstance(task_id, str) else None
    return action_s, task_s


class MonitorToolPruneMiddleware(AgentMiddleware[AgentState]):
    """Drop older ``monitor_execution_step`` ToolMessages from ``messages``.

    Note: ``SessionTranscriptHydrationMiddleware`` runs after this middleware and
    rewrites the LangGraph ``messages`` channel from ``evoflow_chat_messages``, so
    the primary prune happens inside ``list_lead_chat_rows_for_model_hydration``.
    This middleware stays as a defensive fallback for code paths (or future
    middlewares) that bypass the DB hydration step and operate on the runtime
    channel directly.
    """

    state_schema = AgentState

    def __init__(self, *, keep_last_per_task: int = 1):
        super().__init__()
        self._keep_last_per_task = max(1, int(keep_last_per_task or 1))

    @override
    def before_model(self, state: AgentState, runtime: Runtime) -> dict[str, Any] | None:  # noqa: ARG002
        messages = state.get("messages") or []
        if not isinstance(messages, list) or not messages:
            return None

        # Collect indices of monitor_execution_step tool messages by task_id.
        by_task: dict[str, list[int]] = {}
        for i, m in enumerate(messages):
            if not isinstance(m, ToolMessage):
                continue
            action, task_id = _tool_message_action_and_task_id(m)
            if action != "monitor_execution_step":
                continue
            if not task_id:
                continue
            by_task.setdefault(task_id, []).append(i)

        if not by_task:
            return None

        # Mark old indices to drop, keep last N per task_id.
        drop: set[int] = set()
        for _tid, idxs in by_task.items():
            if len(idxs) <= self._keep_last_per_task:
                continue
            for j in idxs[: -self._keep_last_per_task]:
                drop.add(j)

        if not drop:
            return None

        # Build RemoveMessage patches keyed by message id so the ``add_messages``
        # reducer actually drops them. Returning a plain pruned list is a no-op:
        # the reducer merges by id (append-only), so every existing id stays.
        # Messages without an id (rare; LangGraph normally fills one) are
        # skipped — they cannot be addressed by RemoveMessage.
        removals: list[RemoveMessage] = []
        skipped_no_id = 0
        for idx in sorted(drop):
            mid = getattr(messages[idx], "id", None)
            if not mid:
                skipped_no_id += 1
                continue
            removals.append(RemoveMessage(id=str(mid)))

        if not removals:
            if skipped_no_id:
                logger.debug(
                    "MonitorToolPrune: %d candidate messages lacked ids; nothing removed.",
                    skipped_no_id,
                )
            return None

        logger.info(
            "Pruned %d old monitor_execution_step ToolMessages (kept last=%d per task; %d lacked ids).",
            len(removals),
            self._keep_last_per_task,
            skipped_no_id,
        )
        return {"messages": removals}

    @override
    async def abefore_model(self, state: AgentState, runtime: Runtime) -> dict[str, Any] | None:
        return self.before_model(state, runtime)
