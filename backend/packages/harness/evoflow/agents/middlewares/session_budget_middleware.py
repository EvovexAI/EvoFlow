"""Per-user-turn tool budget and delegate cooldown middleware.

Tool-call hard/warn limits apply since the latest real user HumanMessage
(not cumulative across the whole sidebar session). Delegate cooldown remains
session-scoped. Repeated same-target failures are not blocked here.
"""

from __future__ import annotations

import hashlib
import logging
import os
import threading
import time
from collections import defaultdict
from collections.abc import Awaitable, Callable
from typing import Any

try:
    from typing import override
except ImportError:
    from typing import override

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import HumanMessage, ToolMessage
from langgraph.prebuilt.tool_node import ToolCallRequest
from langgraph.runtime import Runtime
from langgraph.types import Command

from evoflow.agents.lead_agent.runtime_context import runtime_context_mapping

logger = logging.getLogger(__name__)

_WARN_TOOL_COUNT = int(os.environ.get("EVOFLOW_SESSION_TOOL_BUDGET_WARN", "300") or 300)
_HARD_TOOL_COUNT = int(os.environ.get("EVOFLOW_SESSION_TOOL_BUDGET_HARD", "500") or 500)
_BUDGET_ENABLED = str(os.environ.get("EVOFLOW_SESSION_TOOL_BUDGET", "1")).strip().lower() not in {
    "0",
    "false",
    "no",
    "off",
}
_DELEGATE_COOLDOWN_SEC = 60.0

_READONLY_TOOLS = frozenset(
    {
        "read_file",
        "search_code_index",
        "terminal",
        "recall",
        "ask_clarification",
        "web_search",
        "web_fetch",
        "tool_search",
        "list_skills_catalog",
        "list_agents",
        "list_assignable_tools",
    }
)

# Injected by this middleware — must not count as a new user turn.
_BUDGET_MSG_PREFIX = "[会话工具预算"

_WARN_MSG = (
    f"{_BUDGET_MSG_PREFIX}] 自用户本轮消息起工具调用已超过 {_WARN_TOOL_COUNT} 次。"
    "请收口总结、减少重复探索，优先用已有结果完成回答。"
)
_BLOCK_MSG = (
    f"{_BUDGET_MSG_PREFIX}·已拦截] 自用户本轮消息起工具调用已达 {_HARD_TOOL_COUNT} 次上限，"
    "非只读工具本次未执行。请根据已有结果输出结论，或向用户说明仍需的信息。"
)
_DELEGATE_COOLDOWN_MSG = (
    "[子智能体冷却] 上次委派触达步数上限，60 秒内不再启动新子任务。"
    "请根据已有子智能体结果直接总结，不要重复 task/subagent。"
)

_TURN_LIMIT_MARKER = "STEP_LIMIT_REACHED"


def _runtime_configurable(runtime: Any) -> dict[str, Any]:
    if runtime is None:
        return {}
    cfg = getattr(runtime, "config", None) or {}
    if not isinstance(cfg, dict):
        return {}
    conf = cfg.get("configurable")
    return dict(conf) if isinstance(conf, dict) else {}


def _langgraph_configurable() -> dict[str, Any]:
    try:
        from langgraph.config import get_config

        conf = (get_config() or {}).get("configurable")
        return dict(conf) if isinstance(conf, dict) else {}
    except Exception:
        return {}


def _merged_run_scope(runtime: Any) -> dict[str, Any]:
    """Merge LangGraph configurable + runtime.config + runtime.context (context wins)."""
    merged = {**_langgraph_configurable(), **_runtime_configurable(runtime)}
    ctx = runtime_context_mapping(runtime)
    if ctx:
        merged.update(ctx)
    return merged


def _effective_budget_key(runtime: Any) -> str:
    """Per-sidebar-session budget key; never use a shared global fallback bucket."""
    scope = _merged_run_scope(runtime)
    sk = str(scope.get("session_key") or scope.get("sessionKey") or "").strip()
    if sk:
        return f"sk:{sk}"
    tid = str(scope.get("thread_id") or scope.get("threadId") or "").strip()
    if tid:
        try:
            from evoflow.persistence.session_repositories import find_session_key_by_thread_id

            resolved = str(find_session_key_by_thread_id(tid) or "").strip()
            if resolved:
                return f"sk:{resolved}"
        except Exception:
            pass
        return f"tid:{tid}"
    logger.debug("session_budget: unresolved budget key (skip count/block) scope_keys=%s", sorted(scope.keys()))
    return ""


def _human_content_str(message: Any) -> str:
    content = getattr(message, "content", "")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict) and block.get("type") == "text":
                parts.append(str(block.get("text") or ""))
        return "\n".join(parts)
    return str(content or "")


def _is_budget_injected_human(message: Any) -> bool:
    return _human_content_str(message).lstrip().startswith(_BUDGET_MSG_PREFIX)


def _user_turn_token(messages: list[Any] | None) -> str:
    """Stable id for the latest real user HumanMessage (skips budget nudges)."""
    if not messages:
        return ""
    user_n = 0
    last_id = ""
    last_digest = ""
    for m in messages:
        if not isinstance(m, HumanMessage):
            continue
        if _is_budget_injected_human(m):
            continue
        user_n += 1
        mid = str(getattr(m, "id", None) or "").strip()
        body = _human_content_str(m)
        last_id = mid
        last_digest = hashlib.md5(body.encode("utf-8", errors="replace")).hexdigest()[:12]
    if user_n <= 0:
        return ""
    return f"{user_n}:{last_id or last_digest}"


