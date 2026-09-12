"""Scenario activation — allow the agent to actively switch scenarios at runtime.

Similar to deferred tool activation, this tool allows the agent to:
1. Actively activate one or more scenarios based on conversation context
2. Deactivate scenarios when they are no longer needed
3. Override the async LLM-based scenario detection
4. Auto-downgrade: when mission_state consistently returns "chat",
   stale activated scenarios are automatically cleared

Non-plan scenarios may be active together (e.g. multiple workspace tool groups). ``plan`` is exclusive:
at most one active scenario and it must be ``plan`` when plan is on.
"""

import contextvars
import json
import logging
from dataclasses import dataclass, field
from typing import Any, Literal

from langchain_core.tools import tool
from pydantic import AliasChoices, BaseModel, Field

from evoflow.agents.lead_agent.intent_tool_profile import (
    ACTIVATABLE_SCENARIO_KEYS,
    CORE_TOOL_NAMES,
    TASK_SCENARIO_PROFILES,
    build_scenario_tools_payload,
    format_scenario_key_enum_description,
    format_scenario_tool_description,
    normalize_scenario_key,
)
from evoflow.agents.middlewares.collab_lifecycle_cn_logging import log_collab_lifecycle_cn

logger = logging.getLogger(__name__)

# ── Scenario Registry ──


@dataclass(frozen=True)
class ScenarioEntry:
    """Metadata for an activatable scenario."""

    key: str
    zh_description: str
    tool_groups: tuple[str, ...]
    signals: str  # When to activate this scenario
    boundaries: str  # When NOT to activate this scenario


# Build SCENARIO_ENTRIES from TASK_SCENARIO_PROFILES (single source of truth).
SCENARIO_ENTRIES: dict[str, ScenarioEntry] = {
    key: ScenarioEntry(
        key=profile.key,
        zh_description=profile.zh_description,
        tool_groups=profile.tool_groups,
        signals=profile.signals,
        boundaries=profile.boundaries,
    )
    for key, profile in TASK_SCENARIO_PROFILES.items()
}

_profile_keys = {k for k in TASK_SCENARIO_PROFILES if k != "ask"}
if set(ACTIVATABLE_SCENARIO_KEYS) != _profile_keys:
    raise RuntimeError(f"ACTIVATABLE_SCENARIO_KEYS {set(ACTIVATABLE_SCENARIO_KEYS)!r} != TASK_SCENARIO_PROFILES non-ask keys {_profile_keys!r}")


ScenarioKeyLiteral = Literal["ask", "plan", "agent"]


def get_scenario_key_enum_description() -> str:
    """Per-enum descriptions for ``scenario_key`` JSON schema field."""
    return format_scenario_key_enum_description()


class _ModeSetInput(BaseModel):
    action: Literal["activate", "deactivate"] = Field(
        description="activate：激活模式（ask 清空；plan 独占）；deactivate：停用指定模式。",
    )
    mode: ScenarioKeyLiteral = Field(
        description=get_scenario_key_enum_description(),
        validation_alias=AliasChoices("mode", "scenario_key"),
    )
    reason: str = Field(default="", description="操作原因（可选，用于日志记录）")


# Backward-compatible schema alias
_ScenarioInput = _ModeSetInput


# ── Per-request activated scenarios (ContextVar) ──

# How many consecutive mission_state="chat" rounds before auto-clearing activated scenarios
_CHAT_OVERRIDE_THRESHOLD = 5


@dataclass
class _ActivationState:
    """Track activated scenarios and auto-downgrade counter."""

    scenarios: list[str] = field(default_factory=list)
    # Counts consecutive rounds where mission_state says "chat" while scenarios are active.
    # When it reaches _CHAT_OVERRIDE_THRESHOLD, scenarios are auto-cleared.
    chat_override_count: int = 0


_scenario_var: contextvars.ContextVar[_ActivationState | None] = contextvars.ContextVar("activated_scenario_state", default=None)


def _get_or_create_state() -> _ActivationState:
    """Get existing state or create a new one."""
    state = _scenario_var.get()
    if state is None:
        state = _ActivationState()
        _scenario_var.set(state)
    return state


