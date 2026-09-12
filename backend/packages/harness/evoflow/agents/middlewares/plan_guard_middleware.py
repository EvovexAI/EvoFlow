"""Phase-aware guard for tool calls in planning-like collaboration phases."""

from __future__ import annotations

import json
import logging
import re
from collections.abc import Awaitable, Callable
from typing import Any

from langchain.agents import AgentState
from langchain.agents.middleware import AgentMiddleware
from langchain.agents.middleware.types import ModelCallResult, ModelRequest, ToolCallRequest
from langchain_core.messages import AIMessage, ToolMessage
from langgraph.runtime import Runtime
from langgraph.types import Command

from evoflow.agents.middlewares.collab_cycle_trace_logging import write_cycle_trace
from evoflow.agents.middlewares.collab_cycle_trace_middleware import _ai_message_from_model_call_result
from evoflow.agents.middlewares.collab_lifecycle_cn_logging import log_collab_lifecycle_cn
from evoflow.collab.models import CollabPhase
from evoflow.collab.thread_collab import (
    load_merged_collab_phase,
    load_thread_collab_state,
    merge_thread_collab_state,
    save_thread_collab_state,
)
from evoflow.config.paths import get_paths
from evoflow.timeutil import utc_now_iso_z

logger = logging.getLogger(__name__)

PLANNING_GUARD_PHASES = frozenset(
    {
        CollabPhase.PLANNING.value,
        CollabPhase.PLAN_READY.value,
        CollabPhase.AWAITING_EXEC.value,
    }
)

# executing 及之后 Lead 用 supervisor 编排；planning/plan_ready/awaiting_exec 仍可能 strict plan 收紧。
_STRICT_PLAN_TERMINAL_PHASES = frozenset(
    {
        CollabPhase.EXECUTING.value,
        CollabPhase.PAUSED.value,
        CollabPhase.DONE.value,
    }
)

# plan 协作阶段（含 awaiting_exec）不向模型暴露 propose_goal：目标由 EvoPanel 外层触发，与 plan 门禁分层。


def _runtime_configurable() -> dict[str, Any]:
    try:
        from langgraph.config import get_config

        cfg = get_config() or {}
        raw = cfg.get("configurable")
        return dict(raw) if isinstance(raw, dict) else {}
    except Exception:
        return {}


def _pg_runtime_ctx(runtime: Any) -> dict[str, Any]:
    """Normalize ``runtime.context`` (dict or LeadAgentRuntimeContext) for middleware reads."""
    from evoflow.agents.lead_agent.runtime_context import runtime_context_mapping

    merged = runtime_context_mapping(runtime) if runtime is not None else {}
    if merged:
        return merged
    return _runtime_configurable()


def _pg_set_runtime_ctx(runtime: Any, **updates: Any) -> None:
    """Write fields back to ``runtime.context`` whether it is a dict or dataclass."""
    if not updates or runtime is None:
        return
    ctx = getattr(runtime, "context", None)
    if ctx is None:
        return
    for key, value in updates.items():
        try:
            if isinstance(ctx, dict):
                ctx[key] = value
            elif hasattr(ctx, "__setitem__"):
                ctx[key] = value
            elif hasattr(ctx, key):
                setattr(ctx, key, value)
        except Exception:
            pass


def session_allows_plan_scenario_activation(
    *,
    session_mode: str | None = None,
    collab_phase: Any = None,
    configurable: dict[str, Any] | None = None,
) -> bool:
    """Auto / Plan UI 模式，或任务协作（collab 非 idle）可激活/沿用 plan 场景。"""
    conf: dict[str, Any] = dict(configurable or {}) or _runtime_configurable()
    sm = str(session_mode or conf.get("session_mode") or "").strip().lower()
    if sm in ("auto", "plan"):
        return True
    phase = collab_phase if collab_phase is not None else conf.get("collab_phase")
    p = str(phase or "").strip().lower()
    return bool(p and p not in ("", "idle"))


def session_should_sync_plan_scenario_active(
    *,
    session_mode: str | None = None,
    collab_phase: Any = None,
    configurable: dict[str, Any] | None = None,
) -> bool:
    """任务协作（Plan）已开启时由程序注入 plan 场景与 plan 提示词，勿依赖模型 ``scenario(activate, plan)``。"""
    if not session_allows_plan_scenario_activation(
        session_mode=session_mode,
        collab_phase=collab_phase,
        configurable=configurable,
    ):
        return False
    conf: dict[str, Any] = dict(configurable or {}) or _runtime_configurable()
    phase = collab_phase if collab_phase is not None else conf.get("collab_phase")
    p = str(phase or "").strip().lower()
    if p and p not in ("", "idle"):
        return True
    sm = str(session_mode or conf.get("session_mode") or "").strip().lower()
    if sm == "plan":
        return True
    return conf.get("is_plan_mode") is True


def is_subagent_focus_mode(
    *,
    session_mode: str | None = None,
    collab_phase: Any = None,
    configurable: dict[str, Any] | None = None,
) -> bool:
    """任务协作（Plan）未开启：以 subagent 委派为主，任意会话模式均不自动切入 plan/planning。"""
    return not session_should_sync_plan_scenario_active(
        session_mode=session_mode,
        collab_phase=collab_phase,
        configurable=configurable,
    )


def plan_scenario_activation_blocked(scenario_key: str) -> tuple[bool, str]:
    """Allow plan scenario activation from any session state (no longer requires UI toggle)."""
    return False, ""


def subagent_focus_blocks_scenario_activate(scenario_key: str) -> tuple[bool, str]:
    """Always allow plan scenario activation (no longer gated by session state)."""
    return False, ""


PLANNING_ALLOWED_TOOL_NAMES = frozenset(
    {
        "read",
        "search_code_index",
        "ask_clarification",
        # 基础工具：list_agents 轻量查智能体列表，不属大范围能力摸底；主会话可直接调。
        "list_agents",
        # Align with ``scenario`` activate payloads: plan/workspace/web 等场景会声明可直接调用的工具；
        # 若在 planning 阶段仍拦截，则模型看不到与场景说明一致的 request.tools。
        "tool_search",
        # 结构化提交：以 ``plan`` 工具成功返回为准做 has_plan / 门禁（不以 AI 正文 # Plan 草稿为准）。
        "plan",
        # plan 协作下由 supervisor 工具自身返回 need_plan / need_execution_authorization，不在此 middleware 剥空调用。
        "supervisor",
        "scenario",
        "mode_set",
        # Planning-like：主会话只做调度；大范围只读调研可委派子代理（软约束见 prompt）。
        "subagent",
        "task",  # legacy tool name
        "collab_peer_send",
        "collab_peer_read",
        "collab_peer_reply",
        # ``write_todos`` intentionally omitted: plan 场景用 supervisor 子任务表，勿与会话内 todo 双轨（见 agent._create_todo_list_middleware）。
    }
)

# plan 已落库、等待「开始执行」：禁止 ask_clarification（由 EvoPanel PlanExecConfirm 承担），仅允许修订 plan / 只读 / supervisor。
PLAN_READY_ALLOWED_TOOL_NAMES = frozenset(
    n for n in PLANNING_ALLOWED_TOOL_NAMES if n != "ask_clarification"
)

AWAITING_EXEC_ALLOWED_TOOL_NAMES = frozenset(
    {
        "supervisor",
        "read",
        "search_code_index",
        "list_agents",
        # 允许在执行确认阶段修订并重新提交 Plan。
        "plan",
        # 允许在执行确认阶段切换场景 / 补齐延迟工具；否则会拦截 scenario，清空 tool_calls，回合提前结束。
        "scenario",
        "mode_set",
        "tool_search",
        "subagent",
        "task",
    }
)

VERIFYING_ALLOWED_TOOL_NAMES = frozenset(
    {
        "read",
        "search_code_index",
        "ask_clarification",
        "terminal",
        "bash",
        "process",
        # Plan 模式 bound 工具为 CORE + plan eager；与上方只读/终端工具无交集时会只剩 ask_clarification。
        # 验收后须 supervisor 关闭主任务（99%→100%）；tool_search/scenario 用于按需加载 read/terminal。
        "supervisor",
        "tool_search",
        "scenario",
        "mode_set",
        "list_agents",
        "subagent",
        "collab_peer_send",
        "collab_peer_read",
        "collab_peer_reply",
    }
)

REFLECTING_ALLOWED_TOOL_NAMES = frozenset(
    {
        "read",
        "search_code_index",
        "ask_clarification",
        "supervisor",
        "plan",
        "list_agents",
        "tool_search",
        "subagent",
        "task",
    }
)

VERIFYING_GUARD_PHASES = frozenset({CollabPhase.VERIFYING.value})
REFLECTING_GUARD_PHASES = frozenset({CollabPhase.REFLECTING.value})

# 已激活 plan 且未进入 executing/paused/done 时，主会话仅保留「澄清 + 场景切换 + plan/supervisor + 只读委派」，
# 禁止 tool_search 扩散其它工具；大范围摸底走 task。
# propose_goal 刻意不在此集合：目标由外层 EvoPanel 触发，不与 plan 协作阶段混用。
STRICT_PLAN_LEAD_TOOL_NAMES: frozenset[str] = frozenset(
    {
        "ask_clarification",
        "scenario",
        "mode_set",
        "tool_search",
        "plan",
        "supervisor",
        "subagent",
        "task",
        "read",
        "search_code_index",
        "list_agents",
        "collab_peer_send",
        "collab_peer_read",
        "collab_peer_reply",
    }
)


def _parse_scenario_tool_json(content: Any) -> dict[str, Any] | None:
    raw = str(content or "").strip()
    if not raw:
        return None
    try:
        d = json.loads(raw)
    except Exception:
        return None
    return d if isinstance(d, dict) else None


def _is_tool_message_for_scenario_replay(m: Any) -> bool:
    """LangGraph / LC 各版本里 ToolMessage 的 ``type`` 可能缺失；回放须仍能识别。"""
    if isinstance(m, ToolMessage):
        return True
    return str(getattr(m, "type", None) or "").strip().lower() == "tool"


