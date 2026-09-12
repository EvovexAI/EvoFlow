from __future__ import annotations

import hashlib
import logging
import os
import time as _time  # lru cache timing
from typing import Any

from langchain.agents import create_agent
from langchain.agents.middleware import AgentMiddleware
from langchain_core.runnables import RunnableConfig
from langgraph_sdk.runtime import ServerRuntime

# Lazy-imported to avoid circular import:
#   scenario_activation → intent_tool_profile → lead_agent/__init__ → agent → scenario_activation
# from evoflow.tools.builtins.scenario_activation import get_scenario_with_fallback, restore_activated_scenarios
from evoflow.agents.lead_agent.graph_cache import LeadAgentGraphCacheKey, get_or_build_lead_agent_graph
from evoflow.agents.lead_agent.intent_tool_profile import (
    BOOTSTRAP_TOOL_NAMES,
    CORE_TOOL_NAMES,
    NON_CORE_TOOL_GROUPS,
    TASK_SCENARIO_PROFILES,
    flat_bound_tool_names_for_session_mode,
    normalize_scenario_key,
    resolve_eager_tool_names_for_scenarios,
)
from evoflow.agents.lead_agent.prompt import apply_prompt_template
from evoflow.agents.lead_agent.prompt_language import resolve_prompt_language
from evoflow.agents.lead_agent.runtime_context import LeadAgentRuntimeContext
from evoflow.agents.middlewares.clarification_answers_middleware import ClarificationAnswersMiddleware
from evoflow.agents.middlewares.clarification_middleware import ClarificationMiddleware
from evoflow.agents.middlewares.collab_cycle_trace_middleware import CollabCycleTraceMiddleware
from evoflow.agents.middlewares.collab_lifecycle_stage_middleware import CollabLifecycleStageMiddleware
from evoflow.agents.middlewares.collab_phase_middleware import CollabPhaseMiddleware
from evoflow.agents.middlewares.collab_thread_live_context_footer_middleware import CollabThreadLiveContextFooterMiddleware
from evoflow.agents.middlewares.context_refs_footer_middleware import ContextRefsFooterMiddleware
from evoflow.agents.middlewares.dynamic_system_prompt_middleware import DynamicSystemPromptOnScenarioMiddleware
from evoflow.agents.middlewares.exploration_graph_live_footer_middleware import (
    ExplorationGraphLiveFooterMiddleware,
)
from evoflow.agents.middlewares.external_memory_plugin_middleware import ExternalMemoryPluginMiddleware
from evoflow.agents.middlewares.loop_detection_middleware import LoopDetectionMiddleware
from evoflow.agents.middlewares.memory_live_footer_middleware import MemoryLiveFooterMiddleware
from evoflow.agents.middlewares.memory_middleware import MemoryMiddleware
from evoflow.agents.middlewares.memory_runtime_control_middleware import MemoryRuntimeControlMiddleware
from evoflow.agents.middlewares.mission_state_live_footer_middleware import MissionStateLiveFooterMiddleware
from evoflow.agents.middlewares.xiaomi_ui_context_live_footer_middleware import (
    XiaomiUiContextLiveFooterMiddleware,
)
from evoflow.agents.middlewares.mission_state_middleware import MissionStateMiddleware
from evoflow.agents.goal.goal_prompt_assembler import GoalContinuationAssemblerMiddleware
from evoflow.agents.goal.goal_auto_continue_middleware import GoalAutoContinueMiddleware
# goal_report tool retired — completion detection handled solely by judge model
# (goal_reply_interpreter). GoalToolMiddleware import kept for backward compat.
from evoflow.agents.goal.goal_tool_middleware import GoalToolMiddleware  # noqa: F401
from evoflow.agents.middlewares.proactive_tool_middleware import ProactiveToolMiddleware
from evoflow.agents.middlewares.plan_doc_middleware import PlanDocMiddleware
from evoflow.agents.middlewares.plan_guard_middleware import PlanGuardMiddleware
from evoflow.agents.middlewares.round_trace_middleware import RoundTraceMiddleware
from evoflow.agents.middlewares.run_latency_timing_middleware import (
    LiveActivityToolMiddleware,
    RunLatencyCycleMiddleware,
    RunLatencyWrapMiddleware,
)
from evoflow.agents.middlewares.scenario_activation_sync_middleware import ScenarioActivationSyncMiddleware
from evoflow.agents.middlewares.tool_binding_sync_middleware import ToolBindingSyncMiddleware
from evoflow.agents.middlewares.scenario_runtime_hint_middleware import ScenarioRuntimeHintMiddleware
from evoflow.agents.middlewares.session_intent_middleware import SessionIntentMiddleware
from evoflow.agents.middlewares.session_transcript_hydration_middleware import (
    SessionTranscriptHydrationMiddleware,
)
from evoflow.agents.middlewares.subagent_limit_middleware import SubagentLimitMiddleware
from evoflow.agents.middlewares.title_middleware import TitleMiddleware
from evoflow.agents.middlewares.todo_middleware import TodoMiddleware
from evoflow.agents.middlewares.token_usage_middleware import TokenUsageMiddleware
from evoflow.agents.middlewares.tool_approval_middleware import (
    ToolApprovalAnswersMiddleware,
    ToolApprovalDenyContinueMiddleware,
    ToolApprovalMiddleware,
    ToolApprovalReplayMiddleware,
)
from evoflow.agents.middlewares.tool_error_handling_middleware import build_lead_runtime_middlewares
from evoflow.agents.middlewares.transcript_middleware import TranscriptMiddleware
from evoflow.agents.middlewares.turn_context_middleware import TurnContextMiddleware
from evoflow.agents.middlewares.view_image_middleware import ViewImageMiddleware
from evoflow.agents.middlewares.workspace_guard_middleware import WorkspaceGuardMiddleware
from evoflow.agents.mission_state import load_mission_state
from evoflow.agents.mission_state.config import MISSION_STATE_ENABLED
from evoflow.agents.thread_state import ThreadState
from evoflow.config.agents_config import (
    ensure_builtin_agents_materialized,
    load_agent_config,
    merge_skill_allowlist_with_preferred,
    parse_preferred_skills_from_context,
    resolve_skill_allowlist_for_lead_prompt,
)
from evoflow.config.app_config import get_app_config
from evoflow.config.paths import get_paths
from evoflow.config.summarization_config import get_summarization_config
from evoflow.models import create_chat_model

logger = logging.getLogger(__name__)


def _maybe_auto_enter_planning_for_plan(
    *,
    thread_id: str | None,
    activated_scenarios: list[str] | None,
    requested_collab_phase: str | None,
) -> str | None:
    """Auto-start planning phase when plan scenario is active.

    This allows "scenario plan mode" to reuse composer-style plan gating even when
    the client does not explicitly set plan mode / collab_phase.
    """
    requested = str(requested_collab_phase or "").strip().lower()
    try:
        from langgraph.config import get_config

        from evoflow.agents.middlewares.plan_guard_middleware import (
            is_subagent_focus_mode,
            session_should_sync_plan_scenario_active,
        )

        conf = (get_config() or {}).get("configurable") or {}
        if not isinstance(conf, dict):
            conf = {}
        if is_subagent_focus_mode(configurable=conf, collab_phase=requested_collab_phase):
            return requested_collab_phase or "idle"
        if not session_should_sync_plan_scenario_active(
            configurable=conf,
            collab_phase=requested_collab_phase,
        ):
            return requested_collab_phase or "idle"
    except Exception:
        pass
    # Treat idle as "not in collaborative workflow yet"; auto-enter planning for plan.
    if requested not in {"", "idle"}:
        return requested_collab_phase
    tid = str(thread_id or "").strip()
    if not tid:
        return requested_collab_phase
    scenarios = [str(x or "").strip().lower() for x in (activated_scenarios or []) if str(x or "").strip()]
    if "plan" not in scenarios:
        return requested_collab_phase
    try:
        from evoflow.collab.models import CollabPhase
        from evoflow.collab.thread_collab import load_thread_collab_state, merge_thread_collab_state, save_thread_collab_state

        paths = get_paths()
        cur = load_thread_collab_state(paths, tid)
        if cur.collab_phase != CollabPhase.IDLE:
            # Respect existing non-idle phase (e.g., already executing/paused).
            return cur.collab_phase.value if isinstance(cur.collab_phase, CollabPhase) else str(cur.collab_phase or "") or requested_collab_phase
        merged = merge_thread_collab_state(cur, {"collab_phase": CollabPhase.PLANNING.value})
        save_thread_collab_state(paths, tid, merged)
        try:
            from evoflow.collab.plan_session_task import ensure_plan_session_task

            ensure_plan_session_task(tid, paths=paths)
        except Exception:
            logger.debug("[AutoPlan] ensure_plan_session_task failed", exc_info=True)
        try:
            from evoflow.agents.middlewares.collab_cycle_trace_logging import write_cycle_trace

            write_cycle_trace(
                "auto_enter_planning_for_plan",
                {
                    "thread_id": tid,
                    "activated_scenarios": scenarios,
                    "set_collab_phase": CollabPhase.PLANNING.value,
                },
            )
        except Exception:
            pass
        logger.info("[AutoPlan] plan scenario active; set collab_phase=planning for thread=%s", tid)
        return CollabPhase.PLANNING.value
    except Exception as e:
        logger.warning("[AutoPlan] failed to auto-enter planning for thread=%s: %s", tid, e)
        return requested_collab_phase