def get_activated_scenarios() -> list[str]:
    """Get the currently activated scenarios for this request context.

    Returns:
        List of activated scenario keys (may be empty).
    """
    state = _scenario_var.get()
    if state is None:
        return []
    return list(state.scenarios)


def set_activated_scenario(scenario_key: str | None) -> None:
    """Set (replace) the activated scenario for this request context.

    This is a backward-compatible single-scenario setter.
    For multi-scenario, use scenario(action="activate") tool or _add_scenario.
    """
    if scenario_key and scenario_key not in SCENARIO_ENTRIES:
        raise ValueError(f"Invalid scenario key: {scenario_key}. Must be one of {list(SCENARIO_ENTRIES.keys())}")
    state = _get_or_create_state()
    if scenario_key:
        state.scenarios = [scenario_key]
        state.chat_override_count = 0
    else:
        state.scenarios = []
        state.chat_override_count = 0
    _persist_activated_scenarios(state.scenarios)


def _add_scenario(scenario_key: str) -> list[str]:
    """Add a scenario to the activated list.

    ``plan`` is exclusive: activating plan replaces all others; activating a non-plan
    key drops an active ``plan`` first.

    Returns:
        Scenario keys auto-cleared to enforce exclusivity (for tool response messaging).
    """
    scenario_key = normalize_scenario_key(scenario_key)
    if scenario_key not in ACTIVATABLE_SCENARIO_KEYS:
        raise ValueError(f"Invalid scenario key: {scenario_key}")
    state = _get_or_create_state()
    cleared: list[str] = []
    if scenario_key == "plan":
        for s in list(state.scenarios):
            if s != "plan":
                cleared.append(s)
        state.scenarios = ["plan"]
    else:
        if "plan" in state.scenarios:
            state.scenarios.remove("plan")
            cleared.append("plan")
        if scenario_key not in state.scenarios:
            state.scenarios.append(scenario_key)
    state.chat_override_count = 0
    norm = _normalized_unique_scenario_keys(state.scenarios)
    state.scenarios = norm
    _persist_activated_scenarios(norm)
    if cleared and "plan" in cleared:
        _idle_thread_collab_when_no_plan_scenario(state.scenarios)
    if scenario_key == "plan":
        _auto_enter_planning_for_plan_scenario()
    return cleared


def _remove_scenario(scenario_key: str) -> bool:
    """Remove a scenario from the activated list.

    Returns:
        True if the scenario was found and removed, False otherwise.
    """
    state = _scenario_var.get()
    if state is None:
        return False
    if scenario_key in state.scenarios:
        state.scenarios.remove(scenario_key)
        if not state.scenarios:
            state.chat_override_count = 0
        _persist_activated_scenarios(state.scenarios)
        return True
    return False


# Plan 协作进行中（含 awaiting_exec / executing / 验收）保留磁盘 collab 阶段；仅全流程 done 后切 agent 时可拉回 idle。
_PLAN_COLLAB_PHASES_PRESERVE_ON_LEAVE = frozenset(
    {"awaiting_exec", "executing", "verifying", "reflecting", "paused"}
)


def sync_plan_scenario_with_session_policy(
    *,
    session_mode: str | None = None,
    collab_phase: str | None = None,
) -> list[str]:
    """按会话策略同步 plan 场景：协作开启时自动激活（仅在未激活时）。模型可自由激活/停用 plan 场景，本函数不再自动移除。"""
    changes: list[str] = []
    try:
        from evoflow.agents.middlewares.plan_guard_middleware import (
            session_should_sync_plan_scenario_active,
        )
    except Exception:
        return changes

    should_sync = session_should_sync_plan_scenario_active(session_mode=session_mode, collab_phase=collab_phase)
    active = [str(s or "").strip().lower() for s in (get_activated_scenarios() or []) if str(s or "").strip()]
    has_plan = "plan" in active

    if should_sync and not has_plan:
        cleared = _add_scenario("plan")
        changes.append("activated:plan")
        for key in cleared:
            changes.append(f"cleared:{key}")
        return changes

    # 不再自动移除 plan：模型可自由切换到 plan 场景，不受 session_mode 限制
    return changes


