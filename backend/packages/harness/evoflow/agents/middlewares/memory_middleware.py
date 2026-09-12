"""Middleware for memory mechanism."""

import logging
from typing import Any

try:
    from typing import override
except ImportError:
    from typing import override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langgraph.config import get_config
from langgraph.runtime import Runtime

from evoflow.agents.memory.conversation_filter import (
    describe_memory_message_shape,
    extract_last_user_assistant_texts,
    filter_messages_for_longterm_memory,
)
from evoflow.agents.memory.queue import get_memory_queue
from evoflow.agents.memory.runtime_overrides import effective_memory_updates_enabled
from evoflow.agents.memory.workspace_memory import resolve_workspace_path_for_memory
from evoflow.agents.message_analysis_utils import latest_real_user_turn_key, resolve_transcript_messages_for_analysis
from evoflow.config.memory_config import get_memory_config

logger = logging.getLogger(__name__)


def _resolve_model_name(runtime: Runtime | None) -> str | None:
    """Extract session model_name from runtime context.

    Works for both dict context and LeadAgentRuntimeContext dataclass (both have .get()).
    Falls back to langgraph get_config() if runtime context is empty.
    """
    if runtime is None:
        return None
    ctx = getattr(runtime, "context", None)
    if ctx is not None:
        try:
            name = ctx.get("model_name") if hasattr(ctx, "get") else None
            if name:
                return str(name).strip() or None
        except Exception:
            pass
    try:
        from langgraph.config import get_config

        name = get_config().get("configurable", {}).get("model_name")
        if name:
            return str(name).strip() or None
    except Exception:
        pass
    # DB fallback: thread_id → session → model_name
    try:
        _tid = ctx.get("thread_id") if ctx is not None and hasattr(ctx, "get") else None
        if not _tid:
            _tid = get_config().get("configurable", {}).get("thread_id")
        if _tid:
            from evoflow.persistence.session_repositories import get_model_name_for_thread
            _name = get_model_name_for_thread(str(_tid).strip())
            if _name:
                return str(_name).strip() or None
    except Exception:
        pass
    return None

# One async memory update per user turn (not per tool-loop model step).
_MEMORY_UPDATE_SCHEDULED: dict[str, str] = {}


class MemoryMiddlewareState(AgentState):
    """Compatible with the `ThreadState` schema."""

    pass


def _filter_messages_for_memory(messages: list[Any]) -> list[Any]:
    """Backward-compatible alias for ``filter_messages_for_longterm_memory``."""
    return filter_messages_for_longterm_memory(messages)


def _agent_scope_label(agent_name: str | None) -> str:
    return agent_name if agent_name else "全局"


def _thread_id_from_runtime(runtime: Runtime) -> str:
    ctx = getattr(runtime, "context", None) if runtime is not None else None
    if ctx is not None and hasattr(ctx, "get"):
        tid = ctx.get("thread_id")
        if tid:
            return str(tid).strip()
    cfg = get_config()
    return str(cfg.get("configurable", {}).get("thread_id") or "").strip()


class MemoryMiddleware(AgentMiddleware[MemoryMiddlewareState]):
    """Queue conversation for memory update after the model's final reply each user turn.

    Runs in ``after_model`` (not ``after_agent``) so long tool loops and runs that never
    reach the graph exit node still enqueue memory once a genuine user + final assistant
    pair exists in state/transcript.
    """

    state_schema = MemoryMiddlewareState

    def __init__(self, agent_name: str | None = None):
        """Initialize the MemoryMiddleware.

        Args:
            agent_name: If provided, memory is stored per-agent. If None, uses global memory.
        """
        super().__init__()
        self._agent_name = agent_name

    def _maybe_queue_memory_update(self, state: MemoryMiddlewareState, runtime: Runtime) -> None:
        config = get_memory_config()
        scope = _agent_scope_label(self._agent_name)

        if not config.enabled:
            return

        if not effective_memory_updates_enabled(runtime):
            return

        thread_id = _thread_id_from_runtime(runtime)
        if not thread_id:
            return

        runtime_messages = state.get("messages", [])
        if not runtime_messages:
            return

        messages = resolve_transcript_messages_for_analysis(
            thread_id=thread_id,
            runtime_messages=runtime_messages,
        )
        pair = extract_last_user_assistant_texts(messages)
        if not pair:
            return

        user_turn_key = latest_real_user_turn_key(messages)
        if not user_turn_key:
            return
        if _MEMORY_UPDATE_SCHEDULED.get(thread_id) == user_turn_key:
            return
        _MEMORY_UPDATE_SCHEDULED[thread_id] = user_turn_key

        source = "会话存档" if messages is not runtime_messages and len(messages) != len(runtime_messages) else "runtime"
        shape = describe_memory_message_shape(messages)
        workspace_path = resolve_workspace_path_for_memory(runtime=runtime, thread_id=thread_id)
        if workspace_path:
            try:
                from evoflow.agents.memory.workspace_memory import schedule_workspace_memory_bootstrap_if_needed

                schedule_workspace_memory_bootstrap_if_needed(workspace_path)
            except Exception:
                logger.debug("workspace bootstrap schedule skipped", exc_info=True)
        ws_label = "是" if workspace_path else "否（仅更新用户记忆）"

        logger.info(
            "[记忆] after_model 入队：thread=%s agent=%s 来源=%s 本轮 user_chars=%d ai_chars=%d 工作区记忆=%s%s（%s）",
            thread_id,
            scope,
            source,
            len(pair[0]),
            len(pair[1]),
            ws_label,
            f" path={workspace_path}" if workspace_path else "",
            shape,
        )

        # Resolve session model_name from runtime context (follows user-selected model)
        session_model = _resolve_model_name(runtime)
        filtered_messages = _filter_messages_for_memory(messages)
        # Stamp agent memory namespace ownership when runtime knows the human.
        pid: str | None = None
        try:
            from evoflow.authz.runtime_identity import principal_id_from_runtime
            from evoflow.authz.scope import personal_scope
            from evoflow.memory.document_codec import namespace_for_agent_key
            from evoflow.memory import store as mem_store

            pid = principal_id_from_runtime(runtime)
            if pid:
                ns = namespace_for_agent_key(self._agent_name)
                mem_store.ensure_namespace(
                    ns,
                    org_id="local",
                    owner_scope_id=personal_scope(pid),
                    created_by=pid,
                )
        except Exception:
            logger.debug("memory namespace ownership stamp skipped", exc_info=True)
        get_memory_queue().add(
            thread_id=thread_id,
            messages=filtered_messages,
            agent_name=self._agent_name,
            workspace_path=workspace_path,
            model_name=session_model,
            principal_id=pid,
        )

    @override
    def after_model(self, state: MemoryMiddlewareState, runtime: Runtime) -> dict | None:
        self._maybe_queue_memory_update(state, runtime)
        return None

    @override
    async def aafter_model(self, state: MemoryMiddlewareState, runtime: Runtime) -> dict | None:
        self._maybe_queue_memory_update(state, runtime)
        return None