def _replay_scenario_activation_keys_from_messages(messages: list[Any]) -> list[str]:
    """按时间顺序根据 ``scenario`` 工具返回重建 ``activated_scenarios``（优先 ``all_active_scenarios``）。"""
    from evoflow.agents.lead_agent.intent_tool_profile import normalize_scenario_key

    from evoflow.tools.tool_catalog import is_mode_set_tool

    active: list[str] = []
    for m in messages or []:
        if not _is_tool_message_for_scenario_replay(m):
            continue
        if not is_mode_set_tool(str(getattr(m, "name", "") or "")):
            continue
        d = _parse_scenario_tool_json(getattr(m, "content", ""))
        if not d:
            continue
        if str(d.get("status") or "").strip().lower() != "success":
            continue
        aa = d.get("all_active_scenarios")
        if isinstance(aa, list) and aa:
            active = []
            for x in aa:
                sx = str(x or "").strip().lower()
                if not sx or sx == "none":
                    continue
                nk = normalize_scenario_key(sx)
                if nk == "ask":
                    continue
                if nk not in active:
                    active.append(nk)
            continue
        action = str(d.get("action") or "").strip().lower()
        sk_raw = d.get("scenario_key")
        if not sk_raw:
            continue
        nk = normalize_scenario_key(str(sk_raw))
        if nk == "ask":
            continue
        if action == "activate":
            if nk not in active:
                active.append(nk)
        elif action == "deactivate":
            active = [x for x in active if x != nk]
    return active


def _effective_runtime_thread_id(runtime: Any) -> str:
    """``runtime.context`` 在部分模型调用（如摘要压缩后）可能缺少 thread_id；LangGraph configurable 仍有。"""
    tid = str(_pg_runtime_ctx(runtime).get("thread_id") or "").strip()
    if tid:
        return tid
    try:
        from langgraph.config import get_config

        tid = str(get_config().get("configurable", {}).get("thread_id") or "").strip()
    except Exception:
        pass
    return tid


def _plain_chat_runtime(runtime: Any) -> bool:
    """True when runtime context looks like idle chat (skip persisted scenario disk reads)."""
    ctx = _pg_runtime_ctx(runtime)
    if not ctx:
        return True
    phase = str(ctx.get("collab_phase") or "").strip().lower()
    if phase and phase not in ("", "idle"):
        return False
    if str(ctx.get("collab_task_id") or "").strip():
        return False
    return True


def effective_activated_scenario_keys(runtime: Any, messages: list[Any] | None) -> frozenset[str]:
    """合并 ContextVar、mission_state 持久化与对话内 scenario 工具回放。

    LangGraph / ToolNode 与 ``after_model`` 可能在不同 execution context 下运行，
    ``get_activated_scenarios()`` 的 ContextVar 尚未带上刚执行完的 ``scenario(activate)``；
    供 ``wrap_tool_call`` 判断场景是否已激活（未激活时返回结构化「工具未激活」而非静默剥调用）。
    """
    from evoflow.agents.lead_agent.intent_tool_profile import normalize_scenario_key

    keys: set[str] = set()
    msgs = list(messages or [])
    try:
        from evoflow.tools.builtins.scenario_activation import get_activated_scenarios

        for s in get_activated_scenarios() or []:
            raw = str(s or "").strip()
            if not raw:
                continue
            k = normalize_scenario_key(raw)
            if k != "ask":
                keys.add(k)
    except Exception:
        pass
    try:
        for k in _replay_scenario_activation_keys_from_messages(msgs):
            if k != "ask":
                keys.add(k)
    except Exception:
        pass
    if keys:
        return frozenset(keys)

    session_mode = str(_pg_runtime_ctx(runtime).get("session_mode") or "").strip().lower()
    if not session_mode:
        try:
            from langgraph.config import get_config

            session_mode = str(get_config().get("configurable", {}).get("session_mode") or "").strip().lower()
        except Exception:
            session_mode = ""
    if session_mode:
        try:
            from evoflow.agents.lead_agent.intent_tool_profile import scenario_keys_from_session_mode

            for k in scenario_keys_from_session_mode(session_mode):
                keys.add(k)
        except Exception:
            pass
    if keys:
        return frozenset(keys)

    tid = _effective_runtime_thread_id(runtime)
    if tid:
        try:
            from evoflow.persistence.session_repositories import (
                find_session_key_by_thread_id,
                get_session_activated_scenarios,
            )

            session_key = find_session_key_by_thread_id(tid)
            if session_key:
                for s in get_session_activated_scenarios(session_key):
                    raw = str(s or "").strip()
                    if not raw:
                        continue
                    k = normalize_scenario_key(raw)
                    if k != "ask":
                        keys.add(k)
                return frozenset(keys)
        except Exception:
            pass
        if not _plain_chat_runtime(runtime):
            try:
                from evoflow.collab.thread_collab import load_thread_collab_state
                from evoflow.config.paths import get_paths

                cc = load_thread_collab_state(get_paths(), tid)
                for s in cc.activated_scenarios or []:
                    raw = str(s or "").strip()
                    if not raw:
                        continue
                    k = normalize_scenario_key(raw)
                    if k != "ask":
                        keys.add(k)
            except Exception:
                pass
        try:
            from evoflow.agents.mission_state.storage import load_mission_state

            ms = load_mission_state(tid)
            if ms is not None:
                for s in getattr(ms, "activated_scenarios", None) or []:
                    raw = str(s or "").strip()
                    if not raw:
                        continue
                    k = normalize_scenario_key(raw)
                    if k != "ask":
                        keys.add(k)
        except Exception:
            pass
    return frozenset(keys)


def is_strict_plan_collaboration_for_thread(thread_id: str, ctx_collab_phase: Any = None) -> bool:
    if not session_allows_plan_scenario_activation(collab_phase=ctx_collab_phase):
        return False
    if is_subagent_focus_mode(collab_phase=ctx_collab_phase):
        return False
    tid = str(thread_id or "").strip()
    if not tid:
        return False
    try:
        from evoflow.tools.builtins.scenario_activation import get_activated_scenarios

        active = {str(s or "").strip().lower() for s in (get_activated_scenarios() or [])}
    except Exception:
        active = set()
    if "plan" not in active:
        return False
    base = load_merged_collab_phase(get_paths(), tid, ctx_collab_phase)
    if base in _STRICT_PLAN_TERMINAL_PHASES:
        return False
    return True


def is_strict_plan_collaboration(runtime: Any, messages: list[Any] | None = None) -> bool:
    ctx = _pg_runtime_ctx(runtime)
    return is_strict_plan_collaboration_for_thread(str(ctx.get("thread_id") or "").strip(), ctx.get("collab_phase"))


def strict_plan_lock_blocks_scenario_activate(scenario_key: str) -> tuple[bool, str]:
    """Under strict plan collaboration, reject activating any scenario other than ``plan``."""
    key = str(scenario_key or "").strip().lower()
    if key == "plan":
        return False, ""
    try:
        from langgraph.config import get_config

        cfg = get_config() or {}
        conf = cfg.get("configurable") or {}
        tid = str(conf.get("thread_id") or "").strip()
        ctx_phase = conf.get("collab_phase")
    except Exception:
        tid, ctx_phase = "", None
    if not is_strict_plan_collaboration_for_thread(tid, ctx_phase):
        return False, ""
    return (
        True,
        "当前处于 Plan 协作流程中（含开始执行/executing）：禁止 activate agent。"
        "改文件/跑命令请经 supervisor 委派。"
        "若任务卡壳或用户要换模式：须先用 supervisor 将主任务取消（cancelled）或置失败（failed），协作 done 后再切换；勿半途 bypass。",
    )


def _allowed_tool_names_for_phase(phase: str) -> frozenset[str]:
    p = str(phase or "").strip().lower()
    if p == CollabPhase.VERIFYING.value:
        return VERIFYING_ALLOWED_TOOL_NAMES
    if p == CollabPhase.REFLECTING.value:
        return REFLECTING_ALLOWED_TOOL_NAMES
    if p == CollabPhase.AWAITING_EXEC.value:
        return AWAITING_EXEC_ALLOWED_TOOL_NAMES
    if p == CollabPhase.PLAN_READY.value:
        return PLAN_READY_ALLOWED_TOOL_NAMES
    return PLANNING_ALLOWED_TOOL_NAMES


def _allowed_tool_names_for_guard(
    phase: str,
    messages: list[Any] | None,
    *,
    runtime: Runtime | None = None,
) -> frozenset[str]:
    """plan 已成功落库后不再暴露 ask_clarification（执行确认由 UI 承担）。"""
    names = set(_allowed_tool_names_for_phase(phase))
    msgs = list(messages or [])
    has_plan = _messages_contain_successful_plan_tool(msgs)
    if not has_plan and runtime is not None:
        tid, disk_bound = _thread_id_and_disk_bound(runtime)
        if tid:
            has_plan = _persistence_indicates_committed_plan(tid, disk_bound)
    if has_plan:
        names.discard("ask_clarification")
    return frozenset(names)


def _phase_is_idle_like(phase: str) -> bool:
    p = str(phase or "").strip().lower()
    return p == "" or p == CollabPhase.IDLE.value


def _tool_call_name(tool_call: Any) -> str:
    if isinstance(tool_call, dict):
        return str(tool_call.get("name", "")).strip()
    return str(getattr(tool_call, "name", "")).strip()


def _tool_call_id(tool_call: Any) -> str:
    if isinstance(tool_call, dict):
        return str(tool_call.get("id", "") or "").strip()
    return str(getattr(tool_call, "id", "") or "").strip()


def _loaded_deferred_tool_names_from_state(state: dict[str, Any] | None) -> set[str]:
    if not isinstance(state, dict):
        return set()
    from evoflow.agents.thread_state import EVF_REPLACE_LOADED_DEFERRED_MARKER

    raw = state.get("loaded_deferred_tools")
    if not isinstance(raw, list):
        return set()
    out: set[str] = set()
    for x in raw:
        s = str(x or "").strip()
        if s and s != EVF_REPLACE_LOADED_DEFERRED_MARKER:
            out.add(s)
    return out


def _runtime_allowed_tool_names(request: ToolCallRequest) -> set[str]:
    from evoflow.agents.lead_agent.intent_tool_profile import resolve_tools_for_scenarios

    state = request.state if isinstance(request.state, dict) else {}
    messages = list(state.get("messages") or [])
    active = list(effective_activated_scenario_keys(getattr(request, "runtime", None), messages))
    allowed = set(resolve_tools_for_scenarios(active))
    allowed.update(_loaded_deferred_tool_names_from_state(state))
    return allowed


