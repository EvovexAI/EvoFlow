"""Drop conversation history from LangGraph checkpoint after a completed agent turn.

``evoflow_chat_messages`` is the durable SSOT. Runtime still needs ``messages``
in-memory during a run, but durable checkpoints should not store transcript —
including the current user turn. Primary enforcement is
``OmitTranscriptCheckpointer`` on every put/aput; this middleware clears channels
in ``after_agent`` as a belt-and-suspenders so exit state is empty before put.

Tool-approval interrupts typically skip ``after_agent``; the checkpointer wrapper
keeps ``messages`` only while unresolved tool_calls remain.
"""

from __future__ import annotations

import logging
import os
from typing import Any

try:
    from typing import override
except ImportError:
    from typing import override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langgraph.runtime import Runtime

from evoflow.agents.middleware_state import replace_messages_in_state

logger = logging.getLogger(__name__)


def checkpoint_transcript_slim_enabled() -> bool:
    raw = (os.getenv("EVOFLOW_CHECKPOINT_SLIM_MESSAGES") or "1").strip().lower()
    return raw not in {"0", "false", "no", "off"}


def _thread_id(runtime: Runtime) -> str:
    try:
        from evoflow.observability.run_latency_trace import read_configurable_trace_fields

        tid, _, _ = read_configurable_trace_fields()
        if tid:
            return tid
    except Exception:
        pass
    try:
        from langgraph.config import get_config

        cfg = get_config() or {}
        conf = cfg.get("configurable") if isinstance(cfg, dict) else None
        if isinstance(conf, dict):
            tid = str(conf.get("thread_id") or "").strip()
            if tid:
                return tid
    except Exception:
        pass
    try:
        cfg = getattr(runtime, "config", None) or {}
        conf = cfg.get("configurable") if isinstance(cfg, dict) else None
        if isinstance(conf, dict):
            tid = str(conf.get("thread_id") or "").strip()
            if tid:
                return tid
        ctx = getattr(runtime, "context", None)
        if isinstance(ctx, dict):
            return str(ctx.get("thread_id") or "").strip()
    except Exception:
        pass
    return ""


class CheckpointTranscriptSlimMiddleware(AgentMiddleware[AgentState]):
    """Clear ``messages`` / ``ui_messages`` after a successful agent completion."""

    state_schema = AgentState

    @override
    def before_agent(self, state: AgentState, runtime: Runtime) -> dict[str, Any] | None:
        """Mark graph entry — splits make_lead_exit → before_model blind time."""
        del state
        tid = _thread_id(runtime)
        if not tid:
            return None
        try:
            from evoflow.observability.run_latency_trace import write_run_latency_event

            write_run_latency_event(
                tid,
                "graph_before_agent_enter",
                {"source": "CheckpointTranscriptSlimMiddleware"},
            )
        except Exception:
            pass
        return None

    @override
    async def abefore_agent(self, state: AgentState, runtime: Runtime) -> dict[str, Any] | None:
        return self.before_agent(state, runtime)

    def _slim(self, state: AgentState, runtime: Runtime) -> dict[str, Any] | None:
        if not checkpoint_transcript_slim_enabled():
            return None
        messages = list(state.get("messages") or [])
        ui = state.get("ui_messages")
        ui_n = len(ui) if isinstance(ui, list) else 0
        if not messages and ui_n == 0:
            return None

        tid = _thread_id(runtime)
        logger.info(
            "checkpoint transcript slim: clearing messages=%s ui_messages=%s thread=%s",
            len(messages),
            ui_n,
            tid or "-",
        )
        try:
            from evoflow.observability.run_latency_trace import write_run_latency_event

            if tid:
                write_run_latency_event(
                    tid,
                    "checkpoint_transcript_slim",
                    {"messages_cleared": len(messages), "ui_messages_cleared": ui_n},
                )
        except Exception:
            pass

        patch = replace_messages_in_state([])
        # Drop legacy duplicated UI history if still present on older threads.
        patch["ui_messages"] = []
        return patch

    @override
    def after_agent(self, state: AgentState, runtime: Runtime) -> dict[str, Any] | None:
        return self._slim(state, runtime)

    @override
    async def aafter_agent(self, state: AgentState, runtime: Runtime) -> dict[str, Any] | None:
        return self._slim(state, runtime)
