"""Mark session ``run_status`` terminal from inside the LangGraph agent graph.

``after_agent`` runs when the agent node completes (not on ``interrupt()`` pauses).
This closes the F5 gap where the browser SSE is gone but the run has finished:
DB is updated from inside the graph without waiting for Gateway stream close.

Gateway ``middle_layer._finish_layer`` remains a safety net (idempotent re-mark).
"""

from __future__ import annotations

import logging
from typing import Any

try:
    from typing import override
except ImportError:
    from typing import override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langgraph.runtime import Runtime

logger = logging.getLogger(__name__)


def _ctx_get(runtime: Runtime | None, key: str) -> str:
    if runtime is None:
        return ""
    ctx = getattr(runtime, "context", None)
    if isinstance(ctx, dict):
        return str(ctx.get(key) or "").strip()
    if ctx is not None and hasattr(ctx, key):
        return str(getattr(ctx, key) or "").strip()
    if ctx is not None and hasattr(ctx, "get"):
        try:
            return str(ctx.get(key) or "").strip()
        except Exception:
            return ""
    return ""


def _thread_id_from_runtime(runtime: Runtime | None) -> str:
    tid = _ctx_get(runtime, "thread_id")
    if tid:
        return tid
    try:
        from langgraph.config import get_config

        return str(get_config().get("configurable", {}).get("thread_id") or "").strip()
    except Exception:
        return ""


def _session_key_from_runtime(runtime: Runtime | None, thread_id: str) -> str:
    sk = _ctx_get(runtime, "session_key")
    if sk:
        return sk
    if not thread_id:
        return ""
    try:
        from evoflow.persistence.session_repositories import find_session_key_by_thread_id

        return str(find_session_key_by_thread_id(thread_id) or "").strip()
    except Exception:
        return ""


def should_hold_session_running(thread_id: str) -> bool:
    """True when tool-approval / collab inject may still resume — do not mark idle yet."""
    tid = str(thread_id or "").strip()
    if not tid:
        return False
    try:
        from evoflow.agents.tool_approval_service import thread_has_pending_approvals

        if thread_has_pending_approvals(tid):
            return True
    except Exception:
        logger.debug("session lifecycle pending-approval probe failed thread=%s", tid, exc_info=True)
    try:
        from app.gateway.streaming.post_stream_ui_normalize import thread_in_tool_approval_pause

        if thread_in_tool_approval_pause(tid):
            return True
    except Exception:
        pass
    try:
        from app.gateway.streaming.post_stream_ui_normalize import _should_defer_run_finished

        if _should_defer_run_finished(tid):
            return True
    except Exception:
        pass
    try:
        from app.gateway.streaming.session_stream_inject import _has_pending_collab_subtasks

        if _has_pending_collab_subtasks(tid):
            return True
    except Exception:
        pass
    return False


def mark_session_ended_from_agent(
    *,
    session_key: str | None,
    thread_id: str | None,
    reason: str = "agent_completed",
    source: str = "agent_after_agent",
) -> bool:
    """Write terminal ``run_status`` unless the turn is deferred (approval/collab)."""
    tid = str(thread_id or "").strip()
    sk = str(session_key or "").strip() or None
    if not tid and not sk:
        return False
    if tid and should_hold_session_running(tid):
        logger.info(
            "session lifecycle: hold running (defer) thread=%s session=%s",
            tid,
            sk or "?",
        )
        return False
    try:
        from evoflow.session_execution.lifecycle import force_end_session_turn

        return bool(
            force_end_session_turn(
                session_key=sk,
                thread_id=tid or None,
                source=source,
                reason=reason,
            )
        )
    except Exception:
        logger.debug(
            "session lifecycle force_end failed thread=%s session=%s",
            tid,
            sk,
            exc_info=True,
        )
        return False


def _emit_lifecycle_custom(thread_id: str, *, phase: str) -> None:
    try:
        from langgraph.config import get_stream_writer

        writer = get_stream_writer()
        if writer is None:
            return
        writer(
            {
                "type": "session_run_lifecycle",
                "phase": phase,
                "thread_id": thread_id,
            }
        )
    except Exception:
        logger.debug("session lifecycle custom event failed thread=%s", thread_id, exc_info=True)


class SessionRunLifecycleMiddleware(AgentMiddleware[AgentState]):
    """Inside-graph session end: ``after_agent`` → ``force_end_session_turn``."""

    state_schema = AgentState

    def _end_from_agent(self, runtime: Runtime) -> dict[str, Any] | None:
        tid = _thread_id_from_runtime(runtime)
        sk = _session_key_from_runtime(runtime, tid)
        if not tid and not sk:
            return None
        marked = mark_session_ended_from_agent(
            session_key=sk or None,
            thread_id=tid or None,
            reason="agent_completed",
            source="agent_after_agent",
        )
        if marked and tid:
            _emit_lifecycle_custom(tid, phase="ended")

        # 标记 run 完成 - 供前端重连时发现（持久化补偿）
        try:
            from evoflow.persistence.live_run_repositories import mark_run_completed

            # 从 runtime context 尝试获取 run_id
            run_id = _ctx_get(runtime, "run_id")
            if not run_id:
                # 降级：从 state 或其他地方获取（如果可用）
                pass
            mark_run_completed(thread_id=tid, run_id=run_id or None, status="success")
        except Exception:
            logger.debug("mark_run_completed failed", exc_info=True)

        return None

    @override
    def after_agent(self, state: AgentState, runtime: Runtime) -> dict[str, Any] | None:
        del state
        return self._end_from_agent(runtime)

    @override
    async def aafter_agent(self, state: AgentState, runtime: Runtime) -> dict[str, Any] | None:
        del state
        return self._end_from_agent(runtime)