def _build_scenario_not_activated_tool_message(
    tool_name: str,
    *,
    tool_call_id: str,
    candidate_scenarios: list[str],
) -> ToolMessage:
    from evoflow.agents.lead_agent.intent_tool_profile import recommended_scenario_for_tool
    from evoflow.agents.tool_response_envelope import tool_result_json_error

    scenarios = [str(s or "").strip() for s in (candidate_scenarios or []) if str(s or "").strip()]
    primary = recommended_scenario_for_tool(tool_name, scenarios)
    ordered = [primary] + [s for s in scenarios if s != primary]
    if len(ordered) > 1:
        opts = ", ".join(repr(s) for s in ordered)
        activate_hint = f"请先 scenario(action=activate, scenario_key=…, reason=…) 激活其中任一场景（可选: {opts}；推荐 {primary!r}）"
    else:
        activate_hint = f"请先 scenario(action=activate, scenario_key={primary!r}, reason=...) 成功后再重试"
    one_liner = f"scenario(action='activate', scenario_key='{primary}', reason='enable {tool_name}')"
    msg = (
        f"Error: 工具「{tool_name}」未激活（{activate_hint}）。"
        f"可复制: {one_liner} "
        f"若工具列在 <tools_not_in_request>，也可在场景激活后用 tool_search 补齐 schema。勿在未激活时重复执行或对用户宣称已完成。"
    )
    body = tool_result_json_error(
        msg,
        error_type="ScenarioNotActivated",
        extra={
            "tool_name": tool_name,
            "required_scenario": primary,
            "candidate_scenarios": ordered,
        },
    )
    return ToolMessage(
        content=body,
        tool_call_id=tool_call_id or "missing_tool_call_id",
        name=tool_name,
        status="error",
    )


def _build_deferred_tool_search_required_message(tool_name: str, *, tool_call_id: str) -> ToolMessage:
    from evoflow.agents.tool_response_envelope import tool_result_json_error

    msg = f"Error: 工具「{tool_name}」未激活（延迟工具须先 tool_search 拉取 schema，且对应模式已 activate）。请先 mode_set / tool_search 后再重试。"
    body = tool_result_json_error(
        msg,
        error_type="DeferredToolNotActivated",
        extra={"tool_name": tool_name},
    )
    return ToolMessage(
        content=body,
        tool_call_id=tool_call_id or "missing_tool_call_id",
        name=tool_name,
        status="error",
    )


def _build_phase_blocked_tool_message(
    tool_name: str,
    *,
    tool_call_id: str,
    phase: str,
    is_strict: bool = False,
) -> ToolMessage:
    """Inject a ToolMessage when a tool is blocked by the plan-guard phase filter.

    Unlike the silent strip, this gives the model actionable feedback so it can
    self-correct (use subagent, switch scenario, etc.) instead of emitting an
    empty turn.
    """
    from evoflow.agents.tool_response_envelope import tool_result_json_error

    scope = "strict plan" if is_strict else f"阶段 {phase}"
    msg = (
        f"Error: 工具「{tool_name}」在当前{scope}下不可用。"
        f"plan 模式下主会话仅做规划与调度，不直接执行代码操作。"
        f"请改用 subagent 委派执行，或用 scenario(action=activate, scenario_key='agent') 切换到 Agent 模式后再重试。"
        f"勿重复调用此工具。"
    )
    body = tool_result_json_error(
        msg,
        error_type="PhaseToolBlocked",
        extra={
            "tool_name": tool_name,
            "phase": phase,
            "is_strict_plan": is_strict,
        },
    )
    return ToolMessage(
        content=body,
        tool_call_id=tool_call_id or "missing_tool_call_id",
        name=tool_name,
        status="error",
    )


def _build_supervisor_stripped_feedback_message(
    tool_name: str,
    *,
    tool_call_id: str,
    collab_phase: str,
) -> ToolMessage:
    """Feedback when supervisor is silently stripped after collab ends or outside plan."""
    from evoflow.agents.tool_response_envelope import tool_result_json_error

    phase = str(collab_phase or "").strip().lower()
    if phase == CollabPhase.DONE.value:
        msg = (
            f"Error: 工具「{tool_name}」在协作已结束（collab_phase=done）后不可用。"
            "主任务已进入终态，supervisor 监控轮已关闭。"
            "请直接向用户输出交付总结（成果、证据、遗留风险），勿再调用 supervisor 查询状态。"
        )
    else:
        msg = (
            f"Error: 工具「{tool_name}」在当前阶段不可用（未激活 plan 场景或协作已结束）。"
            "请用 Agent 模式工具继续后续工作，或直接以文字回复用户；勿重复调用 supervisor。"
        )
    body = tool_result_json_error(
        msg,
        error_type="SupervisorStripped",
        extra={"tool_name": tool_name, "collab_phase": phase or "idle"},
    )
    return ToolMessage(
        content=body,
        tool_call_id=tool_call_id or "missing_tool_call_id",
        name=tool_name,
        status="error",
    )


EMPTY_TURN_NUDGE_TOOL_CALL_ID = "plan_guard_empty_turn_nudge"
EMPTY_TURN_NUDGE_TOOL_NAME = "plan_guard_nudge"


def _build_empty_model_turn_nudge_tool_message(
    *,
    tool_call_id: str,
    phase: str,
    hint: str,
) -> ToolMessage:
    """Synthetic tool feedback so LangGraph routes back to model (artificial tool messages)."""
    from evoflow.agents.tool_response_envelope import tool_result_json_error

    body = tool_result_json_error(
        hint,
        error_type="EmptyModelTurnNudge",
        extra={"collab_phase": str(phase or "").strip().lower() or "unknown"},
    )
    return ToolMessage(
        content=body,
        tool_call_id=tool_call_id or EMPTY_TURN_NUDGE_TOOL_CALL_ID,
        name=EMPTY_TURN_NUDGE_TOOL_NAME,
        status="error",
    )


def _build_empty_model_turn_recovery(
    last: AIMessage,
    *,
    phase: str,
    messages: list[Any],
    runtime: Runtime,
    reason: str,
) -> dict[str, Any]:
    """Recover from empty assistant turn: user-visible fallback + model nudge ToolMessage."""
    user_text = _latest_user_text(messages)
    p = str(phase or "").strip().lower()
    if p == CollabPhase.DONE.value:
        reply = (
            "协作任务已结束。请向用户输出最终交付总结：已完成项、关键产物路径、验证结果与遗留风险；"
            "勿再调用 supervisor 或派发子任务。"
        )
        nudge_hint = reply
    else:
        reply = _build_plan_empty_turn_reply(p, messages, runtime, user_text)
        nudge_hint = (
            "模型上一轮返回空内容且无工具调用。"
            f"当前协作阶段={p or 'unknown'}。"
            "请根据上一条用户消息继续：调用合适工具或直接文字回复；勿重复空回合。"
        )
        if reply:
            nudge_hint = f"{nudge_hint}\n\n用户可见提示参考：{reply}"

    _log_empty_model_turn(
        runtime,
        phase=p,
        messages=messages,
        snap=_pg_ai_snapshot(last),
        reason=reason,
    )
    try:
        write_cycle_trace(
            "plan_guard_empty_turn_recovery",
            {
                "thread_id": _pg_thread_id(runtime),
                "collab_phase": p,
                "reason": reason,
                "user_text_preview": user_text[:200],
            },
        )
    except Exception:
        pass

    nudge_id = EMPTY_TURN_NUDGE_TOOL_CALL_ID
    ai = last.model_copy(
        update={
            "content": reply,
            "tool_calls": [
                {
                    "id": nudge_id,
                    "name": EMPTY_TURN_NUDGE_TOOL_NAME,
                    "args": {},
                    "type": "tool_call",
                }
            ],
        }
    )
    nudge_msg = _build_empty_model_turn_nudge_tool_message(
        tool_call_id=nudge_id,
        phase=p,
        hint=nudge_hint,
    )
    return {"messages": [ai, nudge_msg]}


def _inject_blocked_tool_feedback(
    last: AIMessage,
    *,
    blocked_calls: list[Any],
    phase: str,
    is_strict: bool = False,
) -> dict[str, Any]:
    """Keep original tool_calls; inject ToolMessage for blocked ones so the agent loop continues."""
    blocked_tool_messages = [
        _build_phase_blocked_tool_message(
            _tool_call_name(tc),
            tool_call_id=_tool_call_id(tc),
            phase=phase,
            is_strict=is_strict,
        )
        for tc in blocked_calls
    ]
    return {"messages": [last, *blocked_tool_messages]}


def _gate_tool_without_required_scenario(request: ToolCallRequest) -> ToolMessage | None:
    """Return a synthetic tool result when a scenario-governed tool is called without activation."""
    from evoflow.agents.automation_runtime import is_unattended_automation
    from evoflow.agents.lead_agent.intent_tool_profile import (
        CORE_TOOL_NAMES,
        all_scenario_governed_tool_names,
        scenarios_granting_tool,
    )

    if is_unattended_automation(getattr(request, "runtime", None)):
        return None

    # Duty runs use a flat agent∪duty catalog — no scenario/tool_search activation gate.
    try:
        from evoflow.agents.middlewares.proactive_tool_middleware import is_proactive_run

        if is_proactive_run(getattr(request, "runtime", None)):
            return None
    except Exception:
        pass

    tc = request.tool_call or {}
    name = _tool_call_name(tc)
    if not name or name in CORE_TOOL_NAMES:
        return None
    if name not in all_scenario_governed_tool_names():
        return None
    if name in _runtime_allowed_tool_names(request):
        return None

    scenarios = scenarios_granting_tool(name)
    if scenarios:
        return _build_scenario_not_activated_tool_message(
            name,
            tool_call_id=_tool_call_id(tc),
            candidate_scenarios=scenarios,
        )

    try:
        from evoflow.tools.builtins.tool_search import get_deferred_registry

        registry = get_deferred_registry()
        if registry and name in {e.name for e in registry.entries}:
            return _build_deferred_tool_search_required_message(name, tool_call_id=_tool_call_id(tc))
    except Exception:
        pass
    return None


def _trace_scenario_not_activated_tool_result(request: ToolCallRequest, result: ToolMessage) -> None:
    try:
        from evoflow.agents.tool_response_envelope import parse_tool_envelope

        meta = parse_tool_envelope(getattr(result, "content", None)) or {}
        ctx = getattr(request, "runtime", None)
        ctx = (ctx.context or {}) if ctx is not None and hasattr(ctx, "context") else {}
        write_cycle_trace(
            "plan_guard_scenario_not_activated_tool_result",
            {
                "thread_id": str(ctx.get("thread_id") or ""),
                "tool_name": _tool_call_name(request.tool_call or {}),
                "required_scenario": meta.get("required_scenario"),
                "candidate_scenarios": meta.get("candidate_scenarios"),
                "error_type": meta.get("error_type"),
            },
        )
    except Exception:
        pass


def _message_text(content: Any) -> str:
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts: list[str] = []
        for x in content:
            if isinstance(x, str):
                parts.append(x)
            elif isinstance(x, dict):
                t = x.get("text")
                if isinstance(t, str):
                    parts.append(t)
        return "".join(parts).strip()
    return str(content or "").strip()