def sync_agent_scenario_after_plan_done(
    *,
    collab_phase: str | None = None,
    thread_id: str | None = None,
) -> list[str]:
    """Plan 协作全流程结束（``done``）后切换 agent，恢复 worker/terminal 等；执行期仍保持 plan 场景。

    开始执行 / executing / verifying 仍属 Plan 流程，不在此切换。
    """
    from evoflow.collab.models import CollabPhase

    changes: list[str] = []
    phase = str(collab_phase or "").strip().lower()
    tid = str(thread_id or "").strip()

    should_switch = phase == CollabPhase.DONE.value
    if not should_switch and phase == CollabPhase.IDLE.value and tid:
        try:
            from evoflow.collab.thread_collab import load_thread_collab_state
            from evoflow.config.paths import get_paths

            disk = load_thread_collab_state(get_paths(), tid)
            disk_phase = (
                disk.collab_phase.value
                if isinstance(disk.collab_phase, CollabPhase)
                else str(disk.collab_phase or "")
            ).strip().lower()
            if disk_phase == CollabPhase.DONE.value:
                should_switch = True
        except Exception:
            pass

    if not should_switch:
        return changes

    active = [str(s or "").strip().lower() for s in (get_activated_scenarios() or []) if str(s or "").strip()]
    if "agent" in active and "plan" not in active:
        return changes

    try:
        cleared = _add_scenario("agent")
        changes.append("activated:agent")
        for key in cleared:
            changes.append(f"cleared:{key}")
        logger.info(
            "[ScenarioActivation] plan collab done -> activated agent (cleared=%s) thread=%s phase=%s",
            cleared,
            tid or "-",
            phase or "-",
        )
    except Exception:
        logger.warning("[ScenarioActivation] sync_agent_scenario_after_plan_done failed", exc_info=True)
    return changes


# Backward-compatible alias
sync_agent_scenario_for_execution_collab = sync_agent_scenario_after_plan_done


def ensure_plan_scenario_matches_session_policy(
    *,
    session_mode: str | None = None,
    collab_phase: str | None = None,
) -> list[str]:
    """Backward-compatible alias for ``sync_plan_scenario_with_session_policy``."""
    return sync_plan_scenario_with_session_policy(session_mode=session_mode, collab_phase=collab_phase)


def reset_activated_scenario() -> None:
    """Reset all activated scenarios for the current context."""
    state = _scenario_var.get()
    if state is not None:
        state.scenarios = []
        state.chat_override_count = 0
        _persist_activated_scenarios([])

def _scenario_tools_payload_for_run(scenarios: list[str]) -> dict[str, list[str]]:
    return build_scenario_tools_payload(scenarios, session_key=_resolve_chat_session_key())


def _normalized_unique_scenario_keys(scenarios: list[str]) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for s in scenarios or []:
        key = normalize_scenario_key(str(s or "").strip())
        if not key or key == "ask":
            continue
        if key not in ACTIVATABLE_SCENARIO_KEYS:
            continue
        if key not in seen:
            seen.add(key)
            out.append(key)
    if "plan" in out:
        return ["plan"]
    return out


def _resolve_chat_session_key() -> str | None:
    """Resolve EvoPanel ``session_key`` from run context (preferred) or ``thread_id`` binding."""
    thread_id = ""
    try:
        from langgraph.config import get_config

        cfg = get_config() or {}
        conf = cfg.get("configurable") if isinstance(cfg, dict) else {}
        if not isinstance(conf, dict):
            conf = {}
        sk = str(conf.get("session_key") or conf.get("sessionKey") or "").strip()
        if sk:
            return sk
        thread_id = str(conf.get("thread_id") or conf.get("threadId") or "").strip()
    except Exception:
        thread_id = ""
    if not thread_id:
        return None
    try:
        from evoflow.persistence.session_repositories import find_session_key_by_thread_id

        return find_session_key_by_thread_id(thread_id)
    except Exception:
        return None


