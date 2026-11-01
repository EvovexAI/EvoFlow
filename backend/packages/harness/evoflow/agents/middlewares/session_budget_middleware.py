"""Session tool/recursion budgets (opt-in) and delegate cooldown.

Tool-count warn/block and recursion soft-land (收尾交班 nudges) are **off by
default** — they starved long remake runs and left the model silent. Opt in with
``EVOFLOW_SESSION_TOOL_BUDGET=1`` / ``EVOFLOW_RECURSION_SOFT_LAND=1``.

Delegate cooldown after a subagent hits ``STEP_LIMIT_REACHED`` remains on.
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
from evoflow.runtime.long_run_limits import LONG_RUN_RECURSION_LIMIT

logger = logging.getLogger(__name__)

_WARN_TOOL_COUNT = int(os.environ.get("EVOFLOW_SESSION_TOOL_BUDGET_WARN", "300") or 300)
_HARD_TOOL_COUNT = int(os.environ.get("EVOFLOW_SESSION_TOOL_BUDGET_HARD", "500") or 500)
# Off by default: numeric + wrap-up nudges caused silent stalls on long chat runs.
_BUDGET_ENABLED = str(os.environ.get("EVOFLOW_SESSION_TOOL_BUDGET", "0")).strip().lower() in {
    "1",
    "true",
    "yes",
    "on",
}
_RECURSION_SOFT_ENABLED = str(os.environ.get("EVOFLOW_RECURSION_SOFT_LAND", "0")).strip().lower() in {
    "1",
    "true",
    "yes",
    "on",
}
# Remaining LangGraph super-steps → soft warn / hard block non-readonly tools.
_RECURSION_SOFT_REMAINING = max(20, int(os.environ.get("EVOFLOW_RECURSION_SOFT_REMAINING", "120") or 120))
_RECURSION_HARD_REMAINING = max(
    8,
    min(
        _RECURSION_SOFT_REMAINING - 1,
        int(os.environ.get("EVOFLOW_RECURSION_HARD_REMAINING", "40") or 40),
    ),
)
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
        "knowledge",
    }
)

# Injected by this middleware — must not count as a new user turn.
_BUDGET_MSG_PREFIX = "[会话工具预算"
_RECURSION_MSG_PREFIX = "[会话步数预算"

_WARN_MSG = f"{_BUDGET_MSG_PREFIX}] 自用户本轮消息起工具调用已超过 {_WARN_TOOL_COUNT} 次。请收口总结、减少重复探索，优先用已有结果完成回答。"
_BLOCK_MSG = f"{_BUDGET_MSG_PREFIX}·已拦截] 自用户本轮消息起工具调用已达 {_HARD_TOOL_COUNT} 次上限，非只读工具本次未执行。请根据已有结果输出结论，或向用户说明仍需的信息。"
_DELEGATE_COOLDOWN_MSG = "[子智能体冷却] 上次委派触达步数上限，60 秒内不再启动新子任务。请根据已有子智能体结果直接总结，不要重复 task/subagent。"
_RECURSION_SOFT_MSG = (
    f"{_RECURSION_MSG_PREFIX}·请收尾] 本轮图执行步数即将用尽（软预算）。"
    "请立刻用自然语言向用户说明：当前进展、未完成原因（例如后台任务/限流仍在跑）、"
    "建议用户下一步怎么做；停止 sleep/轮询式 bash；不要空转等结果。"
)
_RECURSION_HARD_MSG = (
    f"{_RECURSION_MSG_PREFIX}·强制收尾] 本轮图执行步数已接近硬上限，非只读工具已停用。"
    "请只输出文字结论给用户（进展/阻塞/如何续跑），禁止再调用工具；"
    "若后台任务仍在跑，明确告诉用户可稍后再查，不要继续 sleep 等待。"
)
_RECURSION_BLOCK_MSG = (
    f"{_RECURSION_MSG_PREFIX}·已拦截] 步数接近硬上限，非只读工具未执行。"
    "请根据已有结果用文字向用户收尾说明。"
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
    body = _human_content_str(message).lstrip()
    return body.startswith(_BUDGET_MSG_PREFIX) or body.startswith(_RECURSION_MSG_PREFIX)


def _langgraph_step_budget() -> tuple[int | None, int]:
    """Return ``(current_step, recursion_limit)`` from the active LangGraph config.

    ``langgraph_step`` is 0-based in metadata on current LangGraph builds; treat
    missing step as unknown (``None``) so we do not false-trigger soft land.
    """
    limit = int(LONG_RUN_RECURSION_LIMIT)
    step: int | None = None
    try:
        from langgraph.config import get_config

        cfg = get_config() or {}
        if not isinstance(cfg, dict):
            return None, limit
        raw_lim = cfg.get("recursion_limit")
        if raw_lim is not None:
            try:
                limit = max(1, int(raw_lim))
            except (TypeError, ValueError):
                pass
        meta = cfg.get("metadata") if isinstance(cfg.get("metadata"), dict) else {}
        raw_step = meta.get("langgraph_step")
        if raw_step is None:
            # Older / alternate keys seen in dumps
            raw_step = meta.get("step")
        if raw_step is not None:
            try:
                step = max(0, int(raw_step))
            except (TypeError, ValueError):
                step = None
    except Exception:
        return None, limit
    return step, limit


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
    """Delegate cooldown; optional tool/recursion budgets when env-enabled."""

    def __init__(self) -> None:
        super().__init__()
        self._lock = threading.Lock()
        self._tool_counts: dict[str, int] = defaultdict(int)
        self._turn_tokens: dict[str, str] = {}
        self._warned: set[str] = set()
        self._recursion_soft_warned: set[str] = set()
        self._recursion_hard_warned: set[str] = set()
        self._delegate_cooldown_until: dict[str, float] = {}

    def _budget_key_from_request(self, request: ToolCallRequest) -> str:
        return _effective_budget_key(getattr(request, "runtime", None))

    def _budget_key_from_runtime(self, runtime: Runtime) -> str:
        return _effective_budget_key(runtime)

    def _sync_user_turn(self, state: AgentState, runtime: Runtime) -> None:
        """Reset tool / recursion soft-land flags when the user sends a new message."""
        if not _BUDGET_ENABLED and not _RECURSION_SOFT_ENABLED:
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
            self._recursion_soft_warned.discard(budget_key)
            self._recursion_hard_warned.discard(budget_key)
            if prev:
                logger.info(
                    "Session tool budget reset for new user turn",
                    extra={"budget_key": budget_key, "turn": turn},
                )

    def _recursion_remaining(self) -> int | None:
        if not _RECURSION_SOFT_ENABLED:
            return None
        step, limit = _langgraph_step_budget()
        if step is None:
            return None
        return max(0, int(limit) - int(step))

    def _maybe_block(self, request: ToolCallRequest) -> ToolMessage | None:
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
        if _BUDGET_ENABLED and count >= _HARD_TOOL_COUNT and tool_name not in _READONLY_TOOLS:
            return ToolMessage(
                content=_BLOCK_MSG,
                tool_call_id=tool_call_id,
                name=tool_name,
                status="error",
            )
        remaining = self._recursion_remaining()
        if (
            remaining is not None
            and remaining <= _RECURSION_HARD_REMAINING
            and tool_name not in _READONLY_TOOLS
        ):
            return ToolMessage(
                content=_RECURSION_BLOCK_MSG,
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

    def _recursion_soft_land(self, state: AgentState, runtime: Runtime) -> dict | None:
        """Nudge (then force) wrap-up before GraphRecursionError kills the run silently."""
        if not _RECURSION_SOFT_ENABLED:
            return None
        self._sync_user_turn(state, runtime)
        budget_key = self._budget_key_from_runtime(runtime)
        if not budget_key:
            return None
        remaining = self._recursion_remaining()
        if remaining is None:
            return None
        step, limit = _langgraph_step_budget()
        if remaining <= _RECURSION_HARD_REMAINING:
            with self._lock:
                if budget_key in self._recursion_hard_warned:
                    return None
                self._recursion_hard_warned.add(budget_key)
                self._recursion_soft_warned.add(budget_key)
            logger.warning(
                "Session recursion hard soft-land (force wrap-up)",
                extra={
                    "budget_key": budget_key,
                    "remaining": remaining,
                    "step": step,
                    "limit": limit,
                },
            )
            return {"messages": [HumanMessage(content=_RECURSION_HARD_MSG)]}
        if remaining <= _RECURSION_SOFT_REMAINING:
            with self._lock:
                if budget_key in self._recursion_soft_warned:
                    return None
                self._recursion_soft_warned.add(budget_key)
            logger.warning(
                "Session recursion soft budget warning",
                extra={
                    "budget_key": budget_key,
                    "remaining": remaining,
                    "step": step,
                    "limit": limit,
                },
            )
            return {"messages": [HumanMessage(content=_RECURSION_SOFT_MSG)]}
        return None

    def _after_model_nudges(self, state: AgentState, runtime: Runtime) -> dict | None:
        # Prefer recursion soft-land over tool-count warn when both fire.
        rec = self._recursion_soft_land(state, runtime)
        if rec is not None:
            return rec
        return self._budget_warning(state, runtime)

    @override
    def before_model(self, state: AgentState, runtime: Runtime) -> dict | None:
        self._sync_user_turn(state, runtime)
        # Inject before the next model call so the model sees the wrap-up ask
        # even if the previous after_model slot was skipped.
        return self._recursion_soft_land(state, runtime)

    @override
    async def abefore_model(self, state: AgentState, runtime: Runtime) -> dict | None:
        self._sync_user_turn(state, runtime)
        return self._recursion_soft_land(state, runtime)

    @override
    def after_model(self, state: AgentState, runtime: Runtime) -> dict | None:
        return self._after_model_nudges(state, runtime)

    @override
    async def aafter_model(self, state: AgentState, runtime: Runtime) -> dict | None:
        return self._after_model_nudges(state, runtime)

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