def _env_bool(name: str, default: bool) -> bool:
    raw = (os.getenv(name) or "").strip().lower()
    if not raw:
        return default
    return raw in {"1", "true", "yes", "on"}


def _extract_user_question_from_configurable(cfg: dict) -> str:
    """Best-effort extraction of current user input for prompt logging."""

    def _extract_from_any(value) -> str:
        if isinstance(value, str):
            return value.strip()
        if isinstance(value, dict):
            # Common message-like keys
            for key in ("text", "content", "query", "question", "prompt"):
                v = value.get(key)
                if isinstance(v, str) and v.strip():
                    return v.strip()
            # Nested message arrays
            for key in ("messages", "input_messages"):
                v = value.get(key)
                if isinstance(v, list):
                    s = _extract_latest_human_from_messages(v)
                    if s:
                        return s
            return ""
        if isinstance(value, list):
            # Prefer latest human-like message in reverse order
            s = _extract_latest_human_from_messages(value)
            if s:
                return s
            parts: list[str] = []
            for item in value:
                t = _extract_from_any(item)
                if t:
                    parts.append(t)
            return " ".join(parts).strip()
        return ""

    def _extract_latest_human_from_messages(messages: list) -> str:
        for item in reversed(messages):
            if isinstance(item, dict):
                role = str(item.get("role") or item.get("type") or "").lower()
                if role in {"human", "user"}:
                    s = _extract_from_any(item)
                    if s:
                        return s
                # LangChain content blocks
                content = item.get("content")
                s = _extract_from_any(content)
                if s and role in {"human", "user"}:
                    return s
            elif isinstance(item, str) and item.strip():
                return item.strip()
        return ""

    # Try common top-level keys first
    for key in (
        "evf_user_question",
        "user_message",
        "user_input",
        "input",
        "query",
        "question",
        "prompt",
        "latest_user_message",
        "messages",
        "input_messages",
    ):
        if key not in cfg:
            continue
        s = _extract_from_any(cfg.get(key))
        if s:
            return s
    return ""


def _parse_intent_tags(intent_hint: str | None) -> set[str]:
    if not intent_hint:
        return {"general"}
    raw = str(intent_hint).replace("|", ",").replace("/", ",").replace("+", ",")
    tags = {normalize_scenario_key(x) for x in raw.split(",") if x.strip()}
    return tags or {"general"}


def _tool_matches(tool_name: str, keywords: tuple[str, ...]) -> bool:
    n = (tool_name or "").strip().lower()
    if not n:
        return False
    return any(k in n for k in keywords)


def _scenario_eager_tools_enabled() -> bool:
    """When true, scenario activation binds Tier-1 eager tools only; rest stay deferred."""
    return _env_bool("EVOFLOW_SCENARIO_EAGER_TOOLS", True)


def _tool_name_in_keep_set(tool_name: str, keep_names: set[str]) -> bool:
    """Exact catalog match plus explicit legacy aliases (never substring, e.g. read ≠ read_lints)."""
    from evoflow.tools.tool_aliases import canonical_tool_name

    n = str(tool_name or "").strip().lower()
    if not n:
        return False
    if n in keep_names:
        return True
    canon = canonical_tool_name(n)
    return bool(canon and canon in keep_names)


def _filter_tools_by_intent(tools, intent_hint: str | None):
    """Load core tools first, then union intent-group tools (supports multi-intent).

    With ``EVOFLOW_SCENARIO_EAGER_TOOLS=1`` (default), only Tier-1 eager names bind;
    the full scenario union remains in ``all_tools`` for deferred discovery.
    """
    tags = _parse_intent_tags(intent_hint)
    core_names = {x.strip().lower() for x in CORE_TOOL_NAMES}
    if _scenario_eager_tools_enabled():
        keep_names = resolve_eager_tool_names_for_scenarios(tags)
    else:
        group_to_tools = {g: {str(t).strip().lower() for t in (meta.get("tools", ()) or ())} for g, meta in NON_CORE_TOOL_GROUPS.items()}
        intent_extra: set[str] = set()
        for tag in tags:
            p = TASK_SCENARIO_PROFILES.get(tag)
            if not p:
                continue
            for g in p.tool_groups:
                intent_extra.update(group_to_tools.get(g, set()))
            intent_extra.update({x.strip().lower() for x in p.extra_tool_names})
        keep_names = core_names | intent_extra
    keep = []
    for t in tools:
        name = str(getattr(t, "name", "") or "").strip().lower()
        if _tool_name_in_keep_set(name, keep_names):
            keep.append(t)
            continue
    # De-duplicate while preserving order.
    uniq = []
    seen = set()
    for t in keep:
        n = str(getattr(t, "name", "") or "")
        if n in seen:
            continue
        seen.add(n)
        uniq.append(t)
    # Safety fallback: never return empty set.
    # CORE_TOOL_NAMES is empty (all tools deferred + tool_search),
    # so we only fallback on truly empty results.
    if not uniq:
        return tools
    return uniq


def _filter_tools_by_name_set(tools, keep_names: set[str]):
    keep = []
    for t in tools:
        name = str(getattr(t, "name", "") or "").strip().lower()
        if _tool_name_in_keep_set(name, keep_names):
            keep.append(t)
            continue
    uniq = []
    seen = set()
    for t in keep:
        n = str(getattr(t, "name", "") or "")
        if n in seen:
            continue
        seen.add(n)
        uniq.append(t)
    # Safety fallback: never return empty set.
    # CORE_TOOL_NAMES is empty (all tools deferred + tool_search),
    # so we only fallback on truly empty results.
    if not uniq:
        return tools
    return uniq


def _mcp_use_skill_binding() -> bool:
    """Deprecated: legacy skill path removed (native-style native binding only)."""
    from evoflow.mcp.binding import warn_if_legacy_mcp_skill_binding_env

    warn_if_legacy_mcp_skill_binding_env()
    return False


def _agent_mcp_skill_mode_enabled(agent_config) -> bool:
    """Deprecated: always False — MCP uses native tool binding."""
    _mcp_use_skill_binding()
    return False


def _strip_mcp_tools(tools):
    from evoflow.mcp.binding import mcp_server_from_tool_name

    return [t for t in (tools or []) if mcp_server_from_tool_name(getattr(t, "name", "") or "") is None]


_MIND_MAP_TOOL_NAMES = frozenset({"mind_map"})


def _strip_mind_map_tools(tools):
    """Drop ``mind_map`` when exploration graph is disabled via panel settings."""
    try:
        from evoflow.exploration_graph.config import is_exploration_graph_enabled

        if is_exploration_graph_enabled():
            return list(tools or [])
    except Exception:
        return list(tools or [])
    return [
        t
        for t in (tools or [])
        if str(getattr(t, "name", "") or "").strip() not in _MIND_MAP_TOOL_NAMES
    ]


def _mcp_server_from_tool_name(tool_name: str) -> str | None:
    from evoflow.mcp.binding import mcp_server_from_tool_name

    return mcp_server_from_tool_name(tool_name)


def _filter_tools_by_mcp_servers(tools, mcp_servers: list[str] | None):
    from evoflow.mcp.binding import filter_tools_by_mcp_servers

    return filter_tools_by_mcp_servers(tools, mcp_servers)


def _mount_agent_mcp_tools(loaded_tools, all_tools, mcp_servers: list[str] | None):
    from evoflow.mcp.binding import mount_agent_mcp_tools

    return mount_agent_mcp_tools(loaded_tools, all_tools, mcp_servers)


def _refresh_deferred_registry_from_delta(all_tools, loaded_tools) -> None:
    """Build deferred registry as (all_tools - loaded_tools) for progressive loading."""
    try:
        from evoflow.config.tool_search_config import is_tool_search_enabled
        from evoflow.tools.builtins.tool_search import DeferredToolRegistry, set_deferred_registry, set_tool_search_catalog

        if not is_tool_search_enabled():
            return

        loaded_names = {str(getattr(t, "name", "") or "").strip() for t in (loaded_tools or [])}
        registry = DeferredToolRegistry()
        seen = set()
        for t in all_tools or []:
            n = str(getattr(t, "name", "") or "").strip()
            if not n or n in loaded_names or n == "tool_search" or n in seen:
                continue
            seen.add(n)
            registry.register(t)
        set_deferred_registry(registry)
        set_tool_search_catalog(all_tools or [], loaded_names)
        logger.debug("[DynamicToolProfile] deferred registry refreshed: %s entries", len(registry.entries))
    except Exception as e:
        logger.warning("Failed to refresh deferred registry from tool delta: %s", e)


_last_models_revision: str = ""


def _models_runtime_revision() -> str:
    """Cheap DB stamp: changes when model/connection credentials or primary_model change."""
    try:
        from evoflow.persistence.db import get_db

        row = get_db().execute(
            """
            SELECT
              (SELECT COALESCE(MAX(updated_at), '') FROM evoflow_models),
              (SELECT COALESCE(MAX(updated_at), '') FROM evoflow_model_connections),
              (SELECT COALESCE(value_text, '') FROM evoflow_app_settings WHERE key = 'primary_model')
            """
        ).fetchone()
        if not row:
            return ""
        return f"{row[0]}|{row[1]}|{row[2]}"
    except Exception:
        logger.debug("models runtime revision probe failed", exc_info=True)
        return ""