def _persist_activated_scenarios(scenarios: list[str]) -> None:
    """Persist scenarios on ``evoflow_chat_sessions`` (per-session source of truth)."""
    norm = _normalized_unique_scenario_keys(scenarios)
    session_key = _resolve_chat_session_key()
    if not session_key:
        logger.warning("[ScenarioActivation] skip persist: no chat session_key for activated_scenarios=%s", norm)
        return
    try:
        from evoflow.persistence.session_repositories import (
            derive_session_mode,
            set_session_mode,
        )

        # session_mode is the single source of truth after the v75 migration
        # (the legacy scenario JSON column was dropped).
        set_session_mode(session_key, derive_session_mode(norm))
        logger.info(
            "[ScenarioActivation] persisted activated_scenarios=%s to chat session %s",
            norm,
            session_key,
        )
    except Exception as e:
        logger.warning("[ScenarioActivation] failed to persist activated_scenarios to chat session: %s", e)


def _auto_enter_planning_for_execute_scenario() -> None:
    """Backward-compatible name for tests and older callers.

    Execute-scenario auto-planning was unified with plan-scenario activation.
    """
    _auto_enter_planning_for_plan_scenario()


def _auto_enter_planning_for_plan_scenario() -> None:
    """When plan is activated, enter planning phase if thread is still idle.

    This is a runtime-safe bridge from scenario activation -> collab phase gating,
    so users don't need to explicitly toggle plan mode in UI.
    """
    try:
        from langgraph.config import get_config

        from evoflow.agents.middlewares.plan_guard_middleware import session_should_sync_plan_scenario_active

        cfg = get_config()
        conf = cfg.get("configurable") or {}
        if not session_should_sync_plan_scenario_active(configurable=conf if isinstance(conf, dict) else None):
            return
        thread_id = str(conf.get("thread_id") or "").strip()
    except Exception:
        thread_id = ""
    if not thread_id:
        return
    try:
        from evoflow.collab.models import CollabPhase
        from evoflow.collab.thread_collab import load_thread_collab_state, merge_thread_collab_state, save_thread_collab_state
        from evoflow.config.paths import get_paths

        paths = get_paths()
        cur = load_thread_collab_state(paths, thread_id)
        phase_val = (
            cur.collab_phase.value if isinstance(cur.collab_phase, CollabPhase) else str(cur.collab_phase or "")
        ).strip().lower()
        if phase_val == CollabPhase.DONE.value:
            from evoflow.collab.plan_session_task import begin_new_plan_cycle

            begin_new_plan_cycle(thread_id, paths=paths)
            cur = load_thread_collab_state(paths, thread_id)
            logger.info(
                "[ScenarioActivation] plan activated after done -> new plan cycle thread=%s task_id=%s",
                thread_id,
                cur.bound_task_id,
            )
        elif phase_val != CollabPhase.IDLE.value:
            return
        else:
            merged = merge_thread_collab_state(cur, {"collab_phase": CollabPhase.PLANNING.value})
            save_thread_collab_state(paths, thread_id, merged)
        try:
            from evoflow.collab.plan_session_task import ensure_plan_session_task

            task_meta = ensure_plan_session_task(thread_id, paths=paths)
            if task_meta.get("task_id"):
                logger.info(
                    "[ScenarioActivation] plan placeholder task_id=%s thread=%s created=%s",
                    task_meta.get("task_id"),
                    thread_id,
                    task_meta.get("created"),
                )
        except Exception:
            logger.warning("[ScenarioActivation] ensure_plan_session_task failed", exc_info=True)
        logger.info("[ScenarioActivation] plan activated -> set collab_phase=planning thread=%s", thread_id)
        log_collab_lifecycle_cn(
            "场景切换为规划并进入规划阶段",
            {
                "线程ID": thread_id,
                "场景": "plan",
                "协作阶段": "planning",
                "说明": "用户选择 plan 场景后，自动进入规划阶段",
            },
        )
        try:
            from evoflow.agents.middlewares.collab_cycle_trace_logging import write_cycle_trace

            write_cycle_trace(
                "auto_enter_planning_from_scenario_tool",
                {"thread_id": thread_id, "source": "scenario.activate(plan)", "set_collab_phase": "planning"},
            )
        except Exception:
            pass
    except Exception as e:
        logger.warning("[ScenarioActivation] failed to set planning phase after plan activation: %s", e)


