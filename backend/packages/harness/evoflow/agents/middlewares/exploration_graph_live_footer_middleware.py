"""Inject fresh ``<session_mind_map>`` ephemerally before each model call (never checkpoint)."""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from typing import Any

try:
    from typing import override
except ImportError:
    from typing import override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain.agents.middleware.types import ModelCallResult, ModelRequest
from langchain_core.messages import BaseMessage, HumanMessage, SystemMessage, ToolMessage

logger = logging.getLogger(__name__)

_MIND_MAP_MESSAGE_NAME = "session_mind_map"


def _resolve_session_key(*, request: ModelRequest | None = None, runtime: Any | None = None) -> str:
    try:
        from evoflow.agents.middlewares.dynamic_system_prompt_middleware import _merged_runtime_context

        if request is not None:
            ctx = _merged_runtime_context(request)
            sk = str(ctx.get("session_key") or "").strip()
            if sk:
                return sk
    except Exception:
        pass
    if runtime is not None:
        raw = getattr(runtime, "context", None)
        if isinstance(raw, dict):
            sk = str(raw.get("session_key") or "").strip()
            if sk:
                return sk
    try:
        from langgraph.config import get_config

        sk = str(get_config().get("configurable", {}).get("session_key") or "").strip()
        if sk:
            return sk
    except Exception:
        pass
    return ""


def _resolve_thread_id(*, request: ModelRequest | None = None, runtime: Any | None = None) -> str:
    """Resolve the conversation thread_id from runtime context (not mind_map scope)."""
    thread_id = ""
    try:
        from evoflow.agents.middlewares.dynamic_system_prompt_middleware import _merged_runtime_context

        if request is not None:
            ctx = _merged_runtime_context(request)
            thread_id = str(ctx.get("thread_id") or "").strip()
    except Exception:
        pass
    if not thread_id and runtime is not None:
        raw = getattr(runtime, "context", None)
        if isinstance(raw, dict):
            thread_id = str(raw.get("thread_id") or "").strip()
    if not thread_id:
        try:
            from langgraph.config import get_config

            thread_id = str(get_config().get("configurable", {}).get("thread_id") or "").strip()
        except Exception:
            pass
    return thread_id


def _resolve_mind_map_thread_id(*, request: ModelRequest | None = None, runtime: Any | None = None) -> str:
    thread_id = ""
    try:
        from evoflow.agents.middlewares.dynamic_system_prompt_middleware import _merged_runtime_context

        if request is not None:
            ctx = _merged_runtime_context(request)
            thread_id = str(ctx.get("thread_id") or "").strip()
    except Exception:
        pass
    if not thread_id and runtime is not None:
        raw = getattr(runtime, "context", None)
        if isinstance(raw, dict):
            thread_id = str(raw.get("thread_id") or "").strip()
    if not thread_id:
        try:
            from langgraph.config import get_config

            thread_id = str(get_config().get("configurable", {}).get("thread_id") or "").strip()
        except Exception:
            pass

    session_key = _resolve_session_key(request=request, runtime=runtime)
    if not session_key and thread_id:
        try:
            from evoflow.persistence.session_repositories import find_session_key_by_thread_id

            session_key = str(find_session_key_by_thread_id(thread_id) or "").strip()
        except Exception:
            pass

    try:
        from evoflow.persistence.exploration_graph_repositories import resolve_mind_map_thread_id

        return resolve_mind_map_thread_id(thread_id or None, session_key=session_key or None)
    except Exception:
        return thread_id


def _resolve_prompt_language(*, request: ModelRequest | None = None, runtime: Any | None = None) -> str | None:
    try:
        from evoflow.agents.middlewares.dynamic_system_prompt_middleware import _merged_runtime_context

        if request is not None:
            ctx = _merged_runtime_context(request)
            meta = ctx.get("evf_dynamic_prompt_meta")
            if isinstance(meta, dict) and meta.get("prompt_language"):
                return str(meta.get("prompt_language"))
            if ctx.get("prompt_language"):
                return str(ctx.get("prompt_language"))
    except Exception:
        pass
    if runtime is not None:
        raw = getattr(runtime, "context", None)
        if isinstance(raw, dict):
            if raw.get("prompt_language"):
                return str(raw.get("prompt_language"))
    return None


def _build_section(*, thread_id: str, session_key: str, prompt_language: str | None) -> str:
    from evoflow.exploration_graph.prompt import build_mind_map_section

    return build_mind_map_section(
        thread_id,
        prompt_language=prompt_language,
        session_key=session_key or None,
    )


def _is_mind_map_message(msg: Any) -> bool:
    return isinstance(msg, (SystemMessage, HumanMessage, ToolMessage)) and getattr(msg, "name", None) == _MIND_MAP_MESSAGE_NAME


def _strip_mind_map_messages(messages: list[Any]) -> list[Any]:
    return [m for m in messages if not _is_mind_map_message(m)]


