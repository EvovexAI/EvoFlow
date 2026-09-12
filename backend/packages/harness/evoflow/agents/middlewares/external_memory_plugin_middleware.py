"""Inject external memory plugin ``<memory_context>`` before the model (when last msg is user)."""

from __future__ import annotations

import logging
from typing import Any

try:
    from typing import override
except ImportError:
    from typing import override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import HumanMessage
from langgraph.config import get_config
from langgraph.runtime import Runtime

from evoflow.agents.memory.conversation_filter import format_message_plain_text
from evoflow.agents.memory.runtime_overrides import effective_memory_injection_enabled
from evoflow.agents.memory_plugins.manager import get_external_memory_plugin_manager
from evoflow.agents.memory_plugins.plugin_memory_audit import pm_event
from evoflow.config.memory_config import get_memory_config

logger = logging.getLogger(__name__)


class ExternalMemoryPluginMiddlewareState(AgentState):
    pass


class ExternalMemoryPluginMiddleware(AgentMiddleware[ExternalMemoryPluginMiddlewareState]):
    """Runs only when the trailing message is a normal user HumanMessage (not tool loop)."""

    state_schema = ExternalMemoryPluginMiddlewareState

    @override
    def before_model(
        self,
        state: ExternalMemoryPluginMiddlewareState,
        runtime: Runtime,  # noqa: ARG002
    ) -> dict[str, Any] | None:
        cfg = get_memory_config()
        if not cfg.enabled or not cfg.external_prefetch_enabled:
            return None
        if not effective_memory_injection_enabled(runtime):
            return None
        mgr = get_external_memory_plugin_manager()
        if mgr is None:
            return None

        messages = state.get("messages") or []
        if not messages:
            return None
        last = messages[-1]
        if getattr(last, "type", None) != "human":
            return None
        if getattr(last, "name", None) in (
            "external_memory_prefetch",
            "todo_reminder",
        ):
            return None

        thread_id = runtime.context.get("thread_id") if runtime.context else None
        if thread_id is None:
            config_data = get_config()
            thread_id = config_data.get("configurable", {}).get("thread_id")
        if not thread_id:
            return None

        query = format_message_plain_text(last).strip()
        fenced = mgr.prefetch_fenced(query, thread_id=str(thread_id))
        if not fenced.strip():
            return None

        pm_event(
            "middleware_prefetch_injected",
            thread_id=str(thread_id),
            query_preview=query,
            fenced_chars=len(fenced),
            message_name="external_memory_prefetch",
        )
        return {
            "messages": [
                HumanMessage(
                    name="external_memory_prefetch",
                    content=fenced,
                )
            ]
        }

    @override
    async def abefore_model(
        self,
        state: ExternalMemoryPluginMiddlewareState,
        runtime: Runtime,
    ) -> dict[str, Any] | None:
        return self.before_model(state, runtime)