def _idle_thread_collab_when_no_plan_scenario(remaining: list[str]) -> None:
    """若活跃场景中已无 ``plan``，将磁盘协作阶段拉回 idle。

    否则用户 ``deactivate plan`` / 无活跃场景后，``CollabPhaseMiddleware`` 仍按磁盘
    ``planning`` 注入 ``<collab_phase_context>``，与「聊天模式」预期不符。
    """
    rem = {normalize_scenario_key(str(x or "").strip()) for x in (remaining or [])}
    if "plan" in rem:
        return
    try:
        from langgraph.config import get_config

        tid = str(get_config().get("configurable", {}).get("thread_id") or "").strip()
    except Exception:
        tid = ""
    if not tid:
        return
    try:
        from evoflow.collab.models import CollabPhase
        from evoflow.collab.thread_collab import load_thread_collab_state, merge_thread_collab_state, save_thread_collab_state
        from evoflow.config.paths import get_paths

        paths = get_paths()
        cur = load_thread_collab_state(paths, tid)
        dv = cur.collab_phase.value if isinstance(cur.collab_phase, CollabPhase) else str(cur.collab_phase or "")
        phase_l = str(dv).strip().lower()
        if phase_l == CollabPhase.IDLE.value:
            return
        # plan→agent（全流程 done 后）允许 collab 回到 idle；执行/验收进行中则保留磁盘阶段。
        if phase_l in _PLAN_COLLAB_PHASES_PRESERVE_ON_LEAVE:
            return
        merged = merge_thread_collab_state(
            cur,
            {"collab_phase": CollabPhase.IDLE.value, "bound_task_id": None},
        )
        save_thread_collab_state(paths, tid, merged)
        logger.info("[ScenarioActivation] no plan in active scenarios; reset collab_phase=idle thread=%s", tid)
    except Exception as e:
        logger.warning("[ScenarioActivation] failed to idle collab after leaving plan: %s", e)


def restore_activated_scenarios(scenarios: list[str]) -> None:
    """Restore activated scenarios from persisted mission_state into ContextVar.

    Called once at the beginning of each `make_lead_agent` invocation
    to bridge the per-request ContextVar gap.
    """
    if not scenarios:
        return
    state = _get_or_create_state()
    for s in scenarios:
        key = normalize_scenario_key(s)
        if key != "ask" and key not in state.scenarios:
            state.scenarios.append(key)
    state.scenarios = _normalized_unique_scenario_keys(state.scenarios)
    logger.info("[ScenarioActivation] restored activated_scenarios=%s from persistence", state.scenarios)


def replace_activated_scenarios_from_mission_list(scenarios: list[str] | None) -> None:
    """Set ContextVar list from a persisted list (thread task_state and/or mission_state)."""
    state = _get_or_create_state()
    out: list[str] = []
    seen: set[str] = set()
    for s in scenarios or []:
        key = normalize_scenario_key(str(s or "").strip())
        if not key or key == "ask":
            continue
        if key not in ACTIVATABLE_SCENARIO_KEYS:
            continue
        if key not in seen:
            seen.add(key)
            out.append(key)
    state.scenarios = _normalized_unique_scenario_keys(out)
    state.chat_override_count = 0