def _model_credentials_fp(model_name: str) -> str:
    """Short hash of fields baked into ChatOpenAI (etc.) for graph-cache keying."""
    try:
        m = get_app_config().get_model_config(str(model_name or "").strip())
    except Exception:
        m = None
    if m is None:
        return ""
    raw = "|".join(
        [
            str(getattr(m, "api_key", None) or ""),
            str(getattr(m, "base_url", None) or ""),
            str(getattr(m, "use", None) or ""),
            str(getattr(m, "model", None) or ""),
            repr(getattr(m, "credentials", None) or []),
            str(getattr(m, "credential_strategy", None) or ""),
        ]
    )
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


def _refresh_chat_models_from_db() -> None:
    """Reload ``evoflow_models`` into this process when SQLite credentials changed.

    Gateway (or Panel) may update keys in another code path / process. LangGraph
    workers are long-lived and keep AppConfig + lead-agent graphs that already
    baked in the old ``api_key``. A wall-clock TTL is not enough — we stamp on
    ``updated_at`` so the next turn picks up a key change immediately.
    """
    global _last_models_revision
    rev = _models_runtime_revision()
    if rev and rev == _last_models_revision:
        return
    from evoflow.config import reload_models_from_db

    reload_models_from_db()
    # If the probe failed (empty rev), still advance so we do not hammer reload;
    # next successful probe will reload when stamps move.
    _last_models_revision = rev or _models_runtime_revision() or "reloaded"


def _resolve_model_name(requested_model_name: str | None = None) -> str:
    """Resolve a runtime model name safely, falling back to default if invalid."""
    app_config = get_app_config()
    if not app_config.models:
        _refresh_chat_models_from_db()
        app_config = get_app_config()
    if not app_config.models:
        raise ValueError("No chat models are configured. Add at least one model in Settings → Models.")

    # 优先使用配置的 primary_model，否则使用第一个模型
    default_model_name = app_config.primary_model or app_config.models[0].name

    if requested_model_name and app_config.get_model_config(requested_model_name):
        return requested_model_name

    if requested_model_name and requested_model_name != default_model_name:
        logger.warning(f"Model '{requested_model_name}' not found in config; fallback to default model '{default_model_name}'.")
    return default_model_name


def _create_context_compaction_middleware():
    """Hermes-style context compaction (replaces LangChain SummarizationMiddleware)."""
    if not get_summarization_config().enabled:
        return None
    from evoflow.agents.middlewares.context_compaction_middleware import ContextCompactionMiddleware

    return ContextCompactionMiddleware()


def _create_todo_list_middleware(is_plan_mode: bool) -> TodoMiddleware | None:
    """Create and configure LangChain ``write_todos`` middleware.

    Args:
        is_plan_mode: Whether to inject TodoList middleware (product flag + no active ``plan`` scenario).

    Returns:
        TodoMiddleware instance when enabled, otherwise None.
    """
    if not is_plan_mode:
        return None

    # Custom prompts matching EvoFlow's style
    system_prompt = """
<todo_list_system>
You have access to the `write_todos` tool to help you manage and track complex multi-step objectives.

**CRITICAL RULES:**
- For non-trivial work, use `write_todos` to track steps (each item: content, status; optional `result` when done).
- Fill `result` when marking `completed` (evidence: paths, command output, conclusion).
- Mark todos as completed IMMEDIATELY after finishing each step - do NOT batch completions
- Keep EXACTLY ONE task as `in_progress` at any time (unless tasks can run in parallel)
- Update the todo list in REAL-TIME as you work - this gives users visibility into your progress
- DO NOT use this tool for simple tasks (< 3 steps) - just complete them directly
- Do NOT use `write_todos` when the active scenario is `plan` (use supervisor subtasks instead).

**When to Use:**
This tool is designed for complex objectives that require systematic tracking:
- Complex multi-step tasks requiring 3+ distinct steps
- Non-trivial tasks needing careful planning and execution
- User explicitly requests a todo list
- User provides multiple tasks (numbered or comma-separated list)
- The plan may need revisions based on intermediate results

**When NOT to Use:**
- Single, straightforward tasks
- Trivial tasks (< 3 steps)
- Purely conversational or informational requests
- Simple tool calls where the approach is obvious

**Best Practices:**
- Break down complex tasks into smaller, actionable steps
- Use clear, descriptive task names
- Remove tasks that become irrelevant
- Add new tasks discovered during implementation
- Don't be afraid to revise the todo list as you learn more

**Task Management:**
Writing todos takes time and tokens - use it when helpful for managing complex problems, not for simple requests.
</todo_list_system>
"""

    tool_description = """Use this tool to create and manage a structured task list for complex work sessions.

**IMPORTANT: Only use this tool for complex tasks (3+ steps). For simple requests, just do the work directly.**

## When to Use

Use this tool in these scenarios:
1. **Complex multi-step tasks**: When a task requires 3 or more distinct steps or actions
2. **Non-trivial tasks**: Tasks requiring careful planning or multiple operations
3. **User explicitly requests todo list**: When the user directly asks you to track tasks
4. **Multiple tasks**: When users provide a list of things to be done
5. **Dynamic planning**: When the plan may need updates based on intermediate results

## When NOT to Use

Skip this tool when:
1. The task is straightforward and takes less than 3 steps
2. The task is trivial and tracking provides no benefit
3. The task is purely conversational or informational
4. It's clear what needs to be done and you can just do it

## How to Use

1. **Starting a task**: Mark it as `in_progress` BEFORE beginning work
2. **Completing a task**: Mark it as `completed` IMMEDIATELY after finishing; set optional `result` field with evidence
3. **Updating the list**: Add new tasks, remove irrelevant ones, or update descriptions as needed
4. **Multiple updates**: You can make several updates at once (e.g., complete one task and start the next)

Each todo object: `{"content": "...", "status": "pending|in_progress|completed", "result": "optional outcome summary"}`

## Task States

- `pending`: Task not yet started
- `in_progress`: Currently working on (can have multiple if tasks run in parallel)
- `completed`: Task finished successfully

## Task Completion Requirements

**CRITICAL: Only mark a task as completed when you have FULLY accomplished it.**

Never mark a task as completed if:
- There are unresolved issues or errors
- Work is partial or incomplete
- You encountered blockers preventing completion
- You couldn't find necessary resources or dependencies
- Quality standards haven't been met

If blocked, keep the task as `in_progress` and create a new task describing what needs to be resolved.

## Best Practices

- Create specific, actionable items
- Break complex tasks into smaller, manageable steps
- Use clear, descriptive task names
- Update task status in real-time as you work
- Mark tasks complete IMMEDIATELY after finishing (don't batch completions)
- Remove tasks that are no longer relevant
- **IMPORTANT**: When you write the todo list, mark your first task(s) as `in_progress` immediately
- **IMPORTANT**: Unless all tasks are completed, always have at least one task `in_progress` to show progress

Being proactive with task management demonstrates thoroughness and ensures all requirements are completed successfully.

**Remember**: If you only need a few tool calls to complete a task and it's clear what to do, it's better to just do the task directly and NOT use this tool at all.
"""

    return TodoMiddleware(system_prompt=system_prompt, tool_description=tool_description)


# ThreadDataMiddleware must be before SandboxMiddleware to ensure thread_id is available
# UploadsMiddleware should be after ThreadDataMiddleware to access thread_id
# DanglingToolCallMiddleware patches missing ToolMessages before model sees the history
# ContextCompactionMiddleware runs after SessionTranscriptHydrationMiddleware (hydrate) and after
# DeferredToolFilter + PlanGuard (final tool list / system prompt), then folds ephemerally at
# wrap_model_call (not checkpoint).
# UI transcript + compaction summaries live in ``evoflow_chat_messages`` only.
# TodoListMiddleware should be before ClarificationMiddleware to allow todo management
# TitleMiddleware generates title after first exchange
# MemoryMiddleware queues conversation for memory update (after TitleMiddleware)
# ViewImageMiddleware should be before ClarificationMiddleware to inject image details before LLM
# ToolErrorHandlingMiddleware should be before ClarificationMiddleware to convert tool exceptions to ToolMessages
# CollabPhaseMiddleware injects per-phase collaboration rules when runtime.context.collab_phase is set
# ClarificationAnswersMiddleware normalizes structured clarification form answers.
# PlanGuardMiddleware enforces read-only tool behavior in planning-like phases.
# PlanDocMiddleware persists assistant planning output to outputs/plan.md.
# ClarificationMiddleware should be last to intercept clarification requests after model calls


def _instrument_middleware_timing_all(middlewares: list[AgentMiddleware]) -> None:
    """Attach per-middleware timing framework (threshold via ``EVOFLOW_MW_TIMING_MS``)."""
    from evoflow.agents.middlewares.middleware_timing import instrument_middleware_timing

    instrument_middleware_timing(middlewares)