class SessionBudgetMiddleware(AgentMiddleware[AgentState]):
    """Cap per-user-turn tool volume; throttle rapid re-delegation after step limits."""

    def __init__(self) -> None:
        super().__init__()
        self._lock = threading.Lock()
        self._tool_counts: dict[str, int] = defaultdict(int)
        self._turn_tokens: dict[str, str] = {}
        self._warned: set[str] = set()
        self._delegate_cooldown_until: dict[str, float] = {}

    def _budget_key_from_request(self, request: ToolCallRequest) -> str:
        return _effective_budget_key(getattr(request, "runtime", None))

    def _budget_key_from_runtime(self, runtime: Runtime) -> str:
        return _effective_budget_key(runtime)

    def _sync_user_turn(self, state: AgentState, runtime: Runtime) -> None:
        """Reset tool budget when the user sends a new message."""
        if not _BUDGET_ENABLED:
            return
        budget_key = self._budget_key_from_runtime(runtime)
        if not budget_key:
            return
        messages = state.get("messages") if isinstance(state, dict) else None
        if messages is None and state is not None:
            messages = getattr(state, "messages", None)
        turn = _user_turn_token(list(messages or []))
        if not turn:
            return
        with self._lock:
            prev = self._turn_tokens.get(budget_key)
            if prev == turn:
                return
            self._turn_tokens[budget_key] = turn
            self._tool_counts[budget_key] = 0
            self._warned.discard(budget_key)
            if prev:
                logger.info(
                    "Session tool budget reset for new user turn",
                    extra={"budget_key": budget_key, "turn": turn},
                )

    def _maybe_block(self, request: ToolCallRequest) -> ToolMessage | None:
        if not _BUDGET_ENABLED:
            return None
        tc = request.tool_call if isinstance(request.tool_call, dict) else {}
        tool_name = str(tc.get("name") or "").strip()
        tool_call_id = str(tc.get("id") or "").strip()
        if not tool_call_id:
            return None
        budget_key = self._budget_key_from_request(request)
        if not budget_key:
            return None
        now = time.monotonic()
        with self._lock:
            count = self._tool_counts[budget_key]
            cooldown_until = self._delegate_cooldown_until.get(budget_key, 0.0)
        if tool_name in ("task", "subagent") and now < cooldown_until:
            return ToolMessage(
                content=_DELEGATE_COOLDOWN_MSG,
                tool_call_id=tool_call_id,
                name=tool_name,
                status="error",
            )
        if count >= _HARD_TOOL_COUNT and tool_name not in _READONLY_TOOLS:
            return ToolMessage(
                content=_BLOCK_MSG,
                tool_call_id=tool_call_id,
                name=tool_name,
                status="error",
            )
        return None

    def _after_tool(self, request: ToolCallRequest, result: ToolMessage | Command) -> None:
        if not isinstance(result, ToolMessage):
            return
        budget_key = self._budget_key_from_request(request)
        if not budget_key:
            return
        tc = request.tool_call if isinstance(request.tool_call, dict) else {}
        tool_name = str(tc.get("name") or "").strip()
        content = str(result.content or "")
        with self._lock:
            self._tool_counts[budget_key] += 1
            if _TURN_LIMIT_MARKER in content and tool_name in ("task", "subagent"):
                self._delegate_cooldown_until[budget_key] = time.monotonic() + _DELEGATE_COOLDOWN_SEC

    def _budget_warning(self, state: AgentState, runtime: Runtime) -> dict | None:
        if not _BUDGET_ENABLED:
            return None
        self._sync_user_turn(state, runtime)
        budget_key = self._budget_key_from_runtime(runtime)
        if not budget_key:
            return None
        with self._lock:
            count = self._tool_counts[budget_key]
            if count < _WARN_TOOL_COUNT or budget_key in self._warned:
                return None
            self._warned.add(budget_key)
        logger.warning(
            "Session tool budget warning (per user turn)",
            extra={"budget_key": budget_key, "count": count},
        )
        return {"messages": [HumanMessage(content=_WARN_MSG)]}

    @override
    def before_model(self, state: AgentState, runtime: Runtime) -> dict | None:
        self._sync_user_turn(state, runtime)
        return None

    @override
    async def abefore_model(self, state: AgentState, runtime: Runtime) -> dict | None:
        self._sync_user_turn(state, runtime)
        return None

    @override
    def after_model(self, state: AgentState, runtime: Runtime) -> dict | None:
        return self._budget_warning(state, runtime)

    @override
    async def aafter_model(self, state: AgentState, runtime: Runtime) -> dict | None:
        return self._budget_warning(state, runtime)

    @override
    def wrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], ToolMessage | Command],
    ) -> ToolMessage | Command:
        blocked = self._maybe_block(request)
        if blocked is not None:
            return blocked
        result = handler(request)
        self._after_tool(request, result)
        return result

    @override
    async def awrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], Awaitable[ToolMessage | Command]],
    ) -> ToolMessage | Command:
        blocked = self._maybe_block(request)
        if blocked is not None:
            return blocked
        result = await handler(request)
        self._after_tool(request, result)
        return result