def hydrate_activated_scenarios_context_var_from_disk(thread_id: str | None) -> None:
    """Load scenario keys from ``evoflow_chat_sessions``, with legacy thread/mission fallback."""
    tid = str(thread_id or "").strip()
    if not tid:
        return
    session_key: str | None = None
    try:
        from evoflow.persistence.session_repositories import (
            _scenarios_from_session_mode,
            find_session_key_by_thread_id,
            get_session_mode,
        )

        session_key = find_session_key_by_thread_id(tid)
        if session_key:
            # Chat session row is source of truth — session_mode is the single
            # source after the v75 migration (the legacy scenario JSON column was dropped).
            # Reverse-map mode -> scenario list for the ContextVar.
            stored = _scenarios_from_session_mode(get_session_mode(session_key))
            replace_activated_scenarios_from_mission_list(stored)
            return
    except Exception:
        session_key = None

    legacy: list[str] = []
    try:
        from evoflow.collab.thread_collab import load_thread_collab_state
        from evoflow.config.paths import get_paths

        cc = load_thread_collab_state(get_paths(), tid)
        if cc.activated_scenarios:
            legacy = list(cc.activated_scenarios)
    except Exception:
        legacy = []
    if not legacy:
        try:
            from evoflow.agents.mission_state.storage import load_mission_state

            ms = load_mission_state(tid)
            if ms is not None and getattr(ms, "activated_scenarios", None):
                legacy = list(ms.activated_scenarios)
        except Exception:
            legacy = []
    if legacy:
        replace_activated_scenarios_from_mission_list(legacy)
        if session_key:
            try:
                from evoflow.persistence.session_repositories import (
                    derive_session_mode,
                    set_session_mode,
                )

                # Persist legacy scenarios through the session_mode single source of truth.
                set_session_mode(session_key, derive_session_mode(legacy))
            except Exception:
                pass


def sync_activated_scenarios_from_mission_storage(runtime: Any) -> None:
    """Reload from disk (thread task_state, then mission) into ContextVar before each model call."""
    tid = ""
    ctx = getattr(runtime, "context", None)
    if isinstance(ctx, dict):
        tid = str(ctx.get("thread_id") or "").strip()
    if not tid:
        try:
            from langgraph.config import get_config

            tid = str(get_config().get("configurable", {}).get("thread_id") or "").strip()
        except Exception:
            tid = ""
    if not tid:
        return
    hydrate_activated_scenarios_context_var_from_disk(tid)


def _resolve_prompt_language_for_tool() -> str | None:
    try:
        from langgraph.config import get_config

        cfg = get_config()
        conf = cfg.get("configurable") if isinstance(cfg, dict) else None
        if isinstance(conf, dict):
            pl = conf.get("prompt_language")
            if pl:
                return str(pl)
            meta = conf.get("evf_dynamic_prompt_meta")
            if isinstance(meta, dict) and meta.get("prompt_language"):
                return str(meta.get("prompt_language"))
    except Exception:
        pass
    return None


def _scenario_tool_description() -> str:
    """Short ``scenario`` tool description; enum values documented in args schema fields."""
    return format_scenario_tool_description()


# ── Tools ──