def _build_middlewares(config: RunnableConfig, model_name: str | None, agent_name: str | None = None, custom_middlewares: list[AgentMiddleware] | None = None):
    """Build middleware chain based on runtime configuration.

    Args:
        config: Runtime configuration containing configurable options like is_plan_mode.
        agent_name: If provided, MemoryMiddleware will use per-agent memory storage.
        custom_middlewares: Optional list of custom middlewares to inject into the chain.

    Returns:
        List of middleware instances.
    """
    middlewares = build_lead_runtime_middlewares(lazy_init=True)

    # First in chain ⇒ after_agent runs last: other after_agent hooks still see full
    # messages; final checkpoint (esp. durability=exit) drops transcript blobs.
    # SSOT is evoflow_chat_messages — see CheckpointTranscriptSlimMiddleware.
    from evoflow.agents.middlewares.checkpoint_transcript_slim_middleware import (
        CheckpointTranscriptSlimMiddleware,
    )

    middlewares.insert(0, CheckpointTranscriptSlimMiddleware())

    # Start the model-cycle clock as early as possible (after runtime ThreadData/Sandbox),
    # so claim→before_model blind time is visible and 「准备中」covers real prep.
    middlewares.append(RunLatencyCycleMiddleware())

    # Persist AI/tool messages and artifacts to independent tables after each model call.
    # Placed early so its after_model runs last (middleware chain reverses after_model order),
    # capturing the final state after all other middlewares have processed.
    middlewares.append(TranscriptMiddleware())

    # Reload scenario ContextVar from mission_state JSON before each model call (multi-step / ToolNode contexts).
    middlewares.append(ScenarioActivationSyncMiddleware())
    # Restore per-scenario deferred tool bindings from session DB before each model call.
    middlewares.append(ToolBindingSyncMiddleware())
    # Strip ``<memory>...</memory>`` when runtime.context disables injection (before other wrap_model_call patches)
    middlewares.append(MemoryRuntimeControlMiddleware())
    middlewares.append(SessionIntentMiddleware())
    middlewares.append(TurnContextMiddleware())

    # Context compaction (Hermes-style) when summarization.enabled in config.
    # Middleware instance is created here; registered late (after tool filters + live footers).
    compaction_middleware = _create_context_compaction_middleware()
    middlewares.append(SessionTranscriptHydrationMiddleware())
    # After hydration: inject upload metadata + user-attached local paths.
    from evoflow.agents.middlewares.context_files_middleware import ContextFilesMiddleware
    from evoflow.agents.middlewares.uploads_middleware import UploadsMiddleware

    middlewares.append(UploadsMiddleware())
    middlewares.append(ContextFilesMiddleware())

    middlewares.append(GoalAutoContinueMiddleware())
    middlewares.append(GoalContinuationAssemblerMiddleware())

    # Add TodoList middleware if plan mode is enabled。
    # - 缺省与 make_lead_agent 一致为 True（Gateway 可显式传 false）。
    # - ``plan`` 场景走 supervisor，不写会话内 write_todos。
    # - 无激活非 chat 场景（纯对话回退）时不挂载，避免切回聊天仍带 <todo_list_system>。
    is_plan_mode = bool(config.get("configurable", {}).get("is_plan_mode", True))
    try:
        from evoflow.tools.builtins.scenario_activation import get_activated_scenarios

        acts = [str(s).strip().lower() for s in (get_activated_scenarios() or []) if str(s).strip()]
        if not acts:
            is_plan_mode = False
        elif any(s == "plan" for s in acts):
            is_plan_mode = False
    except Exception:
        pass
    todo_list_middleware = _create_todo_list_middleware(is_plan_mode)
    if todo_list_middleware is not None:
        middlewares.append(todo_list_middleware)

    # Add TokenUsageMiddleware when token_usage tracking is enabled
    if get_app_config().token_usage.enabled:
        middlewares.append(TokenUsageMiddleware())

    # Add TitleMiddleware
    middlewares.append(TitleMiddleware())

    # MemoryMiddleware: queue user/workspace memory after_model (once per user turn)
    middlewares.append(MemoryMiddleware(agent_name=agent_name))
    # MissionState：用户每条消息后、模型第一轮回复完成时异步分析主问题/子问题（EVOFLOW_MISSION_STATE_ENABLED=0 关闭）
    if MISSION_STATE_ENABLED:
        middlewares.append(MissionStateMiddleware())

    # External memory plugin (Hermes-style): prefetch fence in before_model when configured
    middlewares.append(ExternalMemoryPluginMiddleware())

    # view_image native: stage paths in state; inject ephemeral pixels before each LLM call.
    middlewares.append(ViewImageMiddleware())

    # Add DeferredToolFilterMiddleware to hide deferred tool schemas from model binding
    try:
        from evoflow.config.tool_search_config import is_tool_search_enabled

        _ts_on = bool(is_tool_search_enabled())
    except Exception:
        _ts_on = False
    if _ts_on:
        from evoflow.agents.middlewares.deferred_tool_filter_middleware import DeferredToolFilterMiddleware

        middlewares.append(DeferredToolFilterMiddleware())
    from evoflow.agents.middlewares.scheduler_orchestration_middleware import (
        SchedulerOrchestrationMiddleware,
    )

    # Prefetch reads only after search_code_index (read_limit>0), not on workspace bind / every turn.
    middlewares.append(SchedulerOrchestrationMiddleware())

    # Phase/tool guard before dynamic prompt rebuild so collab_phase + filtered tools match model call.
    middlewares.append(PlanGuardMiddleware())
    # Smart-employee: MUST be before DynamicSystemPrompt (first=outermost in langchain).
    # Patches tools first so Dynamic sees proactive_submit_work; Dynamic then sets
    # duty-only system brief (replacing chat orchestration prompt entirely).
    middlewares.append(ProactiveToolMiddleware())
    # After Deferred/PlanGuard/Proactive: freeze sorted tools[] for prefix-cache stability.
    from evoflow.agents.middlewares.tool_surface_lock_middleware import ToolSurfaceLockMiddleware

    middlewares.append(ToolSurfaceLockMiddleware())
    # Rebind full system prompt when scenario / model-visible tools / collab phase change.
    # On proactive runs this short-circuits to the duty brief (no chat template).
    middlewares.append(DynamicSystemPromptOnScenarioMiddleware())
    from evoflow.agents.middlewares.skills_injection_middleware import SkillsInjectionMiddleware

    middlewares.append(SkillsInjectionMiddleware())
    # Immediate, one-step scenario guidance after `scenario` tool success.
    middlewares.append(ScenarioRuntimeHintMiddleware())
    # Fresh plan/task snapshot at end of message list every model call (survives prompt fingerprint skip + summarization).
    middlewares.append(CollabThreadLiveContextFooterMiddleware())
    # 小V：当前页快照走 ephemeral Human（name=xiaomi_ui_context），不进 system，保前缀缓存。
    middlewares.append(XiaomiUiContextLiveFooterMiddleware())

    # Add SubagentLimitMiddleware to truncate excess parallel task calls
    # subagent_enabled is always True now (no config switch needed)
    max_concurrent_subagents = config.get("configurable", {}).get("max_concurrent_subagents", 5)
    middlewares.append(SubagentLimitMiddleware(max_concurrent=max_concurrent_subagents))

    # Collaboration phase hints (runtime.context.collab_phase from /api/collab + ws-client)
    middlewares.append(CollabPhaseMiddleware())
    # Normalize structured clarification / tool-approval payloads from the user.
    middlewares.append(ClarificationAnswersMiddleware())
    middlewares.append(ToolApprovalAnswersMiddleware())
    middlewares.append(ToolApprovalDenyContinueMiddleware())
    middlewares.append(ToolApprovalReplayMiddleware())
    # Read-only guard for planning/confirmation phases.
    middlewares.append(WorkspaceGuardMiddleware())
    # Log model-visible tools AFTER PlanGuard (supervisor gating, phase allowlists) so lead_agent_round_trace matches API payloads.
    middlewares.append(RoundTraceMiddleware())
    # Persist planning output as a markdown artifact.
    middlewares.append(PlanDocMiddleware())
    # Full planning/execution lifecycle trace for debugging collaboration flows.
    middlewares.append(CollabCycleTraceMiddleware())
    # Stage-level Chinese lifecycle milestones for end-to-end task flow.
    middlewares.append(CollabLifecycleStageMiddleware())

    # LoopDetectionMiddleware — detect and break repetitive tool call loops
    middlewares.append(LoopDetectionMiddleware())
    # Cap unattended (cron + proactive) tool rounds before GraphRecursionError.
    from evoflow.agents.middlewares.automation_run_guard_middleware import AutomationRunGuardMiddleware

    middlewares.append(AutomationRunGuardMiddleware())
    from evoflow.agents.middlewares.session_budget_middleware import SessionBudgetMiddleware

    middlewares.append(SessionBudgetMiddleware())
    try:
        from evoflow.exploration_graph.config import is_exploration_graph_enabled

        if is_exploration_graph_enabled():
            from evoflow.agents.middlewares.mind_map_evidence_hint_middleware import MindMapEvidenceHintMiddleware

            middlewares.append(MindMapEvidenceHintMiddleware())
    except Exception:
        from evoflow.agents.middlewares.mind_map_evidence_hint_middleware import MindMapEvidenceHintMiddleware

        middlewares.append(MindMapEvidenceHintMiddleware())

    # Inject custom middlewares before ClarificationMiddleware
    if custom_middlewares:
        middlewares.extend(custom_middlewares)

    middlewares.append(RunLatencyWrapMiddleware())
    middlewares.append(LiveActivityToolMiddleware())
    middlewares.append(ToolApprovalMiddleware())
    # ModelFallbackMiddleware catches model API errors and returns user-friendly AIMessage (before ClarificationMiddleware).
    from evoflow.agents.middlewares.model_fallback_middleware import ModelFallbackMiddleware

    middlewares.append(ModelFallbackMiddleware())
    # Fresh mission/intent snapshot immediately before model (async analysis may finish mid tool-loop).
    middlewares.append(MissionStateLiveFooterMiddleware())
    middlewares.append(ExplorationGraphLiveFooterMiddleware())
    from evoflow.agents.middlewares.workspace_runtime_live_footer_middleware import (
        WorkspaceRuntimeLiveFooterMiddleware,
    )

    middlewares.append(WorkspaceRuntimeLiveFooterMiddleware())
    middlewares.append(MemoryLiveFooterMiddleware())
    # ContextRefsFooter MUST run after DynamicSystemPromptOnScenarioMiddleware:
    # the latter rebuilds ``system_message`` from scratch on fingerprint change
    # (new user message / scenario / tool list / role change) and would otherwise
    # drop any ``<context_refs>`` block this middleware just appended.
    # Keep it in the live-footer cluster — same pattern as memory / mission_state /
    # workspace_runtime footers (strip stale + append fresh).
    middlewares.append(ContextRefsFooterMiddleware())
    # Fold model context after deferred-tool stripping, phase guards, and live footers so gate
    # tokens match the wire payload (active tools + final system prompt).
    if compaction_middleware is not None:
        middlewares.append(compaction_middleware)
    from evoflow.agents.middlewares.thinking_context_guard_middleware import ThinkingContextGuardMiddleware

    middlewares.append(ThinkingContextGuardMiddleware())
    # ClarificationMiddleware should always be last
    middlewares.append(ClarificationMiddleware())

    # ── Instrument middlewares with before_model/abefore_model timing ──
    _instrument_middleware_timing_all(middlewares)

    return middlewares