def _messages_from_request(request: ModelRequest) -> list[BaseMessage]:
    from evoflow.agents.middlewares.model_request_messages import messages_from_model_request

    return messages_from_model_request(request)


def _should_inject_message(messages: list[Any]) -> bool:
    if not messages:
        return False
    last = messages[-1]
    return getattr(last, "name", None) != _MIND_MAP_MESSAGE_NAME


class ExplorationGraphLiveFooterMiddleware(AgentMiddleware[AgentState]):
    """Optionally append a named SystemMessage with the latest mind map (never checkpoint).

    Default is **off** (``inject_into_model_payload=false``) so the model prefix stays
    stable for prompt-cache hits. When injection is disabled, still strips legacy
    ``session_mind_map`` messages from the outbound payload.
    """

    state_schema = AgentState

    def _graph_enabled_for_runtime(self, runtime: Any) -> bool:
        try:
            from evoflow.agents.automation_runtime import is_unattended_automation
            from evoflow.exploration_graph.config import is_exploration_graph_enabled
        except Exception:
            return False
        if not is_exploration_graph_enabled():
            return False
        if is_unattended_automation(runtime):
            return False
        return True

    def _should_inject_for_runtime(self, runtime: Any) -> bool:
        if not self._graph_enabled_for_runtime(runtime):
            return False
        try:
            from evoflow.exploration_graph.config import should_inject_mind_map_into_model_payload

            return should_inject_mind_map_into_model_payload()
        except Exception:
            return False

    def _strip_stale_system_mind_map(self, request: ModelRequest) -> ModelRequest:
        """Remove legacy ``<session_mind_map>`` blocks from compile-time system text only."""
        # Always strip stale compile-time footers when present — even if injection is off.
        sm = request.system_message
        if sm is None:
            return request
        try:
            from evoflow.exploration_graph.prompt import strip_mind_map_from_system_prompt
        except Exception:
            return request
        raw = str(getattr(sm, "content", "") or "")
        base = strip_mind_map_from_system_prompt(raw)
        if base == raw.rstrip():
            return request
        logger.debug("ExplorationGraphLiveFooter: stripped stale session_mind_map from system prompt")
        return request.override(system_message=sm.model_copy(update={"content": base}))

    def _patch_request(self, request: ModelRequest) -> ModelRequest:
        request = self._strip_stale_system_mind_map(request)
        runtime = getattr(request, "runtime", None)

        messages = _strip_mind_map_messages(_messages_from_request(request))
        stripped = len(messages) != len(_messages_from_request(request))

        if not self._should_inject_for_runtime(runtime):
            if stripped:
                return request.override(messages=messages)
            return request

        if not _should_inject_message(messages):
            if stripped:
                return request.override(messages=messages)
            return request

        conv_tid = _resolve_thread_id(request=request, runtime=runtime)
        mind_map_tid = ""

        mind_map_section = ""
        mind_map_tid = _resolve_mind_map_thread_id(request=request, runtime=runtime)
        if mind_map_tid:
            session_key = _resolve_session_key(request=request, runtime=runtime)
            if not session_key:
                try:
                    from evoflow.persistence.session_repositories import find_session_key_by_thread_id

                    session_key = str(find_session_key_by_thread_id(mind_map_tid) or "").strip()
                except Exception:
                    session_key = ""
            mind_map_section = _build_section(
                thread_id=mind_map_tid,
                session_key=session_key,
                prompt_language=_resolve_prompt_language(request=request),
            )
            if not mind_map_section.strip():
                logger.debug("LiveFooter: empty mind_map section, skipping thread=%s", mind_map_tid)
                mind_map_section = ""

        if not mind_map_section.strip():
            if stripped:
                return request.override(messages=messages)
            return request

        logger.info(
            "LiveFooter: injecting mind_map section thread=%s chars=%d",
            conv_tid or mind_map_tid,
            len(mind_map_section),
        )
        hint = SystemMessage(content=mind_map_section.strip(), name=_MIND_MAP_MESSAGE_NAME)
        try:
            from evoflow.exploration_graph.mind_map_diag import log_mind_map

            log_mind_map(
                "注入session_mind_map消息(SystemMessage)",
                thread_id=conv_tid or mind_map_tid,
                位置="wrap_model_call",
                chars=len(mind_map_section),
                触发类型=type(messages[-1]).__name__,
            )
        except Exception:
            logger.debug("LiveFooter: injected mind_map SystemMessage thread=%s", conv_tid or mind_map_tid)
        return request.override(messages=[*messages, hint])

    @override
    def wrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], ModelCallResult],
    ) -> ModelCallResult:
        return handler(self._patch_request(request))

    @override
    async def awrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], Awaitable[ModelCallResult]],
    ) -> ModelCallResult:
        return await handler(self._patch_request(request))