@tool("mode_set", args_schema=_ModeSetInput)
def mode_set(action: str, mode: str, reason: str = "") -> str:
    """激活或停用 Ask / Agent / Plan 对话工具模式（与 panel_set 右侧面板无关）。"""
    action_normalized = action.strip().lower()
    scenario_key = normalize_scenario_key(mode)

    if action_normalized == "activate":
        if scenario_key == "ask":
            previous = get_activated_scenarios()
            reset_activated_scenario()
            return json.dumps(
                {
                    "status": "success",
                    "action": "activate",
                    "scenario_key": "ask",
                    "reason": reason,
                    "all_active_scenarios": [],
                    **build_scenario_tools_payload([], session_key=_resolve_chat_session_key()),
                    "previous_scenarios": previous or ["none"],
                    "message": (
                        "已切换日常对话：先前模式已解除，本回合仅绑定核心工具（"
                        + "、".join(CORE_TOOL_NAMES)
                        + "）。若用户下一步要改文件、联网等，请再 activate 对应模式（agent / plan），或对单个工具使用 tool_search。"
                    ),
                },
                ensure_ascii=False,
                indent=2,
            )
        if scenario_key not in SCENARIO_ENTRIES:
            return json.dumps(
                {
                    "status": "error",
                    "message": f"无效的场景键: {scenario_key}",
                    "available_scenarios": list(SCENARIO_ENTRIES.keys()),
                },
                ensure_ascii=False,
                indent=2,
            )

        try:
            from evoflow.agents.middlewares.plan_guard_middleware import (
                plan_scenario_activation_blocked,
                strict_plan_lock_blocks_scenario_activate,
            )

            blocked, lock_msg = plan_scenario_activation_blocked(scenario_key)
            if blocked:
                return json.dumps(
                    {
                        "status": "error",
                        "message": lock_msg,
                        "all_active_scenarios": get_activated_scenarios(),
                    },
                    ensure_ascii=False,
                    indent=2,
                )
            blocked, lock_msg = strict_plan_lock_blocks_scenario_activate(scenario_key)
            if blocked:
                return json.dumps(
                    {
                        "status": "error",
                        "message": lock_msg,
                        "all_active_scenarios": get_activated_scenarios(),
                    },
                    ensure_ascii=False,
                    indent=2,
                )
        except Exception:
            pass

        previous = get_activated_scenarios()
        auto_cleared = _add_scenario(scenario_key)
        current = get_activated_scenarios()

        entry = SCENARIO_ENTRIES[scenario_key]
        tools_payload = _scenario_tools_payload_for_run(current)
        result = {
            "status": "success",
            "action": "activate",
            "scenario_key": scenario_key,
            "description": entry.zh_description,
            "reason": reason,
            "all_active_scenarios": current,
            **tools_payload,
            "tools_ready_for_direct_call": True,
            "tool_activation_note": (
                "场景已激活。`activated_tools` 为本回合已绑定 schema、可直接调用的工具；"
                '`deferred_tools` 为已授权但尚未绑 schema 的工具，须先 `tool_search(query="select:工具名")` 再调用。'
                '示例：改代码 `query="select:replace"` 或 `query="select:write"`；'
                '长任务 `query="select:process"`；联网 `query="select:web_search,fetch_url"`；'
                '子任务调研 `query="select:subagent"`。'
            ),
            "previous_scenarios": previous or ["none"],
            "message": (f"场景已激活: {scenario_key} ({entry.zh_description})。当前活跃场景: {', '.join(current)}。先前场景的工具绑定已按规则更新（plan 独占时会清空其它场景）。"),
        }
        if auto_cleared:
            result["auto_cleared_scenarios"] = auto_cleared
            if scenario_key == "plan":
                result["message"] += f" 已自动停用（plan 独占）: {', '.join(auto_cleared)}。"
            else:
                result["message"] += f" 已退出 plan 以激活 {scenario_key}。"
        if scenario_key == "plan":
            try:
                from langgraph.config import get_config

                from evoflow.collab.plan_session_task import ensure_plan_session_task

                cfg = get_config()
                tid = str((cfg.get("configurable") or {}).get("thread_id") or "").strip()
                if tid:
                    tm = ensure_plan_session_task(tid)
                    tid_out = str(tm.get("task_id") or "").strip()
                    if tid_out:
                        result["bound_task_id"] = tid_out
                        result["task_id"] = tid_out
                        result["main_task"] = {
                            "taskId": tid_out,
                            "name": tm.get("name"),
                            "status": tm.get("status"),
                            "progress": int(tm.get("progress") or 0),
                        }
                        result["message"] += f" 已绑定主任务 {tid_out}（规划占位，后续可改名）。"
            except Exception:
                logger.debug("scenario activate(plan): ensure_plan_session_task skipped", exc_info=True)

        logger.info(
            "[ScenarioActivation] activated=%s, previous=%s, all_active=%s, reason=%s",
            scenario_key,
            previous,
            current,
            reason,
        )

        return json.dumps(result, ensure_ascii=False, indent=2)

    elif action_normalized == "deactivate":
        scenario_key = normalize_scenario_key(scenario_key)
        current = get_activated_scenarios()

        if scenario_key not in current:
            return json.dumps(
                {
                    "status": "noop",
                    "message": f"场景 {scenario_key} 未处于激活状态",
                    "all_active_scenarios": current,
                },
                ensure_ascii=False,
                indent=2,
            )

        _remove_scenario(scenario_key)
        remaining = get_activated_scenarios()

        result = {
            "status": "success",
            "action": "deactivate",
            "scenario_key": scenario_key,
            "reason": reason,
            "all_active_scenarios": remaining,
            **_scenario_tools_payload_for_run(remaining),
            "message": (
                f"场景已停用: {scenario_key}。剩余活跃场景: {', '.join(remaining) if remaining else 'none'}"
                + (
                    f"（已无活跃模式，本回合仅保留核心工具：{'、'.join(CORE_TOOL_NAMES)}。请根据用户真实意图决定是否 activate agent 等；纯闲聊可保持现状；若从 plan 退出且用户要继续改文件/联网，勿默认只当闲聊结束。）"
                    if not remaining
                    else ""
                )
            ),
        }

        logger.info(
            "[ScenarioActivation] deactivated=%s, remaining=%s, reason=%s",
            scenario_key,
            remaining,
            reason,
        )

        _idle_thread_collab_when_no_plan_scenario(remaining)

        return json.dumps(result, ensure_ascii=False, indent=2)

    else:
        return json.dumps(
            {
                "status": "error",
                "message": f"无效的 action: {action}。必须是 'activate' 或 'deactivate'",
            },
            ensure_ascii=False,
        )