def _user_context_from_server_runtime(runtime: ServerRuntime | None) -> dict[str, Any]:
    """Static run ``context`` from LangGraph Agent Server (context-only API; no client ``configurable``)."""
    if runtime is None:
        return {}
    try:
        from evoflow.agents.lead_agent.runtime_context import context_to_dict

        ert = runtime.execution_runtime
        if ert is None:
            return {}
        ctx = getattr(ert, "context", None)
        return context_to_dict(ctx)
    except Exception:
        return {}


def _inject_goal_mode_into_cfg(cfg: dict[str, Any]) -> None:
    """Ensure ``hosted_goal_mode`` reaches middleware via configurable when Goal is in-flight."""
    sk = str(cfg.get("session_key") or "").strip()
    if not sk:
        tid = str(cfg.get("thread_id") or "").strip()
        if tid:
            try:
                from evoflow.persistence.session_repositories import find_session_key_by_thread_id

                sk = str(find_session_key_by_thread_id(tid) or "").strip()
                if sk:
                    cfg["session_key"] = sk
            except Exception:
                pass
    if not sk:
        return
    try:
        from evoflow.agents.goal.goal_runtime import (
            goal_mode_from_context,
            infer_goal_mode_from_row,
            load_goal_row,
        )

        row = load_goal_row(sk)
        if not row:
            return
        explicit = goal_mode_from_context(cfg)
        if explicit or infer_goal_mode_from_row(row):
            cfg["goal_mode"] = True
            cfg.setdefault("goal_automated", True)
    except Exception:
        logger.debug("inject goal_mode failed sk=%s", sk, exc_info=True)


def _ensure_tool_search_mounted(tool_list: list) -> list:
    """Guarantee ``tool_search`` is present when deferred loading is on."""
    if any(str(getattr(t, "name", "") or "").strip() == "tool_search" for t in (tool_list or [])):
        return list(tool_list or [])
    from evoflow.tools.builtins.tool_search import tool_search as tool_search_tool

    return list(tool_list or []) + [tool_search_tool]