def _tool_call_args(tool_call: Any) -> dict[str, Any]:
    raw: Any = {}
    if isinstance(tool_call, dict):
        raw = tool_call.get("args", tool_call.get("arguments", {}))
    else:
        raw = getattr(tool_call, "args", {})
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
            return parsed if isinstance(parsed, dict) else {}
        except Exception:
            return {}
    return {}


def _has_authoritative_create_task_with_subtasks(tool_calls: list[Any]) -> bool:
    """True when the model already sent ``supervisor(create_task_with_subtasks)`` with a non-empty subtasks list."""
    for tc in tool_calls or []:
        if _tool_call_name(tc) != "supervisor":
            continue
        args = _tool_call_args(tc)
        if str(args.get("action") or "").strip() != "create_task_with_subtasks":
            continue
        subs = args.get("subtasks")
        if isinstance(subs, list) and len(subs) >= 1:
            return True
    return False


def _looks_like_plan_output_text(text: str) -> bool:
    t = str(text or "").strip()
    if not t:
        return False
    if t.startswith("# Plan"):
        return True
    head = "\n".join(str(line) for line in t.splitlines()[:48])
    for line in head.splitlines():
        stripped = line.strip()
        if stripped.startswith("# Plan"):
            return True
        # Markdown 标题行内的「执行计划」更像正式小节；裸子串「执行计划」会命中大量口语（如「制定执行计划」）。
        if stripped.startswith("#") and "执行计划" in stripped:
            return True
    return "任务执行计划" in t


def _plan_tool_calls_body_acceptable(tool_calls: list[Any] | None) -> bool:
    """True if current AIMessage includes ``plan(goal, steps=[…])`` or renderable plan body."""

    for tc in tool_calls or []:
        if _tool_call_name(tc) != "plan":
            continue
        args = _tool_call_args(tc)
        steps = args.get("steps")
        if isinstance(steps, str) and steps.strip().startswith("["):
            try:
                steps = json.loads(steps)
            except Exception:
                steps = None
        if isinstance(steps, list) and len(steps) > 0 and str(args.get("goal") or "").strip():
            return True
    return False


def _build_need_plan_before_supervisor_tool_call() -> dict[str, Any]:
    """尚无成功 ``plan`` 工具落库时若模型只打了 supervisor，勿清空回合；注入结构化澄清（固定模板）。"""
    q = (
        "【原因】当前为 plan 协作：系统尚未收到 **`plan` 工具成功落库**的计划，因此已拦截你刚才的 **`supervisor`** 调用"
        "（避免未立项就建任务）。\n"
        "【正确顺序】① 用 **`task`/`subagent`** 完成需求取证/调研摸底/智能体能力盘点（主会话不亲自大范围读库）；"
        "② 三项成立后 **`plan(goal, steps[])`**；③ **等待用户**在界面点「开始执行」（网关自动派发首波）；"
        "④ 你用 **`supervisor(monitor_execution_step)`** 监工（仅补派/重试时才 `start_execution`）。\n"
        "【易错点】`plan` 成功后不要立刻 `start_execution`；用户说「执行/跑一下」也不等于可跳过落库与授权。\n"
        "请选择下一步："
    )
    return {
        "id": "call_plan_guard_need_plan_first",
        "name": "ask_clarification",
        "args": {
            "question": q,
            "options": [
                "我在对话中补充可执行的需求说明（推荐）",
                "我将调用 `plan` 工具自行撰写并提交完整计划",
                "其他（请补充说明）",
            ],
            "allow_multiple": False,
        },
    }


def _is_supervisor_start_execution_tool_call(tool_call: Any) -> bool:
    if _tool_call_name(tool_call) != "supervisor":
        return False
    args = _tool_call_args(tool_call)
    return str(args.get("action") or "").strip() == "start_execution"


def _build_supervisor_start_execution_tool_call(task_id: str) -> dict[str, Any]:
    return {
        "id": "call_auto_start_execution",
        "name": "supervisor",
        "args": {
            "action": "start_execution",
            "task_id": str(task_id or "").strip(),
            "authorized_by": "lead",
        },
    }


def _has_supervisor_task_creation_tool_call(tool_calls: list[Any]) -> bool:
    for tc in tool_calls:
        if _tool_call_name(tc) != "supervisor":
            continue
        a = str(_tool_call_args(tc).get("action") or "").strip()
        if a in {"create_task", "create_task_with_subtasks", "create_subtasks", "create_subtask"}:
            return True
    return False


def _build_supervisor_create_task_with_subtasks_tool_call(*, user_hint: str) -> dict[str, Any]:
    """Minimal valid one-shot task for common execute / E2E flows (≥20 char description)."""
    hint = str(user_hint or "").strip()
    desc = f"目标：按用户已确认的计划落地执行并交付验收产物。上下文：{hint}" if hint else ("目标：按已确认计划执行任务并交付可验收产物；范围：实现用户提出的文件/命令类交付；输出：在每个子任务中写明完成说明。")
    if len(desc) < 20:
        desc = desc + "；请完成各子任务并写出结果摘要。"
    subtasks: list[dict[str, Any]] = [
        {
            "name": "生成 task1.txt",
            "description": "创建工作区文件 task1.txt，并写入一行完成说明（可并行准备，但建议先完成以固定路径）。",
            "assigned_to": "general-purpose",
        },
        {
            "name": "生成 task2.txt",
            "description": "创建工作区文件 task2.txt，并写入一行完成说明（与 task3 均依赖步骤 1，可与 task3 并行）。",
            "assigned_to": "general-purpose",
            "depends_on": ["1"],
        },
        {
            "name": "生成 task3.txt",
            "description": "创建工作区文件 task3.txt，并写入一行完成说明（与 task2 并行，仅依赖步骤 1）。",
            "assigned_to": "general-purpose",
            "depends_on": ["1"],
        },
    ]
    return {
        "id": "call_auto_create_task_with_subtasks",
        "name": "supervisor",
        "args": {
            "action": "create_task_with_subtasks",
            "task_name": "协作执行任务",
            "task_description": desc[:4000],
            "subtasks": subtasks,
        },
    }


def _resolve_collab_main_task_id_and_row(
    *,
    thread_id: str,
    disk_bound: str,
) -> tuple[str, dict[str, Any] | None]:
    """Match sidebar snapshot logic: disk bound_task_id or latest root task for this thread."""
    from evoflow.collab.storage import find_main_task, get_project_storage
    from evoflow.collab.task_progress_snapshot import build_task_progress_snapshot

    tid = str(thread_id or "").strip()
    if not tid:
        return "", None

    b = str(disk_bound or "").strip()
    if b:
        row = find_main_task(get_project_storage(), b)
        if row:
            _p, task = row
            bt = str(task.get("thread_id") or "").strip()
            if not bt or bt == tid:
                return b, task

    try:
        snap = build_task_progress_snapshot(get_paths(), tid)
        mt = snap.get("main_task") or {}
        mid = str(mt.get("taskId") or "").strip()
        if not mid:
            return "", None
        row2 = find_main_task(get_project_storage(), mid)
        if row2:
            return mid, row2[1]
    except Exception:
        pass
    return "", None


def _main_task_is_terminal(task: dict[str, Any] | None) -> bool:
    if not task:
        return False
    s = str(task.get("status") or "").strip().lower()
    return s in {"completed", "failed", "cancelled"}


def _main_task_allows_auto_start_execution(task: dict[str, Any] | None) -> bool:
    if not task:
        return False
    s = str(task.get("status") or "").strip().lower()
    return s in {"pending", "planned", "planning", "waiting_dispatch", "paused", ""}


def _thread_id_and_disk_bound(runtime: Runtime) -> tuple[str, str]:
    ctx = runtime.context or {}
    tid = str(ctx.get("thread_id") or "").strip()
    if not tid:
        return "", ""
    try:
        disk_st = load_thread_collab_state(get_paths(), tid)
        return tid, str(getattr(disk_st, "bound_task_id", "") or "").strip()
    except Exception:
        return tid, ""


def _persistence_indicates_committed_plan(thread_id: str, disk_bound: str) -> bool:
    """True when the bound main task row carries plan markdown."""
    from evoflow.collab.plan_on_task import thread_has_committed_plan_on_task

    tid = str(thread_id or "").strip()
    if not tid:
        return False
    bound = str(disk_bound or "").strip()
    if not bound:
        _, bound = _thread_id_and_disk_bound_from_tid(tid)
    return thread_has_committed_plan_on_task(tid, disk_bound=bound)


def _persistence_indicates_execution_authorized(thread_id: str, disk_bound: str) -> bool:
    """True when the thread-bound main task was authorized to execute (persists after checkpoint trims)."""
    tid = str(thread_id or "").strip()
    if not tid:
        return False
    _mid, task = _resolve_collab_main_task_id_and_row(thread_id=tid, disk_bound=disk_bound)
    if not task or _main_task_is_terminal(task):
        return False
    return bool(task.get("execution_authorized"))


def collaboration_has_committed_plan(thread_id: str, disk_bound: str = "") -> bool:
    """Public: whether this thread has a persisted Plan on the bound main task."""
    tid = str(thread_id or "").strip()
    if not tid:
        return False
    bound = str(disk_bound or "").strip()
    if not bound:
        _, bound = _thread_id_and_disk_bound_from_tid(tid)
    return _persistence_indicates_committed_plan(tid, bound)


def collaboration_has_execution_authorization(thread_id: str, disk_bound: str = "") -> bool:
    """Public: whether the bound main task is authorized for execution."""
    tid = str(thread_id or "").strip()
    if not tid:
        return False
    bound = str(disk_bound or "").strip()
    if not bound:
        _, bound = _thread_id_and_disk_bound_from_tid(tid)
    return _persistence_indicates_execution_authorized(tid, bound)


def _thread_id_and_disk_bound_from_tid(thread_id: str) -> tuple[str, str]:
    tid = str(thread_id or "").strip()
    if not tid:
        return "", ""
    try:
        disk_st = load_thread_collab_state(get_paths(), tid)
        return tid, str(getattr(disk_st, "bound_task_id", "") or "").strip()
    except Exception:
        return tid, ""


def _latest_user_text(messages: list[Any]) -> str:
    from evoflow.agents.message_analysis_utils import is_real_user_message

    for m in reversed(messages):
        if not is_real_user_message(m):
            continue
        txt = _message_text(getattr(m, "content", None) if not isinstance(m, dict) else m.get("content"))
        if txt:
            return txt
    return ""


def _plan_revision_intent(text: str) -> bool:
    from evoflow.collab.execution_lifecycle import user_execution_start_intent

    t = str(text or "").strip()
    if not t or user_execution_start_intent(t):
        return False
    patterns = (
        r"新计划",
        r"重新规划",
        r"重新计划",
        r"再做.{0,8}计划",
        r"做一个.{0,8}计划",
        r"规划.{0,8}任务",
        r"改计划",
        r"改一下",
        r"修订",
        r"更新计划",
        r"调整计划",
        r"重新列出",
        r"列出.{0,8}计划",
    )
    return any(re.search(p, t, flags=re.IGNORECASE) for p in patterns)


