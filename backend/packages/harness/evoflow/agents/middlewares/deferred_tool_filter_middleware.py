"""Middleware to filter deferred tool schemas from model binding.

When tool_search is enabled, MCP tools are registered in the DeferredToolRegistry
and passed to ToolNode for execution, but their schemas should NOT be sent to the
LLM via bind_tools (that's the whole point of deferral — saving context tokens).

This middleware intercepts wrap_model_call and removes deferred tools from
request.tools so that model.bind_tools only receives active tool schemas.
The agent discovers deferred tools at runtime via the tool_search tool.
"""

import json
import logging
from collections.abc import Awaitable, Callable
from typing import Any

try:
    from typing import override
except ImportError:
    from typing import override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain.agents.middleware.types import ModelCallResult, ModelRequest, ModelResponse
from langchain_core.messages import ToolMessage
from langgraph.prebuilt.tool_node import ToolCallRequest
from langgraph.types import Command

logger = logging.getLogger(__name__)


class DeferredToolFilterMiddleware(AgentMiddleware[AgentState]):
    """Remove deferred tools from request.tools before model binding.

    ToolNode still holds all tools (including deferred) for execution routing,
    but the LLM only sees active tool schemas — deferred tools are discoverable
    via tool_search at runtime.
    """

    @staticmethod
    def _strict_plan_collab_active(runtime: Any) -> bool:
        try:
            from evoflow.agents.middlewares.plan_guard_middleware import is_strict_plan_collaboration

            return bool(runtime is not None and is_strict_plan_collaboration(runtime, None))
        except Exception:
            return False

    def _get_loaded_names(self, state: AgentState | dict | None) -> set[str]:
        if not isinstance(state, dict):
            return set()
        raw = state.get("loaded_deferred_tools")
        if not isinstance(raw, list):
            return set()
        return {str(x or "").strip() for x in raw if str(x or "").strip()}

    def _extract_schema_names(self, content: str) -> list[str]:
        text = str(content or "").strip()
        if not text:
            return []
        try:
            parsed = json.loads(text)
        except Exception:
            return []
        # Backward-compatible formats:
        # 1) legacy: [ {name, ...}, ... ]
        # 2) current: { status, tool_defs: [ {name, ...}, ... ], ... }
        if isinstance(parsed, dict):
            defs = parsed.get("tool_defs")
            if isinstance(defs, list):
                parsed = defs
            else:
                return []
        if not isinstance(parsed, list):
            return []
        out: list[str] = []
        for item in parsed:
            if not isinstance(item, dict):
                continue
            n = str(item.get("name") or "").strip()
            if n:
                out.append(n)
        return out

    def _extract_tool_search_response_names(self, content: str) -> list[str]:
        """Parse tool_search JSON: ok.tool_defs / legacy list, or already_activated.tools."""
        text = str(content or "").strip()
        if not text:
            return []
        try:
            parsed = json.loads(text)
        except Exception:
            return []
        if isinstance(parsed, dict):
            status = str(parsed.get("status", "")).strip().lower()
            if status == "already_activated":
                raw = parsed.get("tools")
                if isinstance(raw, list):
                    return [str(x or "").strip() for x in raw if str(x or "").strip()]
                return []
            defs = parsed.get("tool_defs")
            if isinstance(defs, list):
                out: list[str] = []
                for item in defs:
                    if isinstance(item, dict):
                        n = str(item.get("name") or "").strip()
                        if n:
                            out.append(n)
                if out:
                    return out
        return self._extract_schema_names(text)

    def _filter_tools(self, request: ModelRequest) -> ModelRequest:
        # Duty runs: flat agent∪duty catalog — do not hide deferred behind tool_search.
        try:
            from evoflow.agents.middlewares.proactive_tool_middleware import is_proactive_run

            if is_proactive_run(getattr(request, "runtime", None)):
                return request
        except Exception:
            logger.debug("deferred filter: proactive check failed", exc_info=True)

        from evoflow.tools.builtins.tool_search import get_bound_tool_names, get_deferred_registry, set_activated_deferred_tools

        registry = get_deferred_registry()
        bound = get_bound_tool_names()
        if not registry and not bound:
            return request

        loaded = self._get_loaded_names(request.state)
        if self._strict_plan_collab_active(getattr(request, "runtime", None)):
            from evoflow.agents.middlewares.plan_guard_middleware import STRICT_PLAN_LEAD_TOOL_NAMES

            loaded = {n for n in loaded if n in STRICT_PLAN_LEAD_TOOL_NAMES}
        set_activated_deferred_tools(loaded)
        deferred_names: set[str] = set()
        if registry:
            deferred_names.update(e.name for e in registry.entries)
        # Catalog tools not bound this turn are hidden until tool_search loads them.
        for t in request.tools or []:
            n = str(getattr(t, "name", "") or "").strip()
            if n and n != "tool_search" and n not in bound:
                deferred_names.add(n)
        # MCP tools explicitly mounted to the agent (via _mount_agent_mcp_tools with
        # a non-None mcp_servers binding) are NOT deferred - they were deliberately
        # included in the agent's tool list.  Remove any MCP-prefixed tool name that
        # is present in request.tools so it stays visible to the model.
        from evoflow.mcp.binding import is_mcp_tool_name

        mounted_mcp_names = {
            str(getattr(t, "name", "") or "").strip()
            for t in (request.tools or [])
            if is_mcp_tool_name(str(getattr(t, "name", "") or ""))
        }
        deferred_names -= mounted_mcp_names
        active_tools = [
            t
            for t in request.tools
            if (getattr(t, "name", None) not in deferred_names) or (getattr(t, "name", None) in loaded)
        ]

        if len(active_tools) < len(request.tools):
            logger.debug(
                "Filtered %s deferred tool schema(s) from model binding (loaded=%s)",
                len(request.tools) - len(active_tools),
                len(loaded),
            )

        return request.override(tools=active_tools)

    def _sync_runtime_snapshot(self, request: ModelRequest) -> None:
        try:
            from evoflow.agents.middlewares.plan_guard_middleware import effective_activated_scenario_keys
            from evoflow.session_tool_binding.service import resolve_chat_session_key, sync_runtime_tool_snapshot

            session_key = resolve_chat_session_key()
            if not session_key:
                return
            messages = list((request.state or {}).get("messages") or []) if isinstance(request.state, dict) else []
            keys = effective_activated_scenario_keys(request.runtime, messages)
            bound_names = sorted(
                {
                    str(getattr(t, "name", "") or "").strip().lower()
                    for t in (request.tools or [])
                    if str(getattr(t, "name", "") or "").strip()
                }
            )
            sync_runtime_tool_snapshot(
                session_key=session_key,
                active_scenarios=keys,
                model_bound_tools=bound_names,
                loaded_deferred=sorted(self._get_loaded_names(request.state)),
            )
        except Exception:
            logger.debug("sync runtime tool snapshot failed", exc_info=True)

    def _handle_tool_search_result(self, request: ToolCallRequest, result: ToolMessage | Command) -> ToolMessage | Command:
        if isinstance(result, Command):
            return result
        if not isinstance(result, ToolMessage):
            return result
        names = self._extract_tool_search_response_names(str(getattr(result, "content", "") or ""))
        if not names:
            return result
        current_loaded = self._get_loaded_names(request.state)
        newly_loaded = [n for n in names if n not in current_loaded]
        if self._strict_plan_collab_active(getattr(request, "runtime", None)):
            from evoflow.agents.middlewares.plan_guard_middleware import STRICT_PLAN_LEAD_TOOL_NAMES

            newly_loaded = [n for n in newly_loaded if n in STRICT_PLAN_LEAD_TOOL_NAMES]
        if not newly_loaded:
            return result
        full_loaded = sorted({*current_loaded, *newly_loaded})
        try:
            from evoflow.session_tool_binding.service import persist_tool_search_loaded, resolve_chat_session_key
            from evoflow.tools.builtins.scenario_activation import get_activated_scenarios

            session_key = resolve_chat_session_key()
            if session_key:
                persist_tool_search_loaded(
                    session_key=session_key,
                    active_scenarios=get_activated_scenarios(),
                    loaded_names=full_loaded,
                )
        except Exception:
            logger.debug("persist tool_search deferred bindings failed", exc_info=True)
        return Command(update={"messages": [result], "loaded_deferred_tools": newly_loaded})

    def _handle_scenario_result(self, request: ToolCallRequest, result: ToolMessage | Command) -> ToolMessage | Command:
        if isinstance(result, Command):
            return result
        if not isinstance(result, ToolMessage):
            return result
        content = str(getattr(result, "content", "") or "")
        try:
            parsed = json.loads(content)
        except Exception:
            return result
        if not isinstance(parsed, dict):
            return result
        if str(parsed.get("status", "")).strip().lower() != "success":
            return result
        action = str(parsed.get("action", "")).strip().lower()
        if action not in ("activate", "deactivate"):
            return result

        current_loaded = sorted(self._get_loaded_names(request.state))
        restored: list[str] = []
        try:
            from evoflow.session_tool_binding.service import on_scenario_tool_success, resolve_chat_session_key

            restored = on_scenario_tool_success(
                session_key=resolve_chat_session_key(),
                current_loaded=current_loaded,
                payload=parsed,
            )
        except Exception:
            logger.debug("restore scenario deferred bindings failed", exc_info=True)
            restored = []

        if self._strict_plan_collab_active(getattr(request, "runtime", None)):
            from evoflow.agents.middlewares.plan_guard_middleware import STRICT_PLAN_LEAD_TOOL_NAMES

            restored = [n for n in restored if n in STRICT_PLAN_LEAD_TOOL_NAMES]

        from evoflow.agents.thread_state import EVF_REPLACE_LOADED_DEFERRED_MARKER

        logger.info(
            "Replace loaded deferred tools after scenario mutate: %s",
            restored,
        )
        return Command(
            update={
                "messages": [result],
                "loaded_deferred_tools": [EVF_REPLACE_LOADED_DEFERRED_MARKER, *restored],
            }
        )

    @override
    def wrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], ModelResponse],
    ) -> ModelCallResult:
        req2 = self._filter_tools(request)
        self._sync_runtime_snapshot(req2)
        return handler(req2)

    @override
    async def awrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], Awaitable[ModelResponse]],
    ) -> ModelCallResult:
        req2 = self._filter_tools(request)
        self._sync_runtime_snapshot(req2)
        return await handler(req2)

    @override
    def wrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], ToolMessage | Command],
    ) -> ToolMessage | Command:
        tool_name = request.tool_call.get("name")
        if tool_name not in {"tool_search", "scenario"}:
            return handler(request)
        result = handler(request)
        if tool_name == "tool_search":
            return self._handle_tool_search_result(request, result)
        return self._handle_scenario_result(request, result)

    @override
    async def awrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], Awaitable[ToolMessage | Command]],
    ) -> ToolMessage | Command:
        tool_name = request.tool_call.get("name")
        if tool_name not in {"tool_search", "scenario"}:
            return await handler(request)
        result = await handler(request)
        if tool_name == "tool_search":
            return self._handle_tool_search_result(request, result)
        return self._handle_scenario_result(request, result)