def make_lead_agent(config: RunnableConfig, runtime: ServerRuntime | None = None):
    # Lazy import to avoid circular dependency
    import time

    from evoflow.tools import get_available_tools

    _t_entry_agent = time.perf_counter()
    _t0_db = time.perf_counter()
    _tid0 = None
    _tr0 = None
    try:
        from evoflow.observability.run_latency_trace import write_run_latency_event as _rl_write

        _cfg0 = dict((config or {}).get("configurable") or {})
        _tid0 = str(_cfg0.get("thread_id") or "").strip() or None
        _tr0 = str(_cfg0.get("evf_trace_id") or "").strip() or None
        if _tid0:
            _rl_write(
                _tid0,
                "make_lead_agent_enter",
                {"make_lead_agent_enter_wall_ms": int(time.time() * 1000)},
                trace_id=_tr0,
            )
    except Exception:
        pass
    _refresh_chat_models_from_db()
    try:
        from evoflow.config.tool_search_config import sync_tool_search_enabled_from_db

        sync_tool_search_enabled_from_db()
    except Exception:
        logger.debug("sync_tool_search_enabled_from_db failed", exc_info=True)
    _t1_db = time.perf_counter()
    ensure_builtin_agents_materialized()
    _t2_agent = time.perf_counter()
    _t_db_ms = (_t1_db - _t0_db) * 1000.0
    _t_agent_ms = (_t2_agent - _t1_db) * 1000.0
    if _t_db_ms > 5:
        print(f"[AGENT-TIMING] refresh_chat_models_db={_t_db_ms:.0f}ms", flush=True)
    if _t_agent_ms > 5:
        print(f"[AGENT-TIMING] ensure_builtin_agents={_t_agent_ms:.0f}ms", flush=True)
    _t3_conf = time.perf_counter()

    rt_ctx = _user_context_from_server_runtime(runtime)
    base_conf = dict(config.get("configurable") or {})
    cfg: dict[str, Any] = {**base_conf, **rt_ctx}
    try:
        from evoflow.authz.runtime_identity import enrich_run_context_identity

        cfg = enrich_run_context_identity(cfg)
    except Exception:
        pass
    _inject_goal_mode_into_cfg(cfg)
    effective_config: RunnableConfig = {**config, "configurable": cfg}

    session_mode = str(cfg.get("session_mode") or "").strip().lower()
    requested_model_name: str | None = cfg.get("model_name") or cfg.get("model")
    # 默认开启规划模式；Gateway ``runs.wait`` 通过 ``context.is_plan_mode``（或旧版 configurable）关闭规划以省超步
    if "is_plan_mode" in cfg:
        is_plan_mode = bool(cfg.get("is_plan_mode"))
    else:
        is_plan_mode = True
    # 与 _build_middlewares 共用同一份 configurable，避免默认 True 但未写入 cfg 时中间件读到缺省 False
    cfg["is_plan_mode"] = is_plan_mode
    subagent_enabled = True  # 始终启用子代理工具，让 Lead Agent 能够分配任务（去掉开关）
    include_subagent_system_prompt = bool(cfg.get("include_subagent_system_prompt", False))
    max_concurrent_subagents = cfg.get("max_concurrent_subagents", 5)
    is_bootstrap = cfg.get("is_bootstrap", False)
    # In-session role switch keeps session_key as agent:main:…; prefer flat agent_id.
    _aid = str(cfg.get("agent_id") or "").strip()
    _aname = str(cfg.get("agent_name") or "").strip()
    agent_name = _aid or _aname or "main"
    include_search = cfg.get("include_search", True)
    use_virtual_paths = cfg.get("use_virtual_paths", False)
    tools_mode = cfg.get("tools_mode", None)  # "host_direct" | "sandbox" | None
    local_workspace_root = cfg.get("local_workspace_root")
    intent_hint = cfg.get("intent_hint")
    mission_state = cfg.get("mission_state")
    thread_id = cfg.get("thread_id")
    collab_phase = cfg.get("collab_phase")
    voice_mode = bool(cfg.get("channel") == "voice" or cfg.get("is_voice_channel"))

    # Voice mode: lower temperature for more concise, deterministic output
    _voice_temp = 0.35 if voice_mode else None

    thinking_type: str | None = str(cfg.get("thinking_type") or "").strip().lower() or None
    # Missing thinking_enabled must NOT default ON — Auto means omit vendor params.
    _te_raw = cfg.get("thinking_enabled", None)
    if _te_raw is None:
        thinking_enabled = False
    else:
        thinking_enabled = bool(_te_raw)
    reasoning_effort = cfg.get("reasoning_effort", None)

    # Flash mode must be strict non-thinking regardless of prompt wording.
    # This is a backend hard guard in case frontend/session context is stale.
    if session_mode == "flash":
        thinking_enabled = False
        reasoning_effort = "minimum"
    # Voice turns: force non-thinking — long reasoning adds latency and TTS noise.
    if voice_mode:
        thinking_enabled = False
        reasoning_effort = "minimum"
        thinking_type = "disabled"
        cfg["thinking_enabled"] = False
        cfg["thinking_type"] = "disabled"
        cfg["reasoning_effort"] = "minimum"
        # Fast path (native-style backend executor): skip plan middleware unless mid-collab.
        _voice_phase = str(collab_phase or "").strip().lower()
        if _voice_phase in ("", "idle", "done"):
            is_plan_mode = False
            cfg["is_plan_mode"] = False
    auto_thinking_active = (
        session_mode != "flash"
        and not voice_mode
        and (session_mode == "auto" or thinking_type == "auto")
        and thinking_type != "manual"
    )

    # Settings → Models ``thinking.default_mode``:
    # - disabled: force off
    # - enabled: force on (model fixed policy, overrides Auto)
    # - auto: leave session Auto as omit (do not classifier / force on)
    # Voice mode already forced off above — do not let model defaults re-enable thinking.
    if session_mode != "flash" and not voice_mode and thinking_type != "manual":
        _model_name_early = (requested_model_name or "").strip()
        if _model_name_early:
            _mc_early = get_app_config().get_model_config(_model_name_early)
            if _mc_early is not None:
                if not getattr(_mc_early, "supports_thinking", False):
                    thinking_enabled = False
                    reasoning_effort = str(cfg.get("reasoning_effort") or "minimum")
                    auto_thinking_active = False
                    cfg["thinking_enabled"] = False
                else:
                    from evoflow.models.factory import resolve_model_default_thinking_mode

                    _model_thinking_mode = resolve_model_default_thinking_mode(_mc_early)
                    if _model_thinking_mode == "disabled":
                        thinking_enabled = False
                        reasoning_effort = str(cfg.get("reasoning_effort") or "minimum")
                        auto_thinking_active = False
                        thinking_type = "disabled"
                        cfg["thinking_enabled"] = False
                        cfg["thinking_type"] = "disabled"
                    elif _model_thinking_mode == "enabled":
                        thinking_enabled = True
                        auto_thinking_active = False
                        cfg["thinking_enabled"] = True
                        if not thinking_type or thinking_type == "auto":
                            thinking_type = "enabled"
                            cfg["thinking_type"] = "enabled"

    # 未开启 Plan 协作时：任意模式均以 subagent 为主，不把 collab 拉回 planning
    try:
        from evoflow.agents.middlewares.plan_guard_middleware import session_should_sync_plan_scenario_active

        if not session_should_sync_plan_scenario_active(
            session_mode=session_mode,
            collab_phase=collab_phase,
            configurable=cfg if isinstance(cfg, dict) else None,
        ):
            is_plan_mode = False
            cfg["is_plan_mode"] = False
            phase_lc = str(collab_phase or "").strip().lower()
            if phase_lc in ("", "idle"):
                collab_phase = "idle"
                cfg["collab_phase"] = "idle"
    except Exception:
        pass
    # Better prompt_source tagging:
    # - user_request: only when we see explicit user-input markers in config
    # - thread_restore: thread_id exists but no explicit user-input markers (startup restore, polling, etc.)
    # - startup_warmup: no thread_id and no explicit marker
    prompt_source = str(cfg.get("prompt_source") or "").strip() or None
    user_question = _extract_user_question_from_configurable(cfg)
    if not prompt_source:
        user_markers = (
            "evf_user_input_ts_ms",
            "evf_trace_id",
            "user_input_ts_ms",
            "trace_id",
            "user_message",
        )
        has_user_marker = any(k in cfg for k in user_markers)
        if has_user_marker:
            prompt_source = "user_request"
        elif thread_id:
            prompt_source = "thread_restore"
        else:
            prompt_source = "startup_warmup"
    if auto_thinking_active:
        # Session Auto: do not decide on/off or inject vendor thinking kwargs —
        # let the provider apply its own default thinking policy ("不传").
        thinking_enabled = False
        reasoning_effort = None
        thinking_type = "auto"
        cfg["thinking_type"] = "auto"
        cfg["thinking_enabled"] = False
        cfg.pop("reasoning_effort", None)
    cfg["thinking_enabled"] = thinking_enabled
    if reasoning_effort is not None:
        cfg["reasoning_effort"] = reasoning_effort
    elif "reasoning_effort" in cfg and thinking_type == "auto":
        cfg.pop("reasoning_effort", None)
    if thinking_type is not None:
        cfg["thinking_type"] = thinking_type
    _trace_id = str(cfg.get("evf_trace_id") or "").strip() or None
    _tid_for_setup = str(thread_id or "").strip() or None

    def _setup_phase(name: str, t0: float, **extra: Any) -> None:
        if not _tid_for_setup:
            return
        _elapsed_ms = (time.perf_counter() - t0) * 1000.0
        try:
            from evoflow.observability.run_latency_trace import record_run_setup_phase

            record_run_setup_phase(
                _tid_for_setup,
                name,
                _elapsed_ms,
                trace_id=_trace_id,
                **extra,
            )
        except Exception:
            pass
        print(f"[AGENT-TIMING] {name}={_elapsed_ms:.0f}ms", flush=True)

    if thread_id:
        # Flash + non-plan: skip mission_state / scenario disk IO on the hot path
        # so SSE bootstrap (Gateway) + model start aren't blocked by SQLite.
        _flash_fast = session_mode == "flash" and not is_plan_mode
        if not _flash_fast:
            _t0 = time.perf_counter()
            persisted = load_mission_state(thread_id)
            if persisted is not None:
                # 异步分析器关闭时：不把历史 mission_state / intent_hint 注入主模型（避免旧 LLM 推断继续驱动工具与提示）。
                if mission_state is None and MISSION_STATE_ENABLED:
                    mission_state = persisted.model_dump(mode="json")
                    # 场景不由异步分析器驱动；intent_hint 仅来自 scenario() / 请求 context。
            _setup_phase("load_mission_state_ms", _t0)

        _t_pre_setup_ms = (time.perf_counter() - _t3_conf) * 1000.0
        if _t_pre_setup_ms > 20:
            print(f"[AGENT-TIMING] pre_first_setup_phase_ms={_t_pre_setup_ms:.0f}ms", flush=True)
        # scenario() 持久化在 evoflow_chat_sessions.session_mode（按 session_key，v75 后为唯一来源）。
        from evoflow.tools.builtins.scenario_activation import hydrate_activated_scenarios_context_var_from_disk

        _t0 = time.perf_counter()
        if not _flash_fast:
            hydrate_activated_scenarios_context_var_from_disk(thread_id)
            try:
                from evoflow.tools.builtins.scenario_activation import (
                    sync_agent_scenario_after_plan_done,
                    sync_plan_scenario_with_session_policy,
                )

                agent_synced = sync_agent_scenario_after_plan_done(
                    collab_phase=collab_phase,
                    thread_id=thread_id,
                )
                if agent_synced:
                    logger.info(
                        "[ScenarioPolicy] plan done -> synced agent scenario: %s",
                        ",".join(agent_synced),
                    )
                synced = sync_plan_scenario_with_session_policy(
                    session_mode=session_mode or None,
                    collab_phase=collab_phase,
                )
                if synced:
                    logger.info(
                        "[ScenarioPolicy] synced plan scenario for session_mode=%s collab_phase=%s: %s",
                        session_mode or "-",
                        collab_phase or "-",
                        ",".join(synced),
                    )
            except Exception:
                logger.debug("sync plan/agent scenario failed", exc_info=True)
            _setup_phase("hydrate_scenarios_from_disk_ms", _t0)
        else:
            _setup_phase("hydrate_scenarios_from_disk_ms", _t0, skipped="flash")

    agent_config = None
    if not is_bootstrap and agent_name is not None:
        try:
            agent_config = load_agent_config(agent_name)
        except FileNotFoundError:
            # Built-in crew templates may be missing if a prior materialize pass aborted early.
            from evoflow.config.agents_config import materialize_builtin_agent_if_missing

            if materialize_builtin_agent_if_missing(str(agent_name)):
                try:
                    agent_config = load_agent_config(agent_name)
                except FileNotFoundError:
                    agent_config = None
            if agent_config is None and str(agent_name).lower() == "main":
                # Fresh installs often have no backend/.evoflow/agents/main yet; Gateway treats that as optional.
                logger.warning(
                    "Main agent directory not found at %s; using global config.yaml defaults only. Create it from the UI (Agents) or add config.yaml under agents/main.",
                    get_paths().agent_dir("main"),
                )
                agent_config = None
            elif agent_config is None:
                raise FileNotFoundError(
                    f"Agent config not found in database: {agent_name!r}. "
                    "Create the agent in「智能体」or hire a different employee."
                ) from None
    custom_system_prompt = str(agent_config.system_prompt).strip() if agent_config and agent_config.system_prompt else ""
    # Custom agent model or fallback to global/default model resolution
    agent_model_name = agent_config.model if agent_config and agent_config.model else _resolve_model_name()

    # Final model name resolution with request override, then agent config, then global default
    model_name = requested_model_name or agent_model_name

    app_config = get_app_config()
    model_config = app_config.get_model_config(model_name) if model_name else None
    if model_config is None and app_config.models:
        fallback = app_config.primary_model or app_config.models[0].name
        if fallback and fallback != model_name:
            logger.warning(
                "Model %r not found in AppConfig (%d models loaded); fallback to %r",
                model_name,
                len(app_config.models),
                fallback,
            )
            model_name = fallback
            model_config = app_config.get_model_config(model_name)

    if model_config is None:
        raise ValueError(
            "No chat model could be resolved. Add at least one model in Settings → Models "
            f"(primary_model={app_config.primary_model!r}, loaded={[m.name for m in app_config.models]}). "
            "Models are stored in SQLite (evoflow_models). "
            "If the table was cleared, re-add your provider API keys in the UI and restart Gateway."
        )
    if thinking_enabled and not model_config.supports_thinking:
        logger.warning(f"Thinking mode is enabled but model '{model_name}' does not support it; fallback to non-thinking mode.")
        thinking_enabled = False

    if model_config and thinking_enabled:
        from evoflow.models.factory import resolve_effective_reasoning_effort

        reasoning_effort = resolve_effective_reasoning_effort(reasoning_effort, model_config, thinking_enabled=True)
        cfg["reasoning_effort"] = reasoning_effort

    logger.debug(
        "Create Agent(%s) -> session_mode: %s, thinking_enabled: %s, reasoning_effort: %s, model_name: %s, is_plan_mode: %s, subagent_enabled: %s, max_concurrent_subagents: %s, include_search: %s",
        agent_name or "default",
        session_mode or "-",
        thinking_enabled,
        reasoning_effort,
        model_name,
        is_plan_mode,
        subagent_enabled,
        max_concurrent_subagents,
        include_search,
    )

    # Inject run metadata for LangSmith trace tagging
    if "metadata" not in effective_config:
        effective_config["metadata"] = {}

    effective_config["metadata"].update(
        {
            "agent_name": agent_name or "default",
            "model_name": model_name or "default",
            "thinking_enabled": thinking_enabled,
            "reasoning_effort": reasoning_effort,
            "is_plan_mode": is_plan_mode,
            "subagent_enabled": subagent_enabled,
            "include_search": include_search,
            "use_virtual_paths": use_virtual_paths,
        }
    )

    _prompt_language = resolve_prompt_language(cfg.get("prompt_language"))
    cfg["prompt_language"] = _prompt_language

    if is_bootstrap:
        # Special bootstrap agent with minimal prompt for initial custom agent creation flow
        tools = get_available_tools(model_name=model_name, subagent_enabled=subagent_enabled, include_search=include_search, tools_mode=tools_mode)
        all_tools = list(tools)
        _refresh_deferred_registry_from_delta(all_tools, tools)
        all_tool_names = [t.name for t in tools]
        return create_agent(
            model=create_chat_model(name=model_name, thinking_enabled=thinking_enabled),
            tools=tools,
            middleware=_build_middlewares(effective_config, model_name=model_name),
            context_schema=LeadAgentRuntimeContext,
            system_prompt=apply_prompt_template(
                subagent_enabled=subagent_enabled,
                max_concurrent_subagents=max_concurrent_subagents,
                include_subagent_system_prompt=include_subagent_system_prompt,
                custom_system_prompt="",
                available_skills=set(["bootstrap"]),
                loaded_tool_names=[t.name for t in tools],
                all_tool_names=all_tool_names,
                use_virtual_paths=use_virtual_paths,
                local_workspace_root=local_workspace_root,
                intent_hint=intent_hint,
                mission_state=mission_state,
                collab_phase=collab_phase,
                prompt_source=prompt_source,
                user_question=user_question,
                thread_id=(str(thread_id).strip() or None) if thread_id else None,
                prompt_language=_prompt_language,
            ),
            state_schema=ThreadState,
        )

    # Default lead agent — skills are opt-in (missing / null / [] => no skill block in prompt)
    _available_skills = resolve_skill_allowlist_for_lead_prompt(agent_config)
    from evoflow.agents.lead_agent.runtime_context import resolve_preferred_skills_for_turn

    _preferred_skills = resolve_preferred_skills_for_turn(cfg)
    if _preferred_skills:
        _available_skills = merge_skill_allowlist_with_preferred(_available_skills, _preferred_skills)
        logger.info(
            "[Agent Config] merged preferred_skills=%s -> available_skills=%s",
            _preferred_skills,
            sorted(_available_skills),
        )
    _cfg_mcp = agent_config.mcp_servers if agent_config else None
    # Role MCP binding: None = all enabled servers; [] = explicitly no MCP; ["a"] = subset only.
    from evoflow.mcp.binding import warn_if_legacy_mcp_skill_binding_env

    warn_if_legacy_mcp_skill_binding_env()
    _cfg_skills = agent_config.skills if agent_config else None
    logger.debug(f"[Agent Config] skills config: {_cfg_skills}, available_skills: {_available_skills}")

    # Determine available tools from config: None = all, [] = none, ["a","b"] = filtered
    _cfg_tools = agent_config.tools if agent_config else None
    if _cfg_tools is not None:
        from evoflow.tools.tool_aliases import canonical_tool_name

        _tool_whitelist = {
            canonical_tool_name(str(x).strip().lower())
            for x in _cfg_tools
            if str(x or "").strip()
        }
        _tool_whitelist.discard("")
    else:
        _tool_whitelist = None
    logger.debug(f"[Agent Config] tools config: {_cfg_tools}, tool_whitelist: {_tool_whitelist}")

    _t_tools = time.perf_counter()
    tools = get_available_tools(
        model_name=model_name,
        groups=agent_config.tool_groups if agent_config else None,
        subagent_enabled=subagent_enabled,
        include_search=include_search,
        include_mcp=True,
        tools_mode=tools_mode,
    )
    _setup_phase("resolve_available_tools_ms", _t_tools)

    # Apply tool whitelist filter: configurable tools only; session spine always kept.
    if _tool_whitelist is not None:
        from evoflow.tools.tool_aliases import canonical_tool_name
        from evoflow.tools.tool_catalog import is_role_editor_configurable_tool

        tools = [
            t
            for t in tools
            if not is_role_editor_configurable_tool(getattr(t, "name", ""))
            or canonical_tool_name(str(getattr(t, "name", "") or "").strip().lower())
            in _tool_whitelist
        ]
    # Subagent templates persist disallowed_tools; honor them for lead runs too.
    if agent_config and agent_config.disallowed_tools:
        from evoflow.tools.tool_aliases import canonical_tool_name

        blocked = {
            canonical_tool_name(str(x).strip().lower())
            for x in agent_config.disallowed_tools
            if str(x or "").strip()
        }
        blocked.discard("")
        if blocked:
            tools = [
                t
                for t in tools
                if canonical_tool_name(str(getattr(t, "name", "") or "").strip().lower())
                not in blocked
            ]
    # "All tools" baseline should respect whitelist boundary, but not scenario pruning.
    all_tools = list(tools)
    # Dynamic tool profile (two-phase):
    # - bootstrap: first turn uses broader baseline set
    # - scenario: from second turn, use strict scenario-driven set
    # This runs after whitelist so it stays within the user's allowed tool boundary.
    all_tool_names = [t.name for t in tools]
    # Determine phase once and reuse for both tool and prompt selection.
    phase = "scenario"
    try:
        from evoflow.tools.builtins.scenario_activation import get_activated_scenarios

        persisted_scenarios = [str(s).strip() for s in (get_activated_scenarios() or []) if str(s).strip()]
    except Exception:
        persisted_scenarios = []
    from evoflow.agents.lead_agent.intent_tool_profile import (
        resolve_active_scenario_keys_for_display,
        resolve_prompt_scenario_csv,
    )

    effective_scenario_keys = resolve_active_scenario_keys_for_display(
        activated_keys=persisted_scenarios,
        session_mode=session_mode,
    )
    scenario_for_prompt = resolve_prompt_scenario_csv(
        intent_hint=",".join(effective_scenario_keys) if effective_scenario_keys else None,
        local_workspace_root=local_workspace_root,
    )
    activated_scenarios = [s.strip() for s in scenario_for_prompt.split(",") if s.strip()] or ["ask"]
    has_non_chat_activated = any(s and s != "ask" for s in activated_scenarios)
    if not has_non_chat_activated:
        phase = "bootstrap"
    # If plan scenario is active but client didn't set collab_phase, auto-enter planning.
    collab_phase = _maybe_auto_enter_planning_for_plan(
        thread_id=thread_id,
        activated_scenarios=activated_scenarios,
        requested_collab_phase=collab_phase,
    )
    cfg["collab_phase"] = collab_phase
    if session_mode == "ultra" and str(collab_phase or "").strip().lower() in ("", "idle"):
        tools = [t for t in tools if getattr(t, "name", "") != "ask_clarification"]
        all_tools = [t for t in all_tools if getattr(t, "name", "") != "ask_clarification"]
        all_tool_names = [t.name for t in tools]
    _tool_search_enabled = False
    try:
        from evoflow.config.tool_search_config import is_tool_search_enabled

        _tool_search_enabled = bool(is_tool_search_enabled())
    except Exception:
        _tool_search_enabled = False
    if not _tool_search_enabled:
        # Flat binding: agent whitelist ∩ mode (bound ∪ deferred), no tool_search / progressive layer.
        flat_names = {x.strip().lower() for x in flat_bound_tool_names_for_session_mode(session_mode)}
        tools = _filter_tools_by_name_set(tools, keep_names=flat_names)
        all_tools = list(tools)
        logger.debug(
            "[DynamicToolProfile] tool_search=off flat_bind mode=%s selected=%s",
            session_mode,
            [getattr(t, "name", "") for t in tools],
        )
    elif _env_bool("EVOFLOW_DYNAMIC_TOOL_PROFILE_ENABLED", True):
        core_names = {x.strip().lower() for x in CORE_TOOL_NAMES}
        if not has_non_chat_activated:
            tools = _filter_tools_by_name_set(tools, keep_names=core_names)
            logger.debug(
                "[DynamicToolProfile] phase=%s chat_baseline, selected=%s",
                phase,
                [getattr(t, "name", "") for t in tools],
            )
        elif phase == "bootstrap":
            bootstrap_names = {x.strip().lower() for x in BOOTSTRAP_TOOL_NAMES}
            tools = _filter_tools_by_name_set(tools, keep_names=bootstrap_names)
            logger.debug("[DynamicToolProfile] phase=bootstrap, selected=%s", [getattr(t, "name", "") for t in tools])
        else:
            tools = _filter_tools_by_intent(tools, scenario_for_prompt)
            logger.debug(
                "[DynamicToolProfile] phase=scenario, scenarios=%s, selected=%s, eager_only=%s",
                activated_scenarios,
                [getattr(t, "name", "") for t in tools],
                _scenario_eager_tools_enabled(),
            )

    _mcp_system_section = ""
    all_tools = _filter_tools_by_mcp_servers(all_tools, _cfg_mcp)
    tools = _filter_tools_by_mcp_servers(tools, _cfg_mcp)
    if _cfg_mcp is not None:
        tools = _mount_agent_mcp_tools(tools, all_tools, _cfg_mcp)
    mcp_bound = [n for n in (t.name for t in tools) if _mcp_server_from_tool_name(n)]
    if _cfg_mcp != []:
        from evoflow.mcp.native_prompt import build_mcp_native_prompt_section_safe

        _mcp_system_section = build_mcp_native_prompt_section_safe(
            _cfg_mcp,
            bound_tool_names=[t.name for t in tools],
            prompt_language=_prompt_language,
        )
    if _cfg_mcp is not None:
        logger.info(
            "[Agent MCP] role %r native binding servers=%s mounted_mcp_tools=%d",
            agent_name,
            _cfg_mcp,
            len(mcp_bound),
        )

    tools = _strip_mind_map_tools(tools)
    all_tools = _strip_mind_map_tools(all_tools)

    # 小V（xiaomi）：平台管家工具白名单 + 传讯三件套（与 main / 员工工具面分离）。
    try:
        from evoflow.agents.xiaomi.identity import is_xiaomi_agent
        from evoflow.agents.xiaomi.tools import get_xiaomi_tools

        if is_xiaomi_agent(agent_name):
            xiaomi_tools = get_xiaomi_tools()
            # Fixed surface only: no deferred catalog / tool_search spillover from lead tools.
            tools = list(xiaomi_tools)
            all_tools = list(xiaomi_tools)
    except Exception:
        logger.debug("xiaomi tool mount failed", exc_info=True)

    # Progressive loading: tool_search must be on both bound set and ToolNode catalog.
    # Catalog builders / stale caches have historically dropped it while prompts still
    # referenced deferred tools — force-mount when the setting is on (skip xiaomi).
    _is_xiaomi = False
    try:
        from evoflow.agents.xiaomi.identity import is_xiaomi_agent

        _is_xiaomi = bool(is_xiaomi_agent(agent_name))
    except Exception:
        _is_xiaomi = False
    if _tool_search_enabled and not _is_xiaomi:
        tools = _ensure_tool_search_mounted(tools)
        all_tools = _ensure_tool_search_mounted(all_tools)

    all_tool_names = [t.name for t in tools]

    _refresh_deferred_registry_from_delta(all_tools, tools)

    # Per-turn system prompt rebuild (see DynamicSystemPromptOnScenarioMiddleware).
    cfg["evf_dynamic_prompt_meta"] = {
        "all_tool_names": [t.name for t in all_tools],
        "mcp_native": True,
        "mcp_servers": _cfg_mcp,
        "mcp_system_section": _mcp_system_section,
        # Deprecated keys (always native):
        "mcp_skill_mode": False,
        "mcp_skill_section": "",
        "subagent_enabled": subagent_enabled,
        "include_subagent_system_prompt": include_subagent_system_prompt,
        "max_concurrent_subagents": int(max_concurrent_subagents),
        "use_virtual_paths": bool(use_virtual_paths),
        "local_workspace_root": local_workspace_root,
        "agent_name": agent_name,
        "custom_system_prompt": custom_system_prompt,
        "available_skills": sorted(_available_skills),
        "prompt_language": _prompt_language,
    }
    from evoflow.agents.lead_agent.dynamic_prompt_run import bind_dynamic_prompt_meta

    bind_dynamic_prompt_meta(cfg["evf_dynamic_prompt_meta"])
    cfg["evf_user_question"] = user_question
    cfg["evf_prompt_source"] = prompt_source

    csp_hash = hashlib.sha256(custom_system_prompt.encode("utf-8")).hexdigest()[:16] if custom_system_prompt else ""
    try:
        from evoflow.exploration_graph.config import is_exploration_graph_enabled

        _exploration_graph_enabled = is_exploration_graph_enabled()
    except Exception:
        _exploration_graph_enabled = True
    cache_key = LeadAgentGraphCacheKey(
        model_name=str(model_name or ""),
        agent_name=str(agent_name or "main"),
        thinking_enabled=bool(thinking_enabled),
        reasoning_effort=str(reasoning_effort) if reasoning_effort is not None else None,
        session_mode=str(session_mode or ""),
        is_plan_mode=bool(is_plan_mode),
        subagent_enabled=bool(subagent_enabled),
        max_concurrent_subagents=int(max_concurrent_subagents),
        include_search=bool(include_search),
        use_virtual_paths=bool(use_virtual_paths),
        tools_mode=str(tools_mode) if tools_mode is not None else None,
        tool_groups=tuple(sorted(str(g) for g in (agent_config.tool_groups if agent_config else None) or [])),
        tool_whitelist=tuple(sorted(_tool_whitelist)) if _tool_whitelist is not None else tuple(),
        mcp_servers_unrestricted=_cfg_mcp is None,
        mcp_servers=tuple(sorted(str(s) for s in (_cfg_mcp or []))),
        skills=tuple(sorted(_available_skills)),
        custom_system_prompt_hash=csp_hash,
        summarization_enabled=_create_context_compaction_middleware() is not None,
        token_usage_enabled=bool(get_app_config().token_usage.enabled),
        mission_state_middleware=bool(MISSION_STATE_ENABLED),
        is_bootstrap=False,
        activated_scenarios=tuple(sorted(effective_scenario_keys or persisted_scenarios)),
        exploration_graph_enabled=bool(_exploration_graph_enabled),
        tool_search_enabled=bool(_tool_search_enabled),
        has_tool_search_tool=any(
            str(getattr(t, "name", "") or "").strip() == "tool_search" for t in all_tools
        ),
        credentials_fp=_model_credentials_fp(str(model_name or "")),
    )

    def _build_lead_graph() -> Any:
        system_prompt = apply_prompt_template(
            subagent_enabled=subagent_enabled,
            max_concurrent_subagents=max_concurrent_subagents,
            include_subagent_system_prompt=include_subagent_system_prompt,
            agent_name=agent_name,
            custom_system_prompt=custom_system_prompt or None,
            available_skills=_available_skills,
            loaded_tool_names=[t.name for t in tools],
            all_tool_names=all_tool_names,
            use_virtual_paths=use_virtual_paths,
            local_workspace_root=local_workspace_root,
            intent_hint=scenario_for_prompt,
            mission_state=mission_state,
            collab_phase=collab_phase,
            prompt_source=prompt_source,
            user_question=user_question,
            thread_id=(str(thread_id).strip() or None) if thread_id else None,
            prompt_language=_prompt_language,
            session_mode=session_mode or None,
            session_key=str(cfg.get("session_key") or "").strip() or None,
            mcp_skill_section=_mcp_system_section,
            thinking_enabled=bool(thinking_enabled),
            voice_mode=voice_mode,
            principal_id=str(cfg.get("principal_id") or cfg.get("created_by") or "").strip() or None,
            owner_scope_id=str(cfg.get("owner_scope_id") or cfg.get("scope_id") or "").strip() or None,
        )
        return create_agent(
            model=create_chat_model(
                name=model_name,
                thinking_enabled=thinking_enabled,
                reasoning_effort=reasoning_effort,
                thinking_type=thinking_type,
                temperature=_voice_temp if _voice_temp is not None else None,
            ),
            tools=all_tools,
            middleware=_build_middlewares(effective_config, model_name=model_name, agent_name=agent_name),
            context_schema=LeadAgentRuntimeContext,
            system_prompt=system_prompt,
            state_schema=ThreadState,
        )

    _t_graph = time.perf_counter()
    graph, _cached_hit = get_or_build_lead_agent_graph(cache_key, _build_lead_graph)
    _t_graph_ms = (time.perf_counter() - _t_graph) * 1000.0
    print(f"[AGENT-TIMING] graph_get_or_build={_t_graph_ms:.0f}ms cached={_cached_hit}", flush=True)
    _setup_phase(
        "lead_agent_graph_get_or_build_ms",
        _t_graph,
        graph_cache_hit=bool(_cached_hit),
    )

    _t_entry_total_ms = (time.perf_counter() - _t_entry_agent) * 1000.0
    print(f"[AGENT-TIMING] make_lead_agent_total={_t_entry_total_ms:.0f}ms cached={_cached_hit}", flush=True)
    try:
        from evoflow.observability.run_latency_trace import write_run_latency_event as _rl_exit

        if _tid0:
            _rl_exit(
                _tid0,
                "make_lead_agent_exit",
                {
                    "make_lead_agent_total_ms": round(_t_entry_total_ms, 2),
                    "graph_cache_hit": bool(_cached_hit),
                },
                trace_id=_tr0,
            )
    except Exception:
        pass
    try:
        from evoflow.observability.lg_blind_span_patch import wrap_compiled_graph_for_blind_span

        graph = wrap_compiled_graph_for_blind_span(graph, thread_id=_tid0 or "", trace_id=_tr0)
    except Exception:
        pass
    return graph