def _has_open_committed_plan_on_disk(thread_id: str, disk_bound: str) -> bool:
    """Disk plan that still belongs to an active (non-terminal) main task.

    Completed/cancelled tasks keep plan markdown for history but must not force
    ``plan_ready`` when the user returns to workspace Q&A and starts a new plan cycle.
    """
    if not _persistence_indicates_committed_plan(thread_id, disk_bound):
        return False
    _mid, task = _resolve_collab_main_task_id_and_row(thread_id=thread_id, disk_bound=disk_bound)
    return not _main_task_is_terminal(task)


def _fresh_planning_after_workspace_chat(messages: list[Any], runtime: Runtime) -> bool:
    """User explicitly starts a new planning turn after idle/workspace chat."""
    user_text = _latest_user_text(messages)
    if not _plan_revision_intent(user_text):
        return False
    if _messages_contain_successful_plan_tool(messages):
        return False
    active = set(effective_activated_scenario_keys(runtime, messages))
    return "plan" not in active


def _has_plan_message(messages: list[Any]) -> bool:
    """Deprecated: AI 正文 # Plan 不再参与门禁；保留占位避免外部误 import 崩溃。"""
    return False


def _tool_message_plan_tool_succeeded(content: Any) -> bool:
    """``plan`` 工具 ToolMessage：仅以 JSON ``success`` 为准（与 ``plan_tool`` 返回一致）。"""
    raw = str(content or "").strip()
    if not raw:
        return False
    try:
        d = json.loads(raw)
    except Exception:
        return False
    return isinstance(d, dict) and bool(d.get("success"))


def _tool_message_submitted_plan(content: Any) -> bool:
    """Alias for plan-tool success detection (historical name)."""
    return _tool_message_plan_tool_succeeded(content)


def _messages_contain_successful_plan_tool(messages: list[Any]) -> bool:
    """历史中出现过成功的 ``plan`` 工具返回。"""
    for m in messages or []:
        if not _is_tool_message_for_scenario_replay(m):
            continue
        name = str(getattr(m, "name", "") or "").strip().lower()
        if name == "plan" and _tool_message_plan_tool_succeeded(getattr(m, "content", "")):
            return True
    return False


def _conversation_has_plan(messages: list[Any], *, tail_ai_content: str = "") -> bool:
    """仅统计已成功执行的 ``plan`` 工具 ToolMessage；忽略 ``tail_ai_content`` 与 AI 正文草稿。"""
    _ = tail_ai_content
    return _messages_contain_successful_plan_tool(messages)


def _is_execute_confirmation_from_structured_answer(text: str) -> bool:
    raw = str(text or "").strip()
    prefix = "__EVF_CLARIFY_ANS_V1__:"
    if not raw.startswith(prefix):
        return False
    payload_text = raw[len(prefix) :].strip()
    if not payload_text:
        return False
    try:
        payload = json.loads(payload_text)
    except Exception:
        return False
    if not isinstance(payload, dict):
        return False
    answers = payload.get("answers")
    if not isinstance(answers, list):
        return False
    for ans in answers:
        if not isinstance(ans, dict):
            continue
        labels = ans.get("selected_option_labels")
        if isinstance(labels, list):
            for lb in labels:
                s = str(lb or "").strip()
                if "开始执行" in s or "按计划开始执行" in s:
                    return True
    free_text = str(payload.get("free_text") or "").strip().lower()
    if free_text and ("开始执行" in free_text or "按计划执行" in free_text or "start execution" in free_text):
        return True
    return False


def _build_plan_fallback(user_text: str) -> str:
    goal = user_text.replace("\n", " ").strip()
    if len(goal) > 120:
        goal = goal[:117] + "..."
    return (
        "# Plan\n\n"
        f"## Goal\n{goal or '根据用户请求完成任务。'}\n\n"
        "## Scope\n"
        "- 仅进行规划与澄清，不执行副作用操作\n"
        "- 明确执行步骤、依赖关系与验收标准\n\n"
        "## Action Items\n"
        "1. 梳理任务目标与输入输出\n"
        "2. 拆分可执行子任务并定义依赖\n"
        "3. 列出执行与验证步骤\n"
        "4. 等待用户授权后进入执行阶段\n\n"
        "## Open Questions\n"
        "- 当前无（如需补充将继续澄清）\n"
    )


def _planning_like_has_committed_plan(messages: list[Any], runtime: Runtime) -> bool:
    if _messages_contain_successful_plan_tool(messages):
        return True
    tid, disk_bound = _thread_id_and_disk_bound(runtime)
    return bool(tid) and _persistence_indicates_committed_plan(tid, disk_bound)


def _build_plan_empty_turn_reply(
    phase: str,
    messages: list[Any],
    runtime: Runtime,
    user_text: str,
) -> str:
    """User-visible fallback when the model returns an empty planning-like turn."""
    p = str(phase or "").strip().lower()
    if _planning_like_has_committed_plan(messages, runtime) and p in {
        CollabPhase.PLAN_READY.value,
        CollabPhase.AWAITING_EXEC.value,
        CollabPhase.IDLE.value,
    }:
        hint = user_text.replace("\n", " ").strip()
        if hint and _plan_revision_intent(hint):
            return (
                f"收到，您希望重新规划（{hint[:120]}）。"
                "模型本轮未返回有效内容；请补充目标、范围或约束，我将调用 `plan` 工具更新 Steps。"
            )
        if hint:
            return (
                "计划已落库。**执行**：请在页面点击「开始执行」，或在对话中说明「开始执行」。"
                f"**修订**：请说明要改的部分，我会调用 `plan` 工具更新 Steps（例如：{hint[:120]}）。"
            )
        return (
            "计划已落库。**下一步**：请在页面点击「开始执行」启动协作；"
            "若需改计划，直接说明修改点，我会调用 `plan` 工具重新提交 Steps。"
        )
    return _build_plan_fallback(user_text)


def _phase_needs_response_tool_filter(phase: str) -> bool:
    """Only planning/verify/reflect phases strip disallowed tool_calls at wrap_model_call time."""
    p = str(phase or "").strip().lower()
    return (
        p in PLANNING_GUARD_PHASES
        or p in VERIFYING_GUARD_PHASES
        or p in REFLECTING_GUARD_PHASES
    )


def _replace_ai_in_model_call_result(result: ModelCallResult, ai: AIMessage) -> ModelCallResult:
    if isinstance(result, AIMessage):
        return ai
    inner = getattr(result, "result", None)
    if isinstance(inner, AIMessage):
        from langchain.agents.middleware.types import ModelResponse

        return ModelResponse(result=[ai])
    if isinstance(inner, list):
        from langchain.agents.middleware.types import ModelResponse

        replaced = list(inner)
        for i in range(len(replaced) - 1, -1, -1):
            if isinstance(replaced[i], AIMessage):
                replaced[i] = ai
                return ModelResponse(result=replaced)
        replaced.append(ai)
        return ModelResponse(result=replaced)
    return result


def _pg_thread_id(runtime: Runtime) -> str:
    return _effective_runtime_thread_id(runtime)


def _pg_ai_snapshot(ai: AIMessage | None) -> dict[str, Any]:
    if ai is None:
        return {"has_ai": False}
    tool_calls = list(getattr(ai, "tool_calls", None) or [])
    text = _message_text(getattr(ai, "content", ""))
    return {
        "has_ai": True,
        "content_len": len(text),
        "has_text": bool(text),
        "tool_calls": [_tool_call_name(tc) for tc in tool_calls],
        "tool_calls_count": len(tool_calls),
    }


def _pg_reason_cn(reason: str) -> str:
    mapping = {
        "wrap_model_call_empty_turn": "模型调用后空回复",
        "empty_model_turn_no_tool_calls": "空回复且无工具调用",
        "blocked_all_tool_calls_and_empty_content": "工具全被拦截且正文为空",
        "filtered_tool_calls": "已过滤非法工具调用",
        "plan_scenario_and_has_plan_but_collab_disk_idle": "plan场景已激活、磁盘idle且已有计划",
        "committed_plan_disk_without_active_plan_scenario": "磁盘已有计划但plan场景未激活",
    }
    return mapping.get(str(reason or "").strip(), str(reason or "").strip() or "未知")


def _pg_snap_cn(snap: dict[str, Any]) -> str:
    if not snap.get("has_ai"):
        return "无AI消息"
    tools = snap.get("tool_calls") or []
    tool_part = ",".join(str(t) for t in tools) if tools else "无"
    return (
        f"正文长度={snap.get('content_len', 0)} "
        f"有正文={'是' if snap.get('has_text') else '否'} "
        f"工具数={snap.get('tool_calls_count', 0)} "
        f"工具=[{tool_part}]"
    )



def _log_empty_model_turn(
    runtime: Runtime,
    *,
    phase: str,
    messages: list[Any],
    snap: dict[str, Any],
    reason: str,
) -> None:
    user_text = _latest_user_text(messages)
    logger.warning(
        "[plan_guard] 模型空回复 线程=%s 阶段=%s 原因=%s 用户输入=%r %s",
        _pg_thread_id(runtime),
        phase,
        reason,
        user_text[:120],
        _pg_snap_cn(snap),
    )
    try:
        write_cycle_trace(
            "plan_guard_empty_model_turn",
            {
                "thread_id": _pg_thread_id(runtime),
                "collab_phase": phase,
                "reason": reason,
                "user_text_preview": user_text[:200],
            },
        )
    except Exception:
        pass
    try:
        from evoflow.observability.compaction_file_log import log_model_response_diagnosis

        diagnosis = "系统记录空回复（plan_guard，将注入恢复反馈）"
        if "tool" in reason or "blocked" in reason or "strip" in reason or "filter" in reason:
            diagnosis = "系统剥空/拦截（plan_guard 过滤工具或清空 tool_calls）"
        log_model_response_diagnosis(
            "plan_guard空回复",
            diagnosis=diagnosis,
            thread_id=_pg_thread_id(runtime),
            plan_guard_reason=reason,
            content_len=int(snap.get("content_len") or 0),
            tool_calls_before=int(snap.get("tool_calls_count") or 0),
        )
    except Exception:
        pass