try:
    mode_set.description = _scenario_tool_description()
except Exception:  # pragma: no cover
    logger.warning("[ScenarioActivation] failed to set mode_set.description", exc_info=True)

# Legacy import / wire-name aliases
scenario = mode_set
scenario_activation = mode_set


# ── Helper functions ──


def get_scenario_with_fallback(mission_state_intent: str | None = None) -> list[str]:
    """Get the effective scenario list, prioritizing activated scenarios over mission state.

    Auto-downgrade logic:
    - If mission_state consistently returns "chat" while non-chat scenarios are active,
      after _CHAT_OVERRIDE_THRESHOLD consecutive rounds, the activated scenarios are cleared.
    - Any non-chat mission_state resets the override counter.

    Args:
        mission_state_intent: The intent_hint from mission state (async LLM analysis).
            Supports comma-separated multi-scenario (e.g. "plan,workspace").

    Returns:
        List of effective scenario keys to use (never empty, defaults to ["chat"])
    """
    state = _scenario_var.get()
    activated = list(state.scenarios) if state else []

    # Parse mission_state_intent — may be comma-separated multi-scenario
    ms_keys: list[str] = []
    if mission_state_intent:
        for part in mission_state_intent.split(","):
            key = normalize_scenario_key(part.strip())
            if key and key not in ms_keys:
                ms_keys.append(key)

    if activated:
        # Auto-downgrade: check if mission_state consistently says "chat"
        # (only when ALL ms_keys are "chat")
        all_ask = bool(ms_keys) and all(k == "ask" for k in ms_keys)
        if all_ask:
            state.chat_override_count += 1
            if state.chat_override_count >= _CHAT_OVERRIDE_THRESHOLD:
                logger.info(
                    "[ScenarioActivation] auto-downgrade: %d consecutive chat from mission_state, clearing %s",
                    state.chat_override_count,
                    activated,
                )
                state.scenarios = []
                state.chat_override_count = 0
                _persist_activated_scenarios([])
                activated = []
        else:
            # Any non-chat mission_state resets the counter
            state.chat_override_count = 0

    # Tool binding and prompts follow explicit scenario() activation only — never infer from mission_state.
    return list(activated) or ["ask"]


# Backward-compatible alias
def get_activated_scenario() -> str | None:
    """Get the first activated scenario (backward compatible)."""
    scenarios = get_activated_scenarios()
    return scenarios[0] if scenarios else None


def get_scenario_tools(scenario_key: str | list[str]) -> list[str]:
    """Get the tool groups for a given scenario or list of scenarios.

    Args:
        scenario_key: A single scenario key or a list of scenario keys

    Returns:
        List of tool group names for these scenarios (deduplicated)
    """
    if isinstance(scenario_key, str):
        keys = [scenario_key]
    else:
        keys = scenario_key

    seen: set[str] = set()
    result: list[str] = []
    for key in keys:
        entry = SCENARIO_ENTRIES.get(key)
        if not entry:
            continue
        for g in entry.tool_groups:
            if g not in seen:
                seen.add(g)
                result.append(g)
    return result