def _filter_assistant_tool_calls_for_guard(
    ai: AIMessage,
    *,
    messages: list[Any],
    phase: str,
    runtime: Runtime,
) -> tuple[AIMessage, bool]:
    """Strip disallowed tool_calls only; never synthesize assistant content."""
    allowed_names = _allowed_tool_names_for_guard(phase, messages, runtime=runtime)
    if is_strict_plan_collaboration(runtime, messages):
        allowed_names = frozenset({n for n in allowed_names if n in STRICT_PLAN_LEAD_TOOL_NAMES})

    tool_calls = list(getattr(ai, "tool_calls", None) or [])
    allowed_calls = [tc for tc in tool_calls if _tool_call_name(tc) in allowed_names]
    if len(allowed_calls) == len(tool_calls):
        return ai, False
    return ai.model_copy(update={"tool_calls": allowed_calls}), True


def _model_request_messages(request: ModelRequest) -> list[Any]:
    req_msgs = list(getattr(request, "messages", None) or [])
    if req_msgs:
        return req_msgs
    if isinstance(request.state, dict):
        return list(request.state.get("messages") or [])
    return []


class PlanGuardMiddleware(AgentMiddleware[AgentState]):
    """Block side-effectful tool calls outside executing phase."""

    state_schema = AgentState

    @staticmethod
    def _looks_like_execute_confirmation(text: str) -> bool:
        from evoflow.collab.execution_lifecycle import user_execution_start_intent

        return user_execution_start_intent(text)

    @staticmethod
    def _has_structured_execution_confirmation(
        messages: list[Any],
        *,
        thread_id: str = "",
        disk_bound: str = "",
    ) -> bool:
        """Structured「开始执行」答案只有在对话里已出现过 Plan 之后才作数，避免澄清轮里点了「开始执行…」选项就误判为执行授权。"""
        msgs = list(messages or [])
        tid = str(thread_id or "").strip()
        for i in range(len(msgs) - 1, -1, -1):
            m = msgs[i]
            if getattr(m, "type", None) != "human":
                continue
            txt = _message_text(getattr(m, "content", ""))
            if not txt:
                continue
            from evoflow.collab.execution_lifecycle import user_execution_start_intent

            if not user_execution_start_intent(txt):
                continue
            prior_plan = _conversation_has_plan(msgs[:i], tail_ai_content="")
            if not prior_plan and tid and _persistence_indicates_committed_plan(tid, disk_bound):
                prior_plan = True
            if not prior_plan:
                continue
            return True
        return False

    def _promote_to_executing_if_confirmed(self, request: ModelRequest) -> ModelRequest:
        if not isinstance(request.state, dict):
            return request
        runtime = request.runtime
        messages = list((request.state or {}).get("messages") or []) if isinstance(request.state, dict) else []
        phase = self._effective_collab_phase_for_guard(runtime, messages)

        if not messages:
            return request
        last = messages[-1]
        # Only react to the current user turn; do not re-trigger on tool/model loop turns.
        if getattr(last, "type", None) != "human":
            return request
        user_text = _message_text(getattr(last, "content", ""))
        if not self._looks_like_execute_confirmation(user_text):
            return request

        ctx = _pg_runtime_ctx(runtime)
        tid = str(ctx.get("thread_id") or "").strip()
        if not tid:
            return request
        try:
            paths = get_paths()
            cur = load_thread_collab_state(paths, tid)
            disk_bound = str(getattr(cur, "bound_task_id", "") or "").strip()
            if not (_conversation_has_plan(messages, tail_ai_content="") or _persistence_indicates_committed_plan(tid, disk_bound)):
                return request
            # 用户确认「开始执行」：任意阶段都写入确认时间戳并懒授权（executing 阶段不再被跳过）。
            from evoflow.collab.authorize_execution import ensure_task_execution_authorized_for_user
            from evoflow.collab.storage import get_project_storage
            from evoflow.collab.user_execution_confirm import mark_user_execution_confirmed

            mark_user_execution_confirmed(paths, tid)
            next_phase = CollabPhase.AWAITING_EXEC.value
            dispatch_task_id = disk_bound
            if not dispatch_task_id:
                dispatch_task_id, _row = _resolve_collab_main_task_id_and_row(
                    thread_id=tid,
                    disk_bound=disk_bound,
                )
            if dispatch_task_id:
                storage = get_project_storage()
                auth_ok, auth_msg = ensure_task_execution_authorized_for_user(
                    storage,
                    dispatch_task_id,
                    thread_id=tid,
                    messages=messages,
                )
                if not auth_ok:
                    logger.warning(
                        "[plan_guard] 执行授权失败 线程=%s 任务=%s 详情=%s",
                        tid,
                        dispatch_task_id,
                        auth_msg,
                    )
            if phase not in PLANNING_GUARD_PHASES:
                return request
            merged = merge_thread_collab_state(
                cur,
                {
                    "collab_phase": next_phase,
                    "user_execution_confirmed_at": utc_now_iso_z(),
                },
            )
            save_thread_collab_state(paths, tid, merged)
            write_cycle_trace(
                "plan_guard_auto_advance_to_awaiting_exec",
                {
                    "thread_id": tid,
                    "from_phase": phase,
                    "to_phase": next_phase,
                    "reason": "user_confirm_execution_intent",
                },
            )
            log_collab_lifecycle_cn(
                "用户确认执行并自动切换阶段",
                {
                    "线程ID": tid,
                    "原阶段": phase,
                    "新阶段": next_phase,
                    "用户输入": user_text[:300],
                },
            )
            _pg_set_runtime_ctx(runtime, collab_phase=next_phase)
            # Ensure current model request sees the promoted phase.
            return request.override(context={**ctx, "collab_phase": next_phase})
        except Exception:
            return request

    def _idle_hide_supervisor_tools_if_no_plan(self, request: ModelRequest, phase: str) -> ModelRequest:
        """idle 且未激活 plan：从本轮 ModelRequest.tools 移除 supervisor，迫使先 scenario(plan)。"""
        if not _phase_is_idle_like(phase):
            return request
        req_tools = list(request.tools or [])
        if not req_tools:
            return request
        msgs = list((request.state or {}).get("messages") or []) if isinstance(request.state, dict) else []
        active = set(effective_activated_scenario_keys(request.runtime, msgs))
        if "plan" in active:
            return request
        gated = frozenset({"supervisor"})
        filtered = [t for t in req_tools if str(getattr(t, "name", "") or "").strip() not in gated]
        if len(filtered) == len(req_tools):
            return request
        try:
            ctx = request.runtime.context or {}
            write_cycle_trace(
                "supervisor_gated_until_plan",
                {
                    "thread_id": str(ctx.get("thread_id") or ""),
                    "collab_phase": str(phase or CollabPhase.IDLE.value),
                    "active_scenarios": sorted(active),
                    "removed_tools": sorted({str(getattr(t, "name", "") or "").strip() for t in req_tools if str(getattr(t, "name", "") or "").strip() in gated}),
                },
            )
        except Exception:
            pass
        return request.override(tools=filtered)

    def _idle_strip_supervisor_without_plan(self, state: AgentState, runtime: Runtime) -> dict[str, Any] | None:
        """after_model 兜底：idle 且无 plan 场景时剥离 supervisor 调用（防绕过 schema）。"""
        messages = state.get("messages") or []
        if not messages:
            return None
        last = messages[-1]
        if not isinstance(last, AIMessage):
            return None
        active = set(effective_activated_scenario_keys(runtime, messages))
        if "plan" in active:
            return None
        tool_calls = list(getattr(last, "tool_calls", None) or [])
        gated = frozenset({"supervisor"})
        filtered = [tc for tc in tool_calls if _tool_call_name(tc) not in gated]
        if len(filtered) == len(tool_calls):
            return None
        blocked = [tc for tc in tool_calls if _tool_call_name(tc) in gated]
        blocked_msgs = [
            _build_supervisor_stripped_feedback_message(
                _tool_call_name(tc),
                tool_call_id=_tool_call_id(tc),
                collab_phase=str(self._effective_collab_phase_for_guard(runtime, messages) or CollabPhase.IDLE.value),
            )
            for tc in blocked
        ]
        try:
            ctx = runtime.context or {}
            write_cycle_trace(
                "plan_guard_idle_strip_supervisor_tool_calls",
                {
                    "thread_id": str(ctx.get("thread_id") or ""),
                    "removed_names": sorted({_tool_call_name(tc) for tc in tool_calls if _tool_call_name(tc) in gated}),
                },
            )
        except Exception:
            pass
        if not filtered and not _message_text(getattr(last, "content", "")):
            _log_empty_model_turn(
                runtime,
                phase=str(self._effective_collab_phase_for_guard(runtime, messages) or CollabPhase.IDLE.value),
                messages=messages,
                snap=_pg_ai_snapshot(last),
                reason="after_model_idle_supervisor_stripped_empty_content",
            )
        # Keep original tool_calls so LangGraph treats injected ToolMessages as artificial
        # feedback and routes back to model instead of ending the turn silently.
        return {"messages": [last, *blocked_msgs]}

    def _done_hide_supervisor_and_todo(self, request: ModelRequest, phase: str) -> ModelRequest:
        """协作已结束：不向模型暴露 supervisor，避免终态后仍打监控轮。"""
        if str(phase or "").strip().lower() != CollabPhase.DONE.value:
            return request
        req_tools = list(request.tools or [])
        if not req_tools:
            return request
        gated = frozenset({"supervisor"})
        filtered = [t for t in req_tools if str(getattr(t, "name", "") or "").strip() not in gated]
        if len(filtered) == len(req_tools):
            return request
        try:
            ctx = request.runtime.context or {}
            write_cycle_trace(
                "plan_guard_done_hide_supervisor_todo",
                {
                    "thread_id": str(ctx.get("thread_id") or ""),
                    "collab_phase": str(phase or CollabPhase.DONE.value),
                    "removed_tools": sorted({str(getattr(t, "name", "") or "").strip() for t in req_tools if str(getattr(t, "name", "") or "").strip() in gated}),
                },
            )
        except Exception:
            pass
        return request.override(tools=filtered)

    def _done_strip_supervisor_and_todo(self, state: AgentState, runtime: Runtime) -> dict[str, Any] | None:
        """终态 done：剥离 supervisor tool_calls（与 request.tools 隐藏一致）。"""
        messages = list(state.get("messages") or [])
        if not messages:
            return None
        phase = self._effective_collab_phase_for_guard(runtime, messages)
        if str(phase or "").strip().lower() != CollabPhase.DONE.value:
            return None
        last = messages[-1]
        if not isinstance(last, AIMessage):
            return None
        tool_calls = list(getattr(last, "tool_calls", None) or [])
        gated = frozenset({"supervisor"})
        filtered = [tc for tc in tool_calls if _tool_call_name(tc) not in gated]
        if len(filtered) == len(tool_calls):
            return None
        blocked = [tc for tc in tool_calls if _tool_call_name(tc) in gated]
        blocked_msgs = [
            _build_supervisor_stripped_feedback_message(
                _tool_call_name(tc),
                tool_call_id=_tool_call_id(tc),
                collab_phase=CollabPhase.DONE.value,
            )
            for tc in blocked
        ]
        try:
            ctx = runtime.context or {}
            write_cycle_trace(
                "plan_guard_done_strip_supervisor_todo_tool_calls",
                {
                    "thread_id": str(ctx.get("thread_id") or ""),
                    "removed_names": sorted({_tool_call_name(tc) for tc in tool_calls if _tool_call_name(tc) in gated}),
                },
            )
        except Exception:
            pass
        if not filtered and not _message_text(getattr(last, "content", "")):
            _log_empty_model_turn(
                runtime,
                phase=CollabPhase.DONE.value,
                messages=messages,
                snap=_pg_ai_snapshot(last),
                reason="after_model_done_supervisor_stripped_empty_content",
            )
        return {"messages": [last, *blocked_msgs]}

    def _filter_request_tools_for_phase(self, request: ModelRequest) -> ModelRequest:
        request = self._promote_to_executing_if_confirmed(request)
        messages = list((request.state or {}).get("messages") or []) if isinstance(request.state, dict) else []
        raw_phase = self._resolve_effective_phase(request.runtime)
        phase = self._effective_collab_phase_for_guard(request.runtime, messages)
        request = self._idle_hide_supervisor_tools_if_no_plan(request, raw_phase)
        if phase in VERIFYING_GUARD_PHASES:
            req_tools = list(request.tools or [])
            if not req_tools:
                return request
            allowed = VERIFYING_ALLOWED_TOOL_NAMES
            allowed_tools = [t for t in req_tools if str(getattr(t, "name", "") or "").strip() in allowed]
            if len(allowed_tools) == len(req_tools):
                return request
            return request.override(tools=allowed_tools)

        if phase in REFLECTING_GUARD_PHASES:
            req_tools = list(request.tools or [])
            if not req_tools:
                return request
            allowed = REFLECTING_ALLOWED_TOOL_NAMES
            allowed_tools = [t for t in req_tools if str(getattr(t, "name", "") or "").strip() in allowed]
            if len(allowed_tools) == len(req_tools):
                return request
            return request.override(tools=allowed_tools)

        if phase not in PLANNING_GUARD_PHASES:
            return self._done_hide_supervisor_and_todo(request, phase)

        req_tools = list(request.tools or [])
        if not req_tools:
            return request
        allowed_names = _allowed_tool_names_for_guard(phase, messages, runtime=request.runtime)
        if is_strict_plan_collaboration(request.runtime, messages):
            allowed_names = frozenset({n for n in allowed_names if n in STRICT_PLAN_LEAD_TOOL_NAMES})
        allowed_tools = [t for t in req_tools if str(getattr(t, "name", "") or "").strip() in allowed_names]
        if len(allowed_tools) == len(req_tools):
            return request

        try:
            ctx = request.runtime.context or {}
            write_cycle_trace(
                "plan_guard_filtered_request_tools",
                {
                    "thread_id": str(ctx.get("thread_id") or ""),
                    "collab_phase": phase,
                    "blocked_request_tools": sorted({str(getattr(t, "name", "") or "").strip() for t in req_tools if str(getattr(t, "name", "") or "").strip() not in allowed_names}),
                    "allowed_request_tools": sorted({str(getattr(t, "name", "") or "").strip() for t in allowed_tools if str(getattr(t, "name", "") or "").strip()}),
                },
            )
            log_collab_lifecycle_cn(
                "规划阶段请求工具过滤",
                {
                    "线程ID": str(ctx.get("thread_id") or ""),
                    "协作阶段": phase,
                    "允许工具": sorted({str(getattr(t, "name", "") or "").strip() for t in allowed_tools if str(getattr(t, "name", "") or "").strip()}),
                    "拦截工具": sorted({str(getattr(t, "name", "") or "").strip() for t in req_tools if str(getattr(t, "name", "") or "").strip() not in allowed_names}),
                },
            )
        except Exception:
            pass
        return request.override(tools=allowed_tools)

    def _resolve_effective_phase(self, runtime: Runtime) -> str:
        ctx = _pg_runtime_ctx(runtime)
        tid = str(ctx.get("thread_id") or "").strip()
        return load_merged_collab_phase(get_paths(), tid, ctx.get("collab_phase"))

    def _effective_collab_phase_for_guard(self, runtime: Runtime, messages: list[Any] | None) -> str:
        """磁盘/上下文仍是 idle，但已激活 plan 且对话里已有正式 Plan 时，仍走 planning-like 门禁。

        否则整段 plan_guard（含「执行确认 ask_clarification」注入）被跳过，模型容易只在正文写「回 A」，
        面板无结构化选项（见 agent-trace：plan 成功后 collab_phase=idle、final_ai_tool_calls=[]）。
        """
        base = str(self._resolve_effective_phase(runtime) or "").strip().lower()
        tid = _pg_thread_id(runtime)
        if base == CollabPhase.DONE.value:
            return base
        if not _phase_is_idle_like(base):
            return base
        ctx = _pg_runtime_ctx(runtime)
        if is_subagent_focus_mode(configurable=ctx, collab_phase=ctx.get("collab_phase")):
            return base
        msgs = list(messages or [])
        tid_b, disk_bound_b = _thread_id_and_disk_bound(runtime)
        if _fresh_planning_after_workspace_chat(msgs, runtime):
            logger.info(
                "[plan_guard] 有效阶段 线程=%s 原阶段=%s 保持=idle（工作区问答后重新规划，不沿用旧 plan_ready）",
                tid,
                base,
            )
            return base
        has_plan_msgs = _conversation_has_plan(msgs, tail_ai_content="")
        has_plan_disk = _has_open_committed_plan_on_disk(tid_b, disk_bound_b) if tid_b else False
        if not (has_plan_msgs or has_plan_disk):
            logger.debug(
                "[plan_guard] 有效阶段 线程=%s 原阶段=%s 保持=idle（尚无已落库计划）",
                tid,
                base,
            )
            return base
        confirmed_msgs = PlanGuardMiddleware._has_structured_execution_confirmation(msgs, thread_id=tid_b, disk_bound=disk_bound_b)
        confirmed_disk = bool(tid_b) and _persistence_indicates_execution_authorized(tid_b, disk_bound_b) and (has_plan_msgs or has_plan_disk)
        if confirmed_msgs or confirmed_disk:
            logger.info(
                "[plan_guard] 有效阶段 线程=%s 原阶段=%s 保持=idle（执行已确认 对话=%s 磁盘=%s）",
                tid,
                base,
                confirmed_msgs,
                confirmed_disk,
            )
            return base
        active = set(effective_activated_scenario_keys(runtime, msgs))
        promo_reason = (
            "plan_scenario_and_has_plan_but_collab_disk_idle"
            if "plan" in active
            else "committed_plan_disk_without_active_plan_scenario"
        )
        try:
            ctx = _pg_runtime_ctx(runtime)
            write_cycle_trace(
                "plan_guard_virtual_phase_idle_to_plan_ready",
                {
                    "thread_id": str(ctx.get("thread_id") or ""),
                    "reason": promo_reason,
                },
            )
        except Exception:
            pass
        logger.info(
            "[plan_guard] 虚拟阶段提升 线程=%s 原阶段=%s -> plan_ready 原因=%s 磁盘有计划=%s 对话有计划=%s plan场景激活=%s",
            tid,
            base,
            _pg_reason_cn(promo_reason),
            has_plan_disk,
            has_plan_msgs,
            "plan" in active,
        )
        return CollabPhase.PLAN_READY.value

    def _filter_tool_calls_for_phase(self, state: AgentState, runtime: Runtime) -> dict[str, Any] | None:
        messages = list(state.get("messages") or [])
        phase = self._effective_collab_phase_for_guard(runtime, messages)
        tid = _pg_thread_id(runtime)
        last = messages[-1] if messages else None
        if isinstance(last, AIMessage):
            snap = _pg_ai_snapshot(last)
            if phase in PLANNING_GUARD_PHASES and not snap.get("has_text") and snap.get("tool_calls_count", 0) == 0:
                logger.info(
                    "[plan_guard] after_model 检测到空AI消息 线程=%s 阶段=%s %s",
                    tid,
                    phase,
                    _pg_snap_cn(snap),
                )
        if phase in VERIFYING_GUARD_PHASES:
            if not messages:
                return None
            last = messages[-1]
            if not isinstance(last, AIMessage):
                return None
            tool_calls = list(getattr(last, "tool_calls", None) or [])
            if not tool_calls:
                return None
            allowed = VERIFYING_ALLOWED_TOOL_NAMES
            filtered = [tc for tc in tool_calls if _tool_call_name(tc) in allowed]
            if len(filtered) == len(tool_calls):
                return None
            blocked = [tc for tc in tool_calls if _tool_call_name(tc) not in allowed]
            blocked_msgs = [
                _build_phase_blocked_tool_message(
                    _tool_call_name(tc),
                    tool_call_id=_tool_call_id(tc),
                    phase=phase,
                )
                for tc in blocked
            ]
            return {"messages": [last, *blocked_msgs]}

        if phase in REFLECTING_GUARD_PHASES:
            if not messages:
                return None
            last = messages[-1]
            if not isinstance(last, AIMessage):
                return None
            tool_calls = list(getattr(last, "tool_calls", None) or [])
            if not tool_calls:
                return None
            allowed = REFLECTING_ALLOWED_TOOL_NAMES
            filtered = [tc for tc in tool_calls if _tool_call_name(tc) in allowed]
            if len(filtered) == len(tool_calls):
                return None
            blocked = [tc for tc in tool_calls if _tool_call_name(tc) not in allowed]
            blocked_msgs = [
                _build_phase_blocked_tool_message(
                    _tool_call_name(tc),
                    tool_call_id=_tool_call_id(tc),
                    phase=phase,
                )
                for tc in blocked
            ]
            return {"messages": [last, *blocked_msgs]}

        if phase not in PLANNING_GUARD_PHASES:
            if _phase_is_idle_like(phase):
                stripped = self._idle_strip_supervisor_without_plan(state, runtime)
                if stripped is not None:
                    return stripped
                return self._maybe_recover_empty_assistant_turn(
                    state,
                    runtime,
                    phase=phase,
                    reason="after_model_idle_empty_no_tool_calls",
                )
            stripped_done = self._done_strip_supervisor_and_todo(state, runtime)
            if stripped_done is not None:
                return stripped_done
            return self._maybe_recover_empty_assistant_turn(
                state,
                runtime,
                phase=phase,
                reason="after_model_done_empty_no_tool_calls",
            )

        if not messages:
            return None
        last = messages[-1]
        if not isinstance(last, AIMessage):
            return None

        tool_calls = list(getattr(last, "tool_calls", None) or [])
        allowed_names = _allowed_tool_names_for_guard(phase, messages, runtime=runtime)
        if is_strict_plan_collaboration(runtime, messages):
            allowed_names = frozenset({n for n in allowed_names if n in STRICT_PLAN_LEAD_TOOL_NAMES})

        if not tool_calls:
            if not _message_text(getattr(last, "content", "")):
                return _build_empty_model_turn_recovery(
                    last,
                    phase=phase,
                    messages=messages,
                    runtime=runtime,
                    reason="after_model_empty_no_tool_calls",
                )
            return None

        allowed_calls = [tc for tc in tool_calls if _tool_call_name(tc) in allowed_names]
        if len(allowed_calls) == len(tool_calls):
            return None

        blocked_calls = [tc for tc in tool_calls if _tool_call_name(tc) not in allowed_names]
        blocked_tool_names = [_tool_call_name(tc) for tc in blocked_calls]
        try:
            ctx = runtime.context or {}
            write_cycle_trace(
                "plan_guard_filtered_tools",
                {
                    "thread_id": str(ctx.get("thread_id") or ""),
                    "collab_phase": phase,
                    "blocked_tool_calls": blocked_tool_names,
                    "allowed_tool_calls": [_tool_call_name(tc) for tc in allowed_calls],
                },
            )
            log_collab_lifecycle_cn(
                "规划阶段模型工具调用被拦截",
                {
                    "线程ID": str(ctx.get("thread_id") or ""),
                    "协作阶段": phase,
                    "允许调用": [_tool_call_name(tc) for tc in allowed_calls],
                    "拦截调用": blocked_tool_names,
                },
            )
        except Exception:
            pass

        # Inject ToolMessage feedback for each blocked tool so the model can
        # self-correct (use subagent / switch scenario) instead of hitting an
        # empty-turn dead end.
        is_strict = is_strict_plan_collaboration(runtime, messages)
        if not allowed_calls and not _message_text(getattr(last, "content", "")):
            _log_empty_model_turn(
                runtime,
                phase=phase,
                messages=messages,
                snap=_pg_ai_snapshot(last),
                reason="after_model_all_tools_blocked_empty_content",
            )
        return _inject_blocked_tool_feedback(
            last,
            blocked_calls=blocked_calls,
            phase=phase,
            is_strict=is_strict,
        )

    def _maybe_recover_empty_assistant_turn(
        self,
        state: AgentState,
        runtime: Runtime,
        *,
        phase: str,
        reason: str,
    ) -> dict[str, Any] | None:
        messages = list(state.get("messages") or [])
        if not messages:
            return None
        last = messages[-1]
        if not isinstance(last, AIMessage):
            return None
        if _message_text(getattr(last, "content", "")):
            return None
        if list(getattr(last, "tool_calls", None) or []):
            return None
        return _build_empty_model_turn_recovery(
            last,
            phase=phase,
            messages=messages,
            runtime=runtime,
            reason=reason,
        )

    def _sync_virtual_collab_phase_to_runtime(self, state: AgentState, runtime: Runtime) -> None:
        """Align runtime prompt/scenario with virtual plan_ready before system prompt rebuild."""
        messages = list(state.get("messages") or [])
        eff = self._effective_collab_phase_for_guard(runtime, messages)
        base = str(self._resolve_effective_phase(runtime) or "").strip().lower()
        ctx = _pg_runtime_ctx(runtime)
        if eff != base:
            _pg_set_runtime_ctx(runtime, collab_phase=eff)
            logger.info(
                "[plan_guard] 同步虚拟协作阶段到 runtime 线程=%s %s -> %s",
                _pg_thread_id(runtime),
                base or "(空)",
                eff,
            )
        ctx = _pg_runtime_ctx(runtime)
        tid_sync = str(ctx.get("thread_id") or "").strip()
        eff_phase = str(eff or base or "").strip().lower()
        try:
            from evoflow.tools.builtins.scenario_activation import sync_agent_scenario_after_plan_done

            agent_synced = sync_agent_scenario_after_plan_done(
                collab_phase=eff_phase,
                thread_id=tid_sync,
            )
            if agent_synced:
                logger.info(
                    "[plan_guard] Plan 全流程结束，已同步 agent 场景 线程=%s 阶段=%s 变更=%s",
                    tid_sync,
                    eff_phase,
                    ",".join(agent_synced),
                )
        except Exception:
            logger.exception("[plan_guard] 同步 agent 场景失败 线程=%s", _pg_thread_id(runtime))

        if eff not in PLANNING_GUARD_PHASES:
            return
        msgs = list(state.get("messages") or [])
        if _fresh_planning_after_workspace_chat(msgs, runtime):
            return
        if self._user_deactivated_plan_this_turn(state, runtime):
            return
        try:
            from evoflow.tools.builtins.scenario_activation import sync_plan_scenario_with_session_policy

            synced = sync_plan_scenario_with_session_policy(
                session_mode=ctx.get("session_mode"),
                collab_phase=eff,
            )
            if synced:
                logger.info(
                    "[plan_guard] 已同步 plan 场景 线程=%s 场景=%s",
                    _pg_thread_id(runtime),
                    ",".join(str(x) for x in synced),
                )
        except Exception:
            logger.exception("[plan_guard] 同步 plan 场景失败 线程=%s", _pg_thread_id(runtime))

    def _user_deactivated_plan_this_turn(self, state: AgentState, runtime: Runtime) -> bool:
        """Check if the most recent tool call was mode_set(deactivate, plan) and it succeeded."""
        from evoflow.tools.tool_catalog import is_mode_set_tool

        try:
            messages = list(state.get("messages") or [])
            if not messages:
                return False
            for m in reversed(messages[-6:]):
                tc_list = getattr(m, "tool_calls", None) or []
                if not tc_list:
                    continue
                for tc in tc_list:
                    name = str(getattr(tc, "name", "") or "").strip().lower()
                    if not is_mode_set_tool(name):
                        continue
                    args = getattr(tc, "args", None) or {}
                    if isinstance(args, dict):
                        action = str(args.get("action", "") or "").strip().lower()
                        key = str(
                            args.get("mode", "") or args.get("scenario_key", "") or "",
                        ).strip().lower()
                        if action == "deactivate" and key == "plan":
                            return True
            return False
        except Exception:
            return False

    def before_model(self, state: AgentState, runtime: Runtime) -> dict[str, Any] | None:
        self._sync_virtual_collab_phase_to_runtime(state, runtime)
        return None

    async def abefore_model(self, state: AgentState, runtime: Runtime) -> dict[str, Any] | None:
        self._sync_virtual_collab_phase_to_runtime(state, runtime)
        return None

    def after_model(self, state: AgentState, runtime: Runtime) -> dict[str, Any] | None:
        return self._filter_tool_calls_for_phase(state, runtime)

    async def aafter_model(self, state: AgentState, runtime: Runtime) -> dict[str, Any] | None:
        return self._filter_tool_calls_for_phase(state, runtime)

    def _postprocess_model_call_result(self, request: ModelRequest, result: ModelCallResult) -> ModelCallResult:
        messages = _model_request_messages(request)
        phase = self._effective_collab_phase_for_guard(request.runtime, messages)
        ai = _ai_message_from_model_call_result(result)
        snap = _pg_ai_snapshot(ai)
        if ai is not None and not snap.get("has_text") and snap.get("tool_calls_count", 0) == 0:
            _log_empty_model_turn(
                request.runtime,
                phase=phase,
                messages=messages,
                snap=snap,
                reason="wrap_model_call_empty_turn",
            )
        elif ai is not None and _phase_needs_response_tool_filter(phase):
            # Log phase-restricted tools for observability; actual stripping +
            # ToolMessage feedback injection is handled by after_model
            # (_filter_tool_calls_for_phase) so the model gets actionable feedback
            # instead of a silent strip that causes empty turns.
            _check_ai, would_change = _filter_assistant_tool_calls_for_guard(
                ai,
                messages=messages,
                phase=phase,
                runtime=request.runtime,
            )
            if would_change:
                logger.info(
                    "[plan_guard] 模型响应包含阶段受限工具（将由 after_model 注入反馈）线程=%s 阶段=%s",
                    _pg_thread_id(request.runtime),
                    phase,
                )
        return result

    def wrap_model_call(self, request: ModelRequest, handler) -> ModelCallResult:
        filtered = self._filter_request_tools_for_phase(request)
        msgs = _model_request_messages(filtered)
        base_phase = str(self._resolve_effective_phase(filtered.runtime) or "").strip().lower()
        eff_phase = self._effective_collab_phase_for_guard(filtered.runtime, msgs)
        logger.info(
            "[plan_guard] 模型调用开始 线程=%s 原阶段=%s 有效阶段=%s 可用工具数=%d 用户输入=%r",
            _pg_thread_id(filtered.runtime),
            base_phase,
            eff_phase,
            len(filtered.tools or []),
            _latest_user_text(msgs)[:80],
        )
        result = handler(filtered)
        return self._postprocess_model_call_result(filtered, result)

    async def awrap_model_call(self, request: ModelRequest, handler) -> ModelCallResult:
        filtered = self._filter_request_tools_for_phase(request)
        msgs = _model_request_messages(filtered)
        base_phase = str(self._resolve_effective_phase(filtered.runtime) or "").strip().lower()
        eff_phase = self._effective_collab_phase_for_guard(filtered.runtime, msgs)
        logger.info(
            "[plan_guard] 异步模型调用开始 线程=%s 原阶段=%s 有效阶段=%s 可用工具数=%d 用户输入=%r",
            _pg_thread_id(filtered.runtime),
            base_phase,
            eff_phase,
            len(filtered.tools or []),
            _latest_user_text(msgs)[:80],
        )
        result = await handler(filtered)
        return self._postprocess_model_call_result(filtered, result)

    def wrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], ToolMessage | Command],
    ) -> ToolMessage | Command:
        blocked = _gate_tool_without_required_scenario(request)
        if blocked is not None:
            _trace_scenario_not_activated_tool_result(request, blocked)
            return blocked
        return handler(request)

    async def awrap_tool_call(
        self,
        request: ToolCallRequest,
        handler: Callable[[ToolCallRequest], Awaitable[ToolMessage | Command]],
    ) -> ToolMessage | Command:
        blocked = _gate_tool_without_required_scenario(request)
        if blocked is not None:
            _trace_scenario_not_activated_tool_result(request, blocked)
            return blocked
        return await handler(request)
