import logging
import os
import re
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from evoflow.agents.content_scanner import scan_content
from evoflow.agents.lead_agent.intent_tool_profile import (
    TASK_SCENARIO_PROFILES,
    format_active_modes_for_display,
    normalize_scenario_key,
    resolve_active_scenario_keys_for_display,
    resolve_prompt_scenario_csv,
)
from evoflow.agents.lead_agent.prompt_blocks import get_static_blocks
from evoflow.agents.lead_agent.prompt_dynamic import get_prompt_dynamic
from evoflow.agents.lead_agent.prompt_language import resolve_prompt_language
from evoflow.collab.models import CollabPhase
from evoflow.config.agents_config import load_agent_soul
from evoflow.config.paths import get_paths
from evoflow.skills import load_skills

logger = logging.getLogger(__name__)


def _env_bool(name: str, default: bool) -> bool:
    raw = (os.getenv(name) or "").strip().lower()
    if not raw:
        return default
    return raw in {"1", "true", "yes", "on"}


def format_runtime_now_for_prompt(dt: datetime | None = None, *, prompt_language: str | None = None) -> str:
    """Format local time for prompt display, including weekday and timezone offset."""
    if dt is None:
        dt = datetime.now().astimezone()
    if dt.tzinfo is None:
        # Best-effort: assume local timezone when tzinfo is missing
        dt = dt.replace(tzinfo=timezone(timedelta(0))).astimezone()

    # Monday=0 ... Sunday=6
    dyn = get_prompt_dynamic(prompt_language)
    weekday_zh = dyn.WEEKDAY_NAMES[dt.weekday()]

    offset = dt.utcoffset() or timedelta(0)
    total_minutes = int(offset.total_seconds() // 60)
    sign = "+" if total_minutes >= 0 else "-"
    total_minutes = abs(total_minutes)
    hh = total_minutes // 60
    mm = total_minutes % 60
    utc_part = f"UTC{sign}{hh:02d}:{mm:02d}"

    base = dt.strftime("%Y-%m-%d")
    return f"{base} {weekday_zh} ({utc_part})"


def _normalize_intent(intent_hint: str | None) -> str:
    # Backward compatible wrapper — prompt side uses scenario key.
    # Supports comma-separated multi-scenario (e.g., "plan,web").
    if not intent_hint:
        return "ask"
    if "," in intent_hint:
        parts = [normalize_scenario_key(x.strip()) for x in intent_hint.split(",") if x.strip()]
        # Deduplicate while preserving order
        seen = set()
        unique = []
        for p in parts:
            if p not in seen:
                seen.add(p)
                unique.append(p)
        return ",".join(unique) if unique else "ask"
    return normalize_scenario_key(intent_hint)


def _remove_xml_block(prompt: str, tag: str) -> str:
    pattern = re.compile(rf"<{tag}>[\s\S]*?</{tag}>\n*", re.IGNORECASE)
    return pattern.sub("", prompt)


# Shared module set for scenarios that need execution/orchestration policy.
# Keep as a named constant to avoid duplicated literal lists.
_TASK_ORCHESTRATION_MODULES = ["task_orchestration"]


_SCENARIO_PROFILE: dict[str, dict[str, list[str]]] = {
    # 默认对话：弱化复杂编排与治理
    "ask": {"remove": [], "modules": ["chat"]},
    # 规划与调度：先 plan 门禁再 supervisor（避免模型把「执行」口语理解成立即建任务）
    "plan": {"remove": [], "modules": [*_TASK_ORCHESTRATION_MODULES, "planning"]},
    # 文件操作 + 联网检索（不含 task_orchestration/plan 块；委派见 evoflow-subagent-delegation 技能）
    "agent": {"remove": [], "modules": []},
}


def _active_scenario_keys(scenario: str) -> set[str]:
    return {s.strip() for s in (scenario or "").split(",") if s.strip()} or {"ask"}


def _plan_collab_prompt_active(*, scenario: str, collab_phase: str | None) -> bool:
    """True when plan scenario is active or collab state is in the plan pipeline (not idle)."""
    if "plan" in _active_scenario_keys(scenario):
        return True
    phase = str(collab_phase or "").strip().lower()
    return bool(phase) and phase not in {"idle", "(unset)"}


def _is_pure_chat_modules(modules: list[str]) -> bool:
    """True when only the lightweight ``chat`` prompt module is active (no plan/file/web/… modules)."""
    return modules == ["chat"]


def _use_compact_tool_catalog(scenario: str) -> bool:
    """Omit deferred-tool name lists for everyday chat and workspace-only sessions."""
    if _is_pure_chat_modules(_enabled_modules_for_scenario(scenario)):
        return True
    keys = [s.strip() for s in scenario.split(",") if s.strip()]
    return keys == ["agent"]


def _enabled_modules_for_scenario(scenario: str) -> list[str]:
    """Get enabled prompt modules for a scenario (supports comma-separated multi-scenario).

    When multiple scenarios are active, their modules are unioned (deduplicated).
    """
    keys = [s.strip() for s in scenario.split(",") if s.strip()]
    seen: set[str] = set()
    result: list[str] = []
    for key in keys:
        profile = _SCENARIO_PROFILE.get(key)
        if not profile:
            continue
        for m in profile.get("modules", []):
            if m not in seen:
                seen.add(m)
                result.append(m)
    return result or _SCENARIO_PROFILE["ask"]["modules"]


def _active_modes_display_text(active_keys: list[str]) -> str:
    """Human-readable Ask / Agent / Plan line for ``<session_mode_policy>``."""
    return format_active_modes_for_display(active_keys)


def _build_intent_modules_section(intent: str, *, prompt_language: str | None = None) -> str:
    # IMPORTANT: This section is for debugging only.
    # Business modules should be reflected by *which prompt blocks are included*,
    # not by adding explanatory text into the system prompt.
    if not _env_bool("EVOFLOW_PROMPT_DEBUG_SECTIONS", False):
        return ""
    dyn = get_prompt_dynamic(prompt_language)
    profile = _SCENARIO_PROFILE.get(intent, _SCENARIO_PROFILE["plan"])
    zh = TASK_SCENARIO_PROFILES.get(intent).zh_description if intent in TASK_SCENARIO_PROFILES else ""
    lines = [
        "<intent_modules>",
        f"- {dyn.INTENT_DEBUG_SCENARIO_LABEL}: {intent}",
        (f"- {dyn.INTENT_DEBUG_DESC_LABEL}: {zh}" if zh else f"- {dyn.INTENT_DEBUG_DESC_LABEL}: (none)"),
        f"- {dyn.INTENT_DEBUG_MODULES_LABEL}: {', '.join(profile.get('modules', []))}",
        "</intent_modules>",
    ]
    return "\n".join(lines)


def _build_mission_state_section(
    mission_state: dict | None,
    *,
    prompt_language: str | None = None,
    thread_id: str | None = None,
) -> str:
    """Build the ``<mission_state>`` system-prompt block.

    Info fields (primary_objective, subproblems, exploration_*, task_type, etc.)
    have been migrated to the session mind map (``<session_mind_map>``).  This
    function now only renders working-memory file tracking + exploration budget
    hints — everything else is covered by the mind map graph.
    """
    try:
        from evoflow.agents.mission_state.config import MISSION_STATE_PROMPT_INJECTION_ENABLED

        if not MISSION_STATE_PROMPT_INJECTION_ENABLED:
            return ""
    except Exception:
        return ""

    tid = str(thread_id or "").strip()
    files_block = ""
    if tid:
        try:
            from evoflow.context.working_memory import format_files_already_read_section, format_files_modified_section
            parts: list[str] = []
            modified = format_files_modified_section(tid)
            if modified:
                parts.append(modified)
            already_read = format_files_already_read_section(tid)
            if already_read:
                parts.append(already_read)
            files_block = "\n".join(parts)
        except Exception:
            pass

    if not files_block:
        return ""

    dyn = get_prompt_dynamic(prompt_language)
    lines = [
        "<mission_state>",
        dyn.MISSION_STATE_INTRO,
        files_block,
    ]

    try:
        from evoflow.exploration.exploration_budget import format_exploration_hint

        hint = format_exploration_hint(tid)
        if hint:
            lines.append(hint)
    except Exception:
        pass

    lines.append("</mission_state>")
    return "\n".join(lines)


def _normalize_tool_name_list(names: list[str] | None) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for n in names or []:
        s = str(n or "").strip()
        if not s or s in seen:
            continue
        seen.add(s)
        out.append(s)
    return out


def _session_key_for_prompt(
    thread_id: str | None,
    session_key: str | None = None,
) -> str | None:
    sk = str(session_key or "").strip()
    if sk:
        return sk
    tid = str(thread_id or "").strip()
    if not tid:
        return None
    try:
        from evoflow.persistence.session_repositories import find_session_key_by_thread_id

        return find_session_key_by_thread_id(tid)
    except Exception:
        return None


def resolve_pending_tools_for_prompt(
    *,
    session_key: str | None = None,
    active_scenarios: list[str] | None = None,
    loaded_tool_names: list[str] | None = None,
    loaded_deferred: list[str] | None = None,
) -> list[str]:
    """Deferred tools still needing ``tool_search`` — excludes eager-bound and already-loaded names."""
    loaded_names = _normalize_tool_name_list(loaded_tool_names)
    loaded_set = {n.lower() for n in loaded_names}
    deferred_loaded = {str(n or "").strip().lower() for n in (loaded_deferred or []) if str(n or "").strip()}

    sk = str(session_key or "").strip()
    if sk:
        try:
            from evoflow.session_tool_binding.agent_tools import pending_activation_for_session_agent
            from evoflow.session_tool_binding.service import (
                resolve_current_binding_mode,
                resolve_runtime_tool_mode,
            )

            if active_scenarios is not None:
                mode = resolve_runtime_tool_mode(sk, active_scenarios)
            else:
                mode = resolve_current_binding_mode(sk, None)
            pending = pending_activation_for_session_agent(
                sk,
                mode,
                loaded_deferred=list(loaded_deferred or []),
            )
            return [n for n in pending if n not in loaded_set]
        except Exception:
            logger.debug("resolve_pending_tools_for_prompt: session lookup failed", exc_info=True)

    if active_scenarios:
        try:
            from evoflow.agents.lead_agent.intent_tool_profile import resolve_deferred_tool_names_for_scenarios

            pending = resolve_deferred_tool_names_for_scenarios(active_scenarios)
            return [
                n
                for n in pending
                if str(n).strip().lower() not in loaded_set and str(n).strip().lower() not in deferred_loaded
            ]
        except Exception:
            logger.debug("resolve_pending_tools_for_prompt: scenario fallback failed", exc_info=True)

    return []


def _build_tool_catalog_section(
    loaded_tool_names: list[str] | None,
    all_tool_names: list[str] | None = None,
    *,
    prompt_language: str | None = None,
    compact: bool = False,
    session_key: str | None = None,
    active_scenarios: list[str] | None = None,
    loaded_deferred: list[str] | None = None,
) -> str:
    del all_tool_names  # kept for API compatibility; pending list is deferred-only

    loaded_names = _normalize_tool_name_list(loaded_tool_names)
    tool_search_bound = "tool_search" in {n.strip().lower() for n in loaded_names}

    not_bound_sorted = resolve_pending_tools_for_prompt(
        session_key=session_key,
        active_scenarios=active_scenarios,
        loaded_tool_names=loaded_names,
        loaded_deferred=loaded_deferred,
    )

    # Never instruct the model to call tool_search when the tool is not actually bound.
    if not tool_search_bound:
        return ""

    deferred_section = get_deferred_tools_prompt_section(pending_names=not_bound_sorted)

    dyn = get_prompt_dynamic(prompt_language)
    if compact:
        not_bound_line = dyn.TOOL_CATALOG_NOT_BOUND_COMPACT.format(n=len(not_bound_sorted))
    else:
        pending = ", ".join(not_bound_sorted) if not_bound_sorted else "(none)"
        not_bound_line = dyn.TOOL_CATALOG_NOT_BOUND.format(n=len(not_bound_sorted), pending=pending)
    lines = [
        "<tool_catalog>",
        "<tools_not_in_request>",
        not_bound_line,
        "</tools_not_in_request>",
        "<loading_rule>",
        f"- {dyn.TOOL_CATALOG_RULE_SCHEMA}",
        f"- {dyn.TOOL_CATALOG_RULE_ACTIVATION_POINTER}",
        f"- {dyn.TOOL_CATALOG_DEFERRED_HINT}",
        "</loading_rule>",
        "</tool_catalog>",
    ]
    if deferred_section.strip():
        lines.append(deferred_section.strip())
    return "\n".join(lines)


def _fmt_with_agent_name(text: str, agent_name: str) -> str:
    return text.replace("{agent_name}", agent_name)


def _build_plan_workflow_section(
    agent_name: str,
    *,
    scenario: str,
    collab_phase: str | None,
    prompt_language: str | None = None,
) -> str:
    """Full ``<plan_workflow>`` process block — required so the model knows the end-to-end loop."""
    if not _plan_collab_prompt_active(scenario=scenario, collab_phase=collab_phase):
        return ""
    from evoflow.agents.lead_agent.plan_prompt_blocks import format_plan_workflow_system_block

    modules = _enabled_modules_for_scenario(scenario)
    include_clarification = "planning" in modules or "plan" in _active_scenario_keys(scenario)
    return format_plan_workflow_system_block(
        agent_name,
        include_clarification=include_clarification,
        prompt_language=prompt_language,
    )


def _build_plan_runtime_stage_section(
    collab_phase: str | None,
    thread_id: str | None,
    *,
    scenario: str,
    prompt_language: str | None = None,
) -> str:
    """Dynamic block: plan/collab pipeline hint — only when plan scenario or non-idle collab phase."""
    if not _plan_collab_prompt_active(scenario=scenario, collab_phase=collab_phase):
        return ""
    phase = str(collab_phase or "").strip() or "(unset)"
    lines = [
        "<plan_runtime_stage>",
        f"collab_phase={phase}",
    ]
    tid = str(thread_id or "").strip()
    if tid:
        lines.append(f"thread_id={tid}")
        try:
            from evoflow.collab.thread_collab import load_thread_collab_state
            from evoflow.config.paths import get_paths

            st = load_thread_collab_state(get_paths(), tid)
            bid = str(getattr(st, "bound_task_id", "") or "").strip()
            if bid:
                lines.append(f"bound_task_id={bid}")
            sc = getattr(st, "activated_scenarios", None) or []
            if isinstance(sc, list) and sc:
                shown = [str(x).strip() for x in sc if str(x).strip()]
                if shown:
                    lines.append("activated_scenarios=" + ",".join(shown))
        except Exception:
            logger.debug("plan_runtime_stage: load_thread_collab_state failed", exc_info=True)
    dyn = get_prompt_dynamic(prompt_language)
    lines.append(dyn.PLAN_RUNTIME_NOTE)
    lines.append("</plan_runtime_stage>")
    return "\n".join(lines)


def _build_collab_phase_guard_section(collab_phase: str | None, *, prompt_language: str | None = None) -> str:
    phase = str(collab_phase or "").strip().lower()
    if not phase:
        return ""
    dyn = get_prompt_dynamic(prompt_language)
    if phase in {CollabPhase.PLANNING.value, CollabPhase.PLAN_READY.value, CollabPhase.AWAITING_EXEC.value}:
        return dyn.PHASE_GUARD_PLANNING
    if phase == CollabPhase.EXECUTING.value:
        return dyn.PHASE_GUARD_EXECUTING
    if phase == CollabPhase.VERIFYING.value:
        return dyn.PHASE_GUARD_VERIFYING
    if phase == CollabPhase.REFLECTING.value:
        return dyn.PHASE_GUARD_REFLECTING
    return ""


_COLLAB_PLAN_IN_PROMPT_MAX_CHARS = 60_000

# Appended every model call by ``CollabThreadLiveContextFooterMiddleware`` (after static system assembly).
LIVE_COLLAB_META_BEGIN = "<evoflow_live_collab_meta>"
LIVE_COLLAB_META_END = "</evoflow_live_collab_meta>"
LIVE_COLLAB_PLAN_BEGIN = "<evoflow_live_committed_plan>"
LIVE_COLLAB_PLAN_END = "</evoflow_live_committed_plan>"


def strip_thread_live_context_from_system_prompt(text: str) -> str:
    """Remove prior per-turn live blocks so we never duplicate after summarization or multi-hop turns."""
    import re

    out = str(text or "")
    for begin, end in (
        (LIVE_COLLAB_META_BEGIN, LIVE_COLLAB_META_END),
        (LIVE_COLLAB_PLAN_BEGIN, LIVE_COLLAB_PLAN_END),
    ):
        pat = re.escape(begin) + r".*?" + re.escape(end) + r"\s*"
        out = re.sub(pat, "\n", out, flags=re.DOTALL)
    return out.rstrip()


def strip_mission_state_from_system_prompt(text: str) -> str:
    """Remove stale ``<mission_state>`` blocks before live footer re-injection."""
    import re

    out = re.sub(r"<mission_state>[\s\S]*?</mission_state>\s*", "\n", str(text or ""), flags=re.IGNORECASE)
    return re.sub(r"\n{3,}", "\n\n", out).rstrip()


def strip_workspace_runtime_from_system_prompt(text: str) -> str:
    """Remove stale ``<workspace>`` runtime block before live footer re-injection."""
    import re

    out = re.sub(r"<workspace>[\s\S]*?</workspace>\s*", "\n", str(text or ""), flags=re.IGNORECASE)
    return re.sub(r"\n{3,}", "\n\n", out).rstrip()


def build_workspace_runtime_section(
    *,
    local_workspace_root: str | None,
    use_virtual_paths: bool = False,
    prompt_language: str | None = None,
    intent_hint: str | None = None,
) -> str:
    """Stable ``<workspace>`` block (path, OS, shell). Live clock is upserted by middleware."""
    lang = resolve_prompt_language(prompt_language)
    dyn = get_prompt_dynamic(lang)
    static = get_static_blocks(lang)
    scenario = resolve_prompt_scenario_csv(intent_hint=intent_hint, local_workspace_root=local_workspace_root)
    pure_chat = _is_pure_chat_modules(_enabled_modules_for_scenario(scenario))
    tpl = static.WORKSPACE_BLOCK_COMPACT_TEMPLATE if pure_chat else static.WORKSPACE_BLOCK_TEMPLATE
    return tpl.format(
        workspace_root_hint=_resolve_workspace_root(local_workspace_root),
        runtime_os=_runtime_os_label(),
        runtime_shell=_runtime_shell_label(prompt_language=lang),
        runtime_host_hint=dyn.RUNTIME_HOST_HINT_VIRTUAL if use_virtual_paths else "",
    ).strip()


def build_runtime_clock_section(*, prompt_language: str | None = None) -> str:
    """Short clock line for system ``<workspace>`` (no XML wrapper)."""
    lang = resolve_prompt_language(prompt_language)
    now = format_runtime_now_for_prompt(prompt_language=lang)
    if str(lang or "").lower().startswith("zh"):
        return f"时间: {now}"
    return f"Time: {now}"


_COLLAB_FP_CACHE: dict[str, tuple[float, str]] = {}
_COLLAB_FP_CACHE_LOCK = threading.Lock()
_COLLAB_FP_TTL_SEC = float(os.getenv("EVOFLOW_COLLAB_FP_TTL_SEC", "2") or "2")


def collab_runtime_state_fingerprint(thread_id: str | None) -> str:
    """Short signature for dynamic system prompt rebuilds when plan or subtasks change."""
    tid = str(thread_id or "").strip()
    if not tid:
        return ""
    now = time.perf_counter()
    with _COLLAB_FP_CACHE_LOCK:
        hit = _COLLAB_FP_CACHE.get(tid)
        if hit is not None and (now - hit[0]) < _COLLAB_FP_TTL_SEC:
            return hit[1]
    parts: list[str] = []
    try:
        from evoflow.agents.mission_state.config import MISSION_STATE_ENABLED
        from evoflow.agents.mission_state.storage import load_mission_state

        if MISSION_STATE_ENABLED:
            ms = load_mission_state(tid)
            if ms is not None:
                parts.append(f"ms_ts={int(getattr(ms, 'bound_plan_ts_ms', 0) or 0)}")
                parts.append(f"ms_plan={bool(getattr(ms, 'plan_goal', '') or '')}")
    except Exception:
        parts.append("ms_err")
    try:
        from evoflow.collab.task_progress_snapshot import build_task_progress_snapshot
        from evoflow.config.paths import get_paths

        snap = build_task_progress_snapshot(get_paths(), tid)
        parts.append(f"cp={snap.get('collab_phase')}")
        parts.append(f"bt={snap.get('bound_task_id')}")
        mt = snap.get("main_task")
        if isinstance(mt, dict) and mt.get("taskId"):
            parts.append(f"m={mt.get('taskId')}|{mt.get('status')}|{mt.get('progress')}|{mt.get('bound_plan_ts_ms', 0)}|auth={mt.get('executionAuthorized')}")
        for st in sorted((snap.get("subtasks") or []), key=lambda x: str((x or {}).get("subtaskId") or "")):
            if isinstance(st, dict):
                mem = st.get("memory") if isinstance(st.get("memory"), dict) else {}
                osum = str(mem.get("output_summary") or "")[:80]
                parts.append(f"s={st.get('subtaskId')}|{st.get('status')}|{st.get('progress')}|{osum!r}")
    except Exception:
        parts.append("snap_err")
    out = "|".join(parts)
    with _COLLAB_FP_CACHE_LOCK:
        _COLLAB_FP_CACHE[tid] = (now, out)
        if len(_COLLAB_FP_CACHE) > 256:
            oldest = min(_COLLAB_FP_CACHE.items(), key=lambda item: item[1][0])[0]
            _COLLAB_FP_CACHE.pop(oldest, None)
    return out


def build_thread_live_context_appendix(thread_id: str | None, *, prompt_language: str | None = None) -> str:
    """Per-turn disk snapshot for plan/collab monitoring — **not** part of static system assembly.

    Injected by ``CollabThreadLiveContextFooterMiddleware`` as an ephemeral ``HumanMessage``
    (``name=session_collab_live``) at the tail of each model payload, same pattern as
    ``<session_mind_map>``, so summarization of chat history cannot drop this context.
    """
    tid = str(thread_id or "").strip()
    if not tid:
        return ""
    plan_body = ""

    snap: dict | None = None
    try:
        from evoflow.collab.task_progress_snapshot import build_task_progress_snapshot
        from evoflow.config.paths import get_paths

        snap = build_task_progress_snapshot(get_paths(), tid)
    except Exception:
        snap = None

    if not plan_body and isinstance(snap, dict):
        bid = str(snap.get("bound_task_id") or "").strip()
        mt = snap.get("main_task") if isinstance(snap.get("main_task"), dict) else None
        mid = str((mt or {}).get("taskId") or "").strip()
        try:
            from evoflow.collab.plan_task_storage import format_plan_for_prompt, task_has_bound_plan
            from evoflow.collab.storage import find_main_task, get_project_storage

            storage = get_project_storage()
            row = None
            if bid:
                row = find_main_task(storage, bid)
            if row is None and mid:
                row = find_main_task(storage, mid)
            if row is not None:
                _proj, task = row
                bt = str(task.get("thread_id") or "").strip()
                if (not bt or bt == tid) and task_has_bound_plan(task):
                    plan_body = format_plan_for_prompt(task)
        except Exception:
            pass

    dyn = get_prompt_dynamic(prompt_language)
    meta_lines: list[str] = [
        dyn.LIVE_COLLAB_INTRO,
        f"thread_id={tid!r}",
    ]
    has_snap = isinstance(snap, dict)
    if has_snap:
        inf = snap.get("collab_phase_inference")
        meta_lines.append(f"collab_phase={snap.get('collab_phase')!r} collab_phase_disk={snap.get('collab_phase_disk')!r} inference={inf!r} bound_task_id={snap.get('bound_task_id')!r}")
        steps = snap.get("supervisor_steps") or []
        if isinstance(steps, list):
            meta_lines.append(f"supervisor_steps_persisted_count={len(steps)}")
        main = snap.get("main_task")
        subs = snap.get("subtasks") or []
        if isinstance(main, dict) and main.get("taskId"):
            meta_lines.append(
                "main_task: "
                f"id={main.get('taskId')} name={main.get('name')!r} "
                f"status={main.get('status')!r} progress={main.get('progress')} "
                f"execution_authorized={main.get('executionAuthorized')} "
                f"updated_at={main.get('updatedAt')!r} bound_plan_ts_ms={main.get('bound_plan_ts_ms', 0)}"
            )
        elif subs:
            meta_lines.append(dyn.LIVE_COLLAB_NO_MAIN)
        for st in subs[:96]:
            if not isinstance(st, dict):
                continue
            mem = st.get("memory") if isinstance(st.get("memory"), dict) else {}
            step = str(mem.get("current_step") or "").strip()
            osum = str(mem.get("output_summary") or "").strip()
            mem_hint = ""
            if step or osum:
                mem_hint = f" memory_step={step[:160]!r} memory_summary={osum[:260]!r}"
            meta_lines.append(f"- subtask id={st.get('subtaskId')} name={st.get('name')!r} status={st.get('status')!r} progress={st.get('progress')} agent={st.get('assignedAgent')!r}{mem_hint}")
    if not has_snap and not plan_body:
        return ""

    out_parts: list[str] = []
    if has_snap or plan_body:
        out_parts.append(LIVE_COLLAB_META_BEGIN)
        out_parts.extend(meta_lines)
        out_parts.append(LIVE_COLLAB_META_END)

    if plan_body:
        truncated = False
        body = plan_body
        if len(body) > _COLLAB_PLAN_IN_PROMPT_MAX_CHARS:
            body = body[:_COLLAB_PLAN_IN_PROMPT_MAX_CHARS]
            truncated = True
        note = dyn.COMMITTED_PLAN_NOTE + (dyn.COMMITTED_PLAN_TRUNCATED if truncated else "")
        plan_chunk = "\n".join(
            [
                "<committed_plan>",
                note,
                body,
                "</committed_plan>",
            ]
        )
        out_parts.append(LIVE_COLLAB_PLAN_BEGIN)
        out_parts.append(plan_chunk)
        out_parts.append(LIVE_COLLAB_PLAN_END)

    if not out_parts:
        return ""
    return "\n".join(out_parts)


def _is_xiaomi_lead_run(agent_name: str | None) -> bool:
    """True only for the dedicated 小V agent (``xiaomi``), never default ``main``."""
    try:
        from evoflow.agents.xiaomi.identity import is_xiaomi_agent

        return is_xiaomi_agent(agent_name)
    except Exception:
        return str(agent_name or "").strip().lower() in {"xiaomi", "小v", "小蜜", "xiaov"}


def _assemble_system_prompt(
    *,
    scenario: str,
    agent_name: str,
    soul: str,
    custom_system_prompt: str = "",
    memory_context: str,
    workspace_memory_context: str,
    person_memory_context: str = "",
    mission_state_section: str,
    tool_catalog_section: str,
    skills_section: str,
    mcp_skill_section: str = "",
    subagent_section: str,
    trae_section: str,
    worker_guidance_section: str,
    task_router_section: str,
    knowledge_map_section: str = "",
    acp_section: str,
    workspace_root_hint: str,
    runtime_mode: str,
    runtime_os: str,
    runtime_shell: str,
    runtime_now: str,
    runtime_host_hint: str,
    collab_phase_section: str,
    plan_workflow_section: str = "",
    plan_runtime_stage_section: str,
    active_scenario_keys: list[str],
    subagent_enabled: bool,
    bootstrap_mode: bool,
    prompt_language: str | None = None,
    subagent_focus_mode: bool = False,
    thinking_enabled: bool = False,
    voice_mode: bool = False,
    mind_map_prompt_enabled: bool = False,
    xiaomi_mode: bool = False,
    xiaomi_page_context: dict | None = None,
) -> str:
    modules = _enabled_modules_for_scenario(scenario)
    pure_chat = _is_pure_chat_modules(modules)
    static = get_static_blocks(prompt_language)

    blocks: list[str] = []

    if xiaomi_mode:
        # Platform steward: dedicated lean prompt — do not stack engineer lead blocks.
        # No tool_catalog / tool_search / deferred loading — fixed xiaomi_* tool surface only.
        # Page snapshot is NOT in system (cache bust); XiaomiUiContextLiveFooterMiddleware
        # appends it as ephemeral HumanMessage name=xiaomi_ui_context when the panel sends it.
        from evoflow.agents.xiaomi.prompt import policy_block, role_block

        blocks.append(role_block(prompt_language=prompt_language))
        blocks.append(policy_block(prompt_language=prompt_language))
        if soul.strip():
            blocks.append(scan_content(soul.strip(), source="soul"))
        dyn = get_prompt_dynamic(prompt_language)
        extra = (custom_system_prompt or "").strip()
        if extra:
            safe_extra = scan_content(extra, source="custom_system_prompt")
            blocks.append(
                f"<agent_system_prompt>\n{dyn.AGENT_CUSTOM_PROMPT_WRAPPER}\n\n{safe_extra}\n</agent_system_prompt>"
            )
        if memory_context.strip():
            safe_mem = scan_content(memory_context.strip(), source="memory_context").strip()
            if safe_mem:
                blocks.append(f"<!-- memory: reference only -->\n{safe_mem}")
        if person_memory_context.strip():
            safe_pm = scan_content(person_memory_context.strip(), source="person_memory_context").strip()
            if safe_pm:
                blocks.append(
                    "<!-- █ PERSON MEMORY — YOUR autobiography; read first, cite when relevant; "
                    "never confuse with user <memory> █ -->\n"
                    f"{safe_pm}\n"
                    "<!-- █ END PERSON MEMORY █ -->"
                )
        return "\n\n".join([b for b in blocks if b]).strip() + "\n"

    blocks.append(
        _fmt_with_agent_name(static.ROLE_BLOCK_CHAT_TEMPLATE.strip(), agent_name)
    )
    blocks.append(
        (static.COMMUNICATION_STYLE_COMPACT_BLOCK if pure_chat else static.COMMUNICATION_STYLE_BLOCK).strip()
    )
    blocks.append(
        (static.ENTITY_ASSETS_COMPACT_BLOCK if pure_chat else static.ENTITY_ASSETS_BLOCK).strip()
    )
    # TOOL_CALLING_BLOCK：不再注入；工具 schema / 模型能力已够用。

    if thinking_enabled:
        blocks.append(static.THINKING_POLICY_BLOCK.strip())

    if voice_mode and static.VOICE_MODE_BLOCK:
        blocks.append(static.VOICE_MODE_BLOCK.strip())

    if knowledge_map_section.strip():
        blocks.append(knowledge_map_section.strip())

    intent_modules_section = _build_intent_modules_section(scenario, prompt_language=prompt_language)
    if intent_modules_section.strip():
        blocks.append(intent_modules_section.strip())

    if plan_workflow_section.strip():
        blocks.append(plan_workflow_section.strip())

    if collab_phase_section.strip():
        blocks.append(collab_phase_section.strip())
    # session_mode_policy：暂不注入系统提示（模式由 UI 决定，模型无需知道）
    # mode_policy_block = _fmt_with_agent_name(static.SESSION_MODE_POLICY_BLOCK.strip(), agent_name).replace(
    #     "{active_modes}",
    #     _active_modes_display_text(active_scenario_keys),
    # )
    # blocks.append(mode_policy_block)
    if tool_catalog_section.strip():
        blocks.append(tool_catalog_section.strip())
    if worker_guidance_section.strip():
        blocks.append(worker_guidance_section.strip())
    if task_router_section.strip():
        blocks.append(task_router_section.strip())

    if soul.strip():
        blocks.append(scan_content(soul.strip(), source="soul"))
    dyn = get_prompt_dynamic(prompt_language)
    extra = (custom_system_prompt or "").strip()
    if extra:
        safe_extra = scan_content(extra, source="custom_system_prompt")
        blocks.append(f"<agent_system_prompt>\n{dyn.AGENT_CUSTOM_PROMPT_WRAPPER}\n\n{safe_extra}\n</agent_system_prompt>")

    if plan_runtime_stage_section.strip():
        blocks.append(plan_runtime_stage_section.strip())

    if subagent_section.strip():
        blocks.append(subagent_section.strip())

    if skills_section.strip():
        blocks.append(skills_section.strip())

    if mcp_skill_section.strip():
        blocks.append(mcp_skill_section.strip())

    if "trae_window" in modules and trae_section.strip():
        blocks.append(trae_section.strip())

    if pure_chat:
        blocks.append(
            static.WORKSPACE_BLOCK_COMPACT_TEMPLATE.format(
                workspace_root_hint=workspace_root_hint,
                runtime_os=runtime_os,
                runtime_shell=runtime_shell,
                runtime_host_hint=runtime_host_hint,
            ).strip()
        )
    else:
        blocks.append(
            static.WORKSPACE_BLOCK_TEMPLATE.format(
                workspace_root_hint=workspace_root_hint,
                runtime_os=runtime_os,
                runtime_shell=runtime_shell,
                runtime_host_hint=runtime_host_hint,
            ).strip()
        )

    if memory_context.strip():
        safe_mem = scan_content(memory_context.strip(), source="memory_context").strip()
        if safe_mem:
            blocks.append(f"<!-- memory: reference only -->\n{safe_mem}")

    if person_memory_context.strip():
        safe_pm = scan_content(person_memory_context.strip(), source="person_memory_context").strip()
        if safe_pm:
            blocks.append(
                "<!-- █ PERSON MEMORY — YOUR autobiography; read first, cite when relevant; "
                "never confuse with user <memory> █ -->\n"
                f"{safe_pm}\n"
                "<!-- █ END PERSON MEMORY █ -->"
            )

    if mission_state_section.strip():
        blocks.append(mission_state_section.strip())

    blocks.append(
        _resolve_context_priority_block(
            static,
            include_mind_map=bool(mind_map_prompt_enabled),
            prompt_language=prompt_language,
        )
    )

    # Final join with blank lines
    return "\n\n".join([b for b in blocks if b]).strip() + "\n"


def _prompt_logs_repo_root() -> Path:
    """Harness lives at backend/packages/harness/evoflow/... → repo root is parents[6]."""
    return Path(__file__).resolve().parents[6]


def _runtime_os_label() -> str:
    if sys.platform == "win32":
        return "Windows (win32)"
    if sys.platform == "darwin":
        return "macOS (darwin)"
    return f"Linux/Unix ({sys.platform})"


def _runtime_shell_label(*, prompt_language: str | None = None) -> str:
    if resolve_prompt_language(prompt_language) == "en":
        if sys.platform == "win32":
            return "PowerShell / cmd (default PowerShell; chain with ; not &&)"
        return "bash / zsh (resolved from runtime context)"
    if sys.platform == "win32":
        return "PowerShell / cmd（默认 PowerShell；多条命令用 ; 串联，勿用 &&）"
    return "bash / zsh（由系统上下文最终决定）"


def _display_agent_name(agent_name: str | None, *, prompt_language: str | None = None) -> str:
    """Normalize internal agent id to user-facing display name."""
    from evoflow.agents.xiaomi.identity import (
        XIAOMI_DISPLAY_NAME_EN,
        XIAOMI_DISPLAY_NAME_ZH,
        is_xiaomi_agent,
    )

    raw = (agent_name or "").strip()
    if is_xiaomi_agent(raw):
        lang = (prompt_language or "zh").strip().lower()
        if lang.startswith("en"):
            return XIAOMI_DISPLAY_NAME_EN
        return XIAOMI_DISPLAY_NAME_ZH
    if not raw:
        return get_prompt_dynamic(prompt_language).DEFAULT_DISPLAY_AGENT_NAME
    # Employed smart-employee: prefer 岗位名 over raw agent_code (e.g. 前端工程师).
    try:
        from evoflow.proactive.repositories import ProactiveRepository

        role = ProactiveRepository.get_role(raw)
        status = str(getattr(role, "status", "") or "").strip().lower() if role else ""
        if role is not None and status not in {"archived", "draft"}:
            name = str(getattr(role, "role_name", "") or "").strip()
            # Do not use leftover test postings that hijack the primary agent code.
            if name and raw.lower() not in {"main", "lead_agent"}:
                return name
    except Exception:
        logger.debug("proactive display name lookup failed for %s", raw, exc_info=True)
    if raw.lower() in {"main", "lead_agent"}:
        return get_prompt_dynamic(prompt_language).DEFAULT_DISPLAY_AGENT_NAME
    return raw


def _resolve_workspace_root(local_workspace_root: str | None) -> str:
    """Resolve workspace root path for uploads/workspace/outputs directories.

    Priority:
    1. Project runtime workspace (local_workspace_root)
    2. EVOFLOW_HOME environment variable (set by Tauri launcher)
    3. Paths.base_dir (global workspace, handles config.yaml, cwd, $HOME fallback)
    """
    # 详细日志：记录工作空间解析过程
    logger.debug("【主智能体工作空间根目录解析】输入的项目运行工作空间: %r", local_workspace_root)

    if local_workspace_root and local_workspace_root.strip():
        logger.debug("✓ 使用优先级 1: 项目运行工作空间, 结果: %s", local_workspace_root.strip())
        result = local_workspace_root.strip()
    elif evoflow_home := os.getenv("EVOFLOW_HOME"):
        stripped = evoflow_home.strip()
        if stripped:
            logger.debug("✓ 使用优先级 2: EVOFLOW_HOME 环境变量, 结果: %s", stripped)
            result = stripped
        else:
            logger.debug("✗ EVOFLOW_HOME 为空，回退到优先级 3: 全局工作空间, 结果: %s", get_paths().base_dir)
            result = str(get_paths().base_dir)
    else:
        logger.debug("✗ EVOFLOW_HOME 未设置，回退到优先级 3: 全局工作空间, 结果: %s", get_paths().base_dir)
        result = str(get_paths().base_dir)

    return result


def _build_subagent_section(
    max_concurrent: int,
    agent_name: str,
    *,
    prompt_language: str | None = None,
    intent_hint: str | None = None,
) -> str:
    """Slim catalog only — when/supervisor/boundary policy lives on tool descriptions."""
    _ = (max_concurrent, agent_name, intent_hint)
    from evoflow.subagents import get_available_subagent_names
    from evoflow.subagents.registry import list_subagents

    dyn = get_prompt_dynamic(prompt_language)
    configs = {c.name: c for c in list_subagents()}
    available_names = get_available_subagent_names()

    catalog_lines: list[str] = []
    media_crew = sorted(n for n in available_names if n.startswith("media-"))
    if media_crew:
        catalog_lines.append(dyn.SUBAGENT_MEDIA_CREW_TITLE)
        catalog_lines.append(dyn.SUBAGENT_MEDIA_CREW_RULE)
        for name in media_crew:
            desc = str(getattr(configs.get(name), "description", "") or "").strip()
            one_line = desc.split("\n", 1)[0].strip() if desc else name
            catalog_lines.append(f"- `{name}`：{one_line}")
        catalog_lines.append("")

    catalog_lines.append(f"- `general-purpose`{dyn.SUBAGENT_GP_LABEL}")
    if "code-agent" in available_names:
        catalog_lines.append(f"- `code-agent`{dyn.SUBAGENT_CODE_LABEL}")
    if "bash" in available_names:
        catalog_lines.append(f"- `bash`{dyn.SUBAGENT_BASH_LABEL}")
    if "claude-code" in available_names:
        catalog_lines.append(f"- `claude-code`{dyn.SUBAGENT_CLAUDE_LABEL}")

    available = "\n".join(catalog_lines)
    zh = resolve_prompt_language(prompt_language) == "zh"
    header = (
        "子代理已启用。选型 / 边界 / supervisor 分工见 **`subagent`** 与 **`supervisor`** 工具说明。"
        if zh
        else "Subagents enabled. Routing / boundaries / supervisor split: see **`subagent`** and **`supervisor`** tool descriptions."
    )
    return f"""<subagent_system>
{header}

{dyn.SUBAGENT_AVAILABLE_TITLE}
{available}
</subagent_system>"""


def _build_trae_section(loaded_tool_names: list[str] | None, agent_name: str, *, prompt_language: str | None = None) -> str:
    """No-op: Trae orchestration policy moved to ``trae_delegate`` tool description."""
    _ = (loaded_tool_names, agent_name, prompt_language)
    return ""


def _exploration_graph_prompt_enabled() -> bool:
    try:
        from evoflow.exploration_graph.config import is_exploration_graph_enabled

        return is_exploration_graph_enabled()
    except Exception:
        return True


def _resolve_context_priority_block(
    static,
    *,
    include_mind_map: bool,
    prompt_language: str | None = None,
) -> str:
    block = static.CONTEXT_PRIORITY_BLOCK.strip()
    if not include_mind_map:
        return block
    mind_line = getattr(static, "CONTEXT_PRIORITY_MIND_MAP_LINE", "").strip()
    if not mind_line:
        return block
    if resolve_prompt_language(prompt_language) == "en":
        needle = "profile, soul"
        if needle in block:
            return block.replace(needle, f"profile{mind_line}, soul", 1)
    else:
        needle = "画像"
        if needle in block:
            return block.replace(needle, f"画像{mind_line}", 1)
    return block


def _build_worker_guidance_section(loaded_tool_names: list[str] | None, *, prompt_language: str | None = None) -> str:
    """No-op: edit routing moved to replace/write/delete tool descriptions."""
    _ = (loaded_tool_names, prompt_language)
    return ""


def _build_task_router_section(loaded_tool_names: list[str] | None, *, prompt_language: str | None = None) -> str:
    # TEMP: 暂时不注入 `<task_router>` 系统提示段；恢复时删掉下一行即可。
    return ""
    names = {str(n or "").strip().lower() for n in (loaded_tool_names or [])}
    if not names.intersection({"worker", "find", "rg", "search_code_index", "read"}):
        return ""
    dyn = get_prompt_dynamic(prompt_language)
    text = dyn.TASK_ROUTER_GUIDANCE.strip()
    if _exploration_graph_prompt_enabled():
        bullet = getattr(dyn, "TASK_ROUTER_MIND_MAP_BULLET", "").strip()
        if bullet:
            marker = "`explore` (gather evidence)" if resolve_prompt_language(prompt_language) == "en" else "`explore`（取证）"
            idx = text.find(marker)
            if idx >= 0:
                eol = text.find("\n", idx)
                if eol >= 0:
                    text = text[: eol + 1] + bullet + "\n" + text[eol + 1 :]
    return text


def _build_knowledge_map_guidance_section(
    loaded_tool_names: list[str] | None = None,
    *,
    prompt_language: str | None = None,
) -> str:
    """No-op: mind-map policy moved to ``mind_map`` tool description."""
    _ = (loaded_tool_names, prompt_language)
    return ""


# NOTE: legacy monolithic template removed. Use _assemble_system_prompt instead.


def _get_memory_context(
    agent_name: str | None = None,
    *,
    injection_profile: str = "full",
    prompt_language: str | None = None,
) -> str:
    """Get memory context for injection into system prompt.

    Args:
        agent_name: If provided, loads per-agent memory. If None, loads global memory.
        injection_profile: ``full`` or ``chat_compact`` (stable summaries + facts only; see memory formatter).

    Returns:
        Formatted memory context string wrapped in XML tags, or empty string if disabled.
    """
    try:
        from evoflow.agents.memory import format_memory_for_injection, get_memory_data
        from evoflow.config.memory_config import get_memory_config

        config = get_memory_config()
        if not config.enabled:
            return ""

        memory_block = ""
        if config.injection_enabled:
            memory_data = get_memory_data(agent_name)
            mtoks = config.chat_compact_max_tokens if injection_profile == "chat_compact" else config.max_injection_tokens
            memory_content = format_memory_for_injection(
                memory_data,
                max_tokens=mtoks,
                injection_profile=injection_profile,
            )
            if memory_content.strip():
                memory_block = f"<memory>\n{memory_content}\n</memory>\n"

        try:
            from evoflow.agents.memory_plugins.manager import get_external_memory_plugin_manager

            mgr = get_external_memory_plugin_manager()
            if mgr is not None:
                addon = mgr.system_addon()
                if addon:
                    from evoflow.agents.memory_plugins.plugin_memory_audit import pm_event

                    pm_event(
                        "lead_prompt_system_addon",
                        addon_chars=len(addon),
                    )
                    memory_block = f"{memory_block}\n\n{addon}" if memory_block else addon
        except Exception as ex:
            logger.debug("External memory system addon skipped: %s", ex)

        return memory_block
    except Exception as e:
        logger.error("Failed to load memory context: %s", e)
        return ""


def build_memory_injection_sections(
    *,
    agent_name: str | None = None,
    local_workspace_root: str | None = None,
    injection_profile: str = "full",
    prompt_language: str | None = None,
    query: str = "",
    include_query_recall: bool = False,
    principal_id: str = "",
) -> str:
    """Build memory blocks for prompt injection.

    Standing MEMORY/USER/workspace blocks ignore ``query``. Person/craft recall is
    query-keyed and should ride turn-tail only when explicitly enabled
    (``include_query_recall=True`` + ``EVOFLOW_QUERY_RECALL=1``).

    asset-hub memory mode (default): Asset Hub read_path + standing only — no legacy SQLite ``<memory>``.

    ``principal_id``: read profile/standing from the caller's personal asset
    bucket (matches Asset Center view; empty = local shared bucket).
    """
    from evoflow.assets.memory_injection import asset_hub_memory_injection
    from evoflow.assets.paths import EntityRef, sanitize_user_asset_id

    asset_mode = asset_hub_memory_injection()
    memory_context = ""
    if not asset_mode:
        memory_context = _get_memory_context(
            agent_name,
            injection_profile=injection_profile,
            prompt_language=prompt_language,
        )

    pid = str(principal_id or "").strip()
    profile_entity = (
        EntityRef("user", sanitize_user_asset_id(pid)).normalized() if pid else None
    )

    sections: list[str] = []
    body_parts: list[str] = []

    try:
        from evoflow.assets.profile_injection import (
            build_user_profile_injection_block,
            resolve_profile_injection_scope,
        )

        pscope = resolve_profile_injection_scope(agent_name=agent_name)
        profile_block = build_user_profile_injection_block(
            prompt_language=prompt_language,
            scope=pscope,
            entity=profile_entity,
        ).strip()
        if profile_block:
            safe_profile = scan_content(profile_block, source="user_profile").strip()
            if safe_profile:
                body_parts.append(safe_profile)
    except Exception:
        logger.debug("user profile injection skipped", exc_info=True)

    if memory_context.strip():
        safe_mem = scan_content(memory_context.strip(), source="memory_context").strip()
        if safe_mem:
            body_parts.append(safe_mem)

    # runtime-aligned Asset Hub: standing + read_path guidance + catalog (Tier 0)
    # Shared Entity-assets procedure is injected at most once (user first, else workspace).
    procedure_emitted = False
    try:
        from evoflow.assets.guidance import (
            build_session_asset_memory_block,
            session_asset_block_includes_procedure,
        )

        asset_block = build_session_asset_memory_block(
            agent_name=agent_name,
            principal_id=principal_id,
            include_procedure=True,
        )
        if asset_block.strip():
            safe_asset = scan_content(asset_block.strip(), source="asset_memory").strip()
            if safe_asset:
                body_parts.append(safe_asset)
                procedure_emitted = session_asset_block_includes_procedure(safe_asset)
    except Exception:
        logger.debug("asset memory injection skipped", exc_info=True)

    # Bound workspace: inject project catalog (separate from user memory)
    lw = str(local_workspace_root or "").strip()
    if lw:
        try:
            from evoflow.agents.memory.workspace_memory import format_workspace_memory_context

            ws_block = format_workspace_memory_context(
                lw,
                injection_profile=injection_profile,
                include_procedure=not procedure_emitted,
            ).strip()
            if ws_block:
                safe_ws = scan_content(ws_block, source="workspace_memory").strip()
                if safe_ws:
                    body_parts.append(safe_ws)
            from evoflow.agents.lead_agent.prompt_language import resolve_prompt_language
            from evoflow.assets.workspace_memory_policy import workspace_write_discipline_block

            disc = workspace_write_discipline_block(lang=resolve_prompt_language(prompt_language))
            body_parts.append(disc)
        except Exception:
            logger.debug("workspace memory injection skipped", exc_info=True)

    if body_parts:
        sections.append("<!-- ref memory -->\n" + "\n\n".join(body_parts))

    if include_query_recall:
        recall = build_memory_query_recall_sections(agent_name=agent_name, query=query)
        if recall.strip():
            sections.append(recall.strip())

    return "\n\n".join(sections).strip()


def build_memory_query_recall_sections(
    *,
    agent_name: str | None = None,
    query: str = "",
    thread_id: str | None = None,
    standing_preview: str = "",
) -> str:
    """Query-keyed archival recall (user/agent + person/craft) for turn-tail only.

    When ``thread_id`` is set, also records a compact snapshot for the chat
    transparency chip (``GET /api/memory/recall-snapshot``).
    """
    q = str(query or "").strip()[:500]
    sections: list[str] = []
    snapshot_hits: list[dict] = []
    archival_ok = _archival_query_worthwhile(q)

    # User/agent archival hybrid recall (mem_*)
    if archival_ok:
        try:
            from evoflow.memory.document_codec import namespace_for_agent_key
            from evoflow.memory.facade import format_atoms_block, recall

            ns = namespace_for_agent_key(agent_name)
            from evoflow.assets.injection_budget import TIER1_RECALL_MAX_CHARS, TIER1_RECALL_TOP_K

            hits = recall(
                [ns],
                q,
                layers=["episodic", "semantic"],
                top_k=TIER1_RECALL_TOP_K,
                max_chars=TIER1_RECALL_MAX_CHARS,
            )
            # Skip atoms already likely in standing core (pinned)
            hits = [h for h in hits if not h.get("pin")]
            snapshot_hits.extend(hits)
            block = format_atoms_block(hits, title="memory_archival")
            if block.strip():
                safe = scan_content(block.strip(), source="memory_archival").strip()
                if safe:
                    sections.append(
                        "<!-- █ MEMORY ARCHIVAL — retrieved for this turn; REFERENCE ONLY █ -->\n"
                        f"{safe}\n<!-- █ END MEMORY ARCHIVAL █ -->"
                    )
        except Exception as ar_exc:
            logger.debug("User archival recall skipped: %s", ar_exc)

    person_memory_context = ""
    try:
        from evoflow.assets.injection_budget import TIER1_PERSON_MEMORY_CHARS
        from evoflow.person_kernel import format_person_memory_context

        person_memory_context = format_person_memory_context(
            agent_name,
            query=q if archival_ok else "",
            max_chars=TIER1_PERSON_MEMORY_CHARS,
        )
    except Exception as pm_exc:
        logger.debug("Person memory injection skipped: %s", pm_exc)

    person_craft_context = ""
    try:
        from evoflow.assets.injection_budget import TIER1_PERSON_CRAFT_CHARS
        from evoflow.person_kernel import format_person_craft_context

        person_craft_context = format_person_craft_context(
            agent_name,
            query=q if archival_ok else "",
            max_chars=TIER1_PERSON_CRAFT_CHARS,
        )
    except Exception as pc_exc:
        logger.debug("Person craft injection skipped: %s", pc_exc)

    if person_memory_context.strip():
        safe_pm = scan_content(person_memory_context.strip(), source="person_memory_context").strip()
        if safe_pm:
            sections.append(
                f"<!-- █ PERSON MEMORY — YOUR autobiography; read first, cite when relevant; never confuse with user <memory> █ -->\n{safe_pm}\n<!-- █ END PERSON MEMORY █ -->"
            )
            snapshot_hits.append(
                {
                    "id": "",
                    "namespace_id": f"person:{(agent_name or '').strip()}",
                    "layer": "episodic",
                    "kind": "person_memory",
                    "content": safe_pm[:240],
                }
            )
    if person_craft_context.strip():
        safe_pc = scan_content(person_craft_context.strip(), source="person_craft_context").strip()
        if safe_pc:
            sections.append(
                f"<!-- █ PERSON CRAFT (HIGH WEIGHT) — howtos & hard negatives; MUST prefer matching craft before reinventing; treat as working memory not decoration █ -->\n{safe_pc}\n<!-- █ END PERSON CRAFT █ -->"
            )
            snapshot_hits.append(
                {
                    "id": "",
                    "namespace_id": f"person:{(agent_name or '').strip()}",
                    "layer": "procedural",
                    "kind": "person_craft",
                    "content": safe_pc[:240],
                }
            )

    text = "\n\n".join(sections).strip()
    if thread_id:
        try:
            from evoflow.memory.recall_snapshot import record_thread_recall

            record_thread_recall(
                thread_id,
                query=q,
                standing_preview=standing_preview,
                hits=snapshot_hits,
                source="turn" if archival_ok else "standing",
            )
        except Exception as snap_exc:
            logger.debug("recall snapshot record skipped: %s", snap_exc)
    return text


_WEAK_ARCHIVAL_EXACT = frozenset(
    {
        "你好",
        "您好",
        "在吗",
        "在不在",
        "嗨",
        "哈喽",
        "hello",
        "hi",
        "hey",
        "谢谢",
        "多谢",
        "好的",
        "嗯",
        "哦",
        "ok",
        "okay",
        "今天做什么",
        "现在做什么",
        "干嘛",
        "帮我看看",
        "帮我看看代码",
        "怎么样",
    }
)
_WEAK_ARCHIVAL_RE = re.compile(
    r"^(今天|明天|现在)?(做|干)什么[?？!！.。]*$"
    r"|^(帮我)?看看(一下|代码|这个)?[?？!！.。]*$"
    r"|^(在吗|在不在)[?？!！.。]*$",
    re.I,
)


def _archival_query_worthwhile(query: str) -> bool:
    """Skip archival RAG for greetings / vague filler; keep short specific terms (e.g. 青柠)."""
    q = str(query or "").strip()
    if not q:
        return False
    if len(q) <= 1:
        return False
    low = q.lower().strip("?!！？。．… \t")
    if low in _WEAK_ARCHIVAL_EXACT:
        return False
    if _WEAK_ARCHIVAL_RE.match(q.strip()):
        return False
    return True


def _truncate_skill_description(text: str, *, max_chars: int | None = None) -> str:
    from evoflow.assets.injection_budget import TIER0_SKILL_DESC_CHARS

    cap = TIER0_SKILL_DESC_CHARS if max_chars is None else max_chars
    raw = (text or "").strip()
    if len(raw) <= cap:
        return raw
    return raw[: cap - 1].rstrip() + "…"


def get_skills_prompt_section(
    available_skills: set[str] | None = None,
    *,
    use_virtual_paths: bool = False,
    prompt_language: str | None = None,
    compact: bool = False,
    principal_id: str | None = None,
    session_scope_id: str | None = None,
) -> str:
    """Generate the skills prompt section with available skills list.

    Returns the <skill_system>...</skill_system> block listing all enabled skills,
    suitable for injection into any agent's system prompt.

    When ``principal_id`` is set, discovery uses that principal's scope skill roots
    (personal/group/org) so other users' private skills never enter the prompt.
    """
    from evoflow.skills.loader import get_cached_skills_prompt_section, load_skills

    scope_roots = None
    pid = str(principal_id or "").strip()
    if pid:
        try:
            from evoflow.authz.principals import get_principal
            from evoflow.authz.skill_roots import scope_skill_roots_for_principal

            principal = get_principal(pid)
            if principal:
                scope_roots = scope_skill_roots_for_principal(
                    principal,
                    session_scope_id=session_scope_id,
                    ensure=True,
                )
        except Exception:
            scope_roots = None

    skills = load_skills(enabled_only=True, scope_skill_roots=scope_roots)
    avail_key = tuple(sorted(available_skills)) if available_skills is not None else None
    # Names-only key: section cache shares TTL with load_skills (cleared via clear_skills_cache).
    skills_key = tuple(s.name for s in skills)
    lang_key = (prompt_language or "").strip().lower() or "default"
    roots_key = tuple(str(p) for p, _ in (scope_roots or []))
    cache_key = (skills_key, avail_key, bool(use_virtual_paths), bool(compact), lang_key, roots_key)

    def _build() -> str:
        return _build_skills_prompt_section(
            skills,
            available_skills=available_skills,
            use_virtual_paths=use_virtual_paths,
            prompt_language=prompt_language,
            compact=compact,
        )

    return get_cached_skills_prompt_section(cache_key, _build)


def _build_skills_prompt_section(
    skills: list,
    *,
    available_skills: set[str] | None = None,
    use_virtual_paths: bool = False,
    prompt_language: str | None = None,
    compact: bool = False,
) -> str:
    try:
        from evoflow.config import get_app_config

        config = get_app_config()
        container_base_path = config.skills.container_path
    except Exception:
        container_base_path = "/mnt/skills"
    skills_mount_base = container_base_path
    dyn = get_prompt_dynamic(prompt_language)
    if not use_virtual_paths:
        container_base_path = dyn.SKILLS_CONTAINER_LABEL_LOCAL

    if available_skills is not None and skills:
        skills = [skill for skill in skills if skill.name in available_skills]

    # Tier 0 craft/skills catalog: hard cap item count (entity-asset-hub §8.2)
    try:
        from evoflow.assets.injection_budget import TIER0_SKILLS_MAX_ITEMS

        if len(skills) > TIER0_SKILLS_MAX_ITEMS:
            skills = skills[:TIER0_SKILLS_MAX_ITEMS]
    except Exception:
        pass

    if not skills:
        # Empty skills list — if explicitly configured as empty (not just no skills found),
        # return empty string to omit the entire <skill_system> block from prompt.
        # Only show the placeholder comment when no config was provided (available_skills is None).
        if available_skills is not None:
            return ""
        if compact:
            section = f"""<skill_system>
{dyn.SKILL_SYSTEM_INTRO}
{dyn.SKILL_RULE_COMPACT}

<available_skills>
    <!-- {dyn.SKILL_EMPTY_COMMENT} -->
</available_skills>

</skill_system>"""
        else:
            section = f"""<skill_system>
{dyn.SKILL_SYSTEM_INTRO}

{dyn.SKILL_PROGRESSIVE_HEADER}
1. {dyn.SKILL_RULE_1}
2. {dyn.SKILL_RULE_2}
3. {dyn.SKILL_RULE_3}

{dyn.SKILL_DIR_LABEL} {container_base_path}

<available_skills>
    <!-- {dyn.SKILL_EMPTY_COMMENT} -->
</available_skills>

</skill_system>"""
        return section

    from evoflow.skills.skill_uri import SKILL_URI_PREFIX

    def _skill_location(skill) -> str:
        if use_virtual_paths:
            return skill.get_container_file_path(skills_mount_base)
        # Host-direct mode: install dir is outside the session workspace; use skill: URI.
        return f"{SKILL_URI_PREFIX}{skill.name}"

    def _skill_description(skill) -> str:
        desc = skill.description or ""
        return _truncate_skill_description(desc) if compact else desc

    skill_items = "\n".join(
        f"    <skill>\n        <name>{skill.name}</name>\n        <description>{_skill_description(skill)}</description>\n        <location>{_skill_location(skill)}</location>\n    </skill>"
        for skill in skills
    )
    skills_list = f"<available_skills>\n{skill_items}\n</available_skills>"

    if compact:
        section = f"""<skill_system>
{dyn.SKILL_SYSTEM_INTRO}
{dyn.SKILL_RULE_COMPACT}

{skills_list}

</skill_system>"""
    else:
        section = f"""<skill_system>
{dyn.SKILL_SYSTEM_INTRO}

{dyn.SKILL_PROGRESSIVE_HEADER}
1. {dyn.SKILL_RULE_1}
2. {dyn.SKILL_RULE_2}
3. {dyn.SKILL_RULE_3}

{dyn.SKILL_DIR_LABEL} {container_base_path}

{skills_list}

</skill_system>"""
    return section


def _load_agent_soul_text(agent_name: str | None) -> str:
    """Tier-0 soul text (summary preferred) without XML wrappers or employee posting."""
    soul = load_agent_soul(agent_name) or ""
    try:
        from evoflow.assets.injection_budget import TIER0_SOUL_SUMMARY_CHARS
        from evoflow.assets.soul_summary import load_soul_summary_text

        summary = load_soul_summary_text(agent_name)
        if summary:
            return summary
        from evoflow.assets.soul_summary import extract_soul_summary

        extracted = extract_soul_summary(soul, max_chars=TIER0_SOUL_SUMMARY_CHARS)
        if extracted:
            return extracted
    except Exception:
        logger.debug("soul-summary Tier 0 load skipped", exc_info=True)
    return soul


def get_agent_soul(agent_name: str | None, *, include_employee_posting: bool = True) -> str:
    """Return prompt blocks for Person Kernel L0 identity + L1 soul + presence.

    When this agent is an employed smart-employee (proactive role), also inject a
    compact duty card so Feishu/IM chats introduce as the **岗位** (not only the
    underlying model / generic coding template).

    Tier 0 prefers ``soul-summary.md`` (≤300 chars) over full SOUL when available.

    Employee chat v2 sets ``include_employee_posting=False`` — identity lives in
    ``<employee><identity>`` instead of stacking ``<employee_posting>``.
    """
    from evoflow.person_kernel import (
        format_identity_prompt_block,
        format_soul_prompt_block,
    )

    soul = _load_agent_soul_text(agent_name)

    identity = ""
    try:
        from evoflow.config.agents_config import load_agent_identity

        identity = load_agent_identity(agent_name) or ""
    except Exception:
        identity = ""
    parts: list[str] = []
    # IM / chat identity for employed roles only; lead assistant identity lives in <role>.
    # Employee chat v2 owns identity — skip posting here to avoid double stack.
    if include_employee_posting:
        duty = _proactive_employee_im_identity_block(agent_name)
        if duty:
            parts.append(duty)
    id_block = format_identity_prompt_block(identity)
    if id_block:
        parts.append(id_block)
    is_lead = _is_lead_agent_code(agent_name)
    soul_block = format_soul_prompt_block(
        soul,
        max_chars=400,  # summary already capped; small headroom for XML wrapper noise
        # Main/lead: identity in <role>; soul = traits/habits only.
        omit_identity=is_lead,
        omit_lessons_learned=is_lead,
    )
    if soul_block:
        parts.append(soul_block)
    # ``<person_presence>`` / 站立摘要是智能体员工值班话术（班次、本轮、收工）。
    # 主会话 Agent 对话不要注入；值班路径在 proactive/prompt.py 里 ``for_duty=True`` 单独加。
    return "".join(parts)


def _is_lead_agent_code(agent_name: str | None) -> bool:
    code = str(agent_name or "").strip().lower()
    return code in {"", "main", "lead_agent"}


def _proactive_employee_im_identity_block(agent_name: str | None) -> str:
    """IM/chat identity for employed roles (fallback when not using employee chat v2)."""
    code = str(agent_name or "").strip()
    if not code:
        return ""
    if code.lower() in {"main", "lead_agent"}:
        return ""
    try:
        from evoflow.proactive.employee_prompt import resolve_employee_identity

        info = resolve_employee_identity(code)
        if info is None:
            return ""
        role_name = str(info.get("role_name") or code)
        lines = [
            "<employee_posting>",
            f"你在本产品中的岗位是「{role_name}」（agent_code=`{info.get('code') or code}`）。",
            f"用户问「你是谁」时：第一句必须是「我是{role_name}」，可再补一句本职职责；",
            "禁止自称底层模型名或厂商名（Agnes / GPT / Claude / Sapiens 等），也不要只说「编码智能体」而忽略岗位。",
            "用户问「你能干嘛」时：用岗位职责列表白话回答，不要改成通用大模型能力清单。",
        ]
        dept = str(info.get("department") or "").strip()
        if dept:
            lines.append(f"所属：{dept}")
        resp = list(info.get("responsibilities") or [])
        if resp:
            lines.append("本职职责：")
            for item in resp[:8]:
                lines.append(f"- {item}")
        else:
            lines.append("本职职责：（岗位职责尚未配置，请以岗位名与用户本轮意图为准协助。）")
        lines.append("</employee_posting>")
        return "\n".join(lines) + "\n"
    except Exception:
        logger.debug("proactive IM identity lookup failed for %s", code, exc_info=True)
        return ""

def get_deferred_tools_prompt_section(
    *,
    pending_names: list[str] | None = None,
) -> str:
    """Generate <available-deferred-tools> block for the system prompt.

    Lists only deferred tools that still need ``tool_search`` (not already bound/loaded).
    Returns empty string when tool_search is disabled or nothing is pending.
    """
    try:
        from evoflow.config.tool_search_config import is_tool_search_enabled

        if not is_tool_search_enabled():
            return ""
    except Exception:
        return ""

    if pending_names is None:
        pending_names = resolve_pending_tools_for_prompt()
    pending = _normalize_tool_name_list(pending_names)
    if not pending:
        return ""

    names = "\n".join(pending)
    return f"<available-deferred-tools>\n{names}\n</available-deferred-tools>"


def get_loaded_tools_prompt_section(tool_names: list[str] | None) -> str:
    """(Deprecated for system prompt) MCP tool summary helper; not injected into lead-agent template.

    Model-visible tools are bound via OpenAI ``tools`` on each request; listing names again in the
    system prompt duplicates context and invites hallucinated calls.
    """
    del tool_names
    return ""


def get_available_subagents_prompt_section(subagent_names: list[str] | None) -> str:
    """(Deprecated) Kept for backward-compatibility; not used in current template."""
    return ""


def _build_acp_section(*, use_virtual_paths: bool = False) -> str:
    """Build the ACP agent prompt section, only if ACP agents are configured."""
    try:
        from evoflow.config.acp_config import get_acp_agents

        agents = get_acp_agents()
        if not agents:
            return ""
    except Exception:
        return ""

    if use_virtual_paths:
        return (
            "\n**ACP Agent Tasks (invoke_acp_agent):**\n"
            "- ACP agents run in their own independent workspace (与当前工作空间隔离)\n"
            "- When writing prompts for ACP agents, describe the task only — do NOT reference current workspace paths\n"
            "- ACP agent results are accessible in ACP workspace (read-only) — use `ls`, `read_file`, or `bash cp` to retrieve output files\n"
            "- To deliver ACP output to the user: copy into current workspace, then ``panel_set`` (kind=artifacts, data.items with path)"
        )
    return (
        "\n**ACP Agent Tasks (invoke_acp_agent):**\n"
        "- ACP agents run in their own independent local workspace (not the user's upload/work directory).\n"
        "- When writing prompts for ACP agents, describe the task only — do NOT reference sandbox virtual paths.\n"
        "- ACP agent results are accessible in the local ACP workspace (read-only) — use `ls` / `read_file` to retrieve output files.\n"
        "- To deliver ACP output to the user: copy into the local workspace, then ``panel_set`` (kind=artifacts, data.items with path)."
    )


def apply_prompt_template(
    subagent_enabled: bool = False,
    max_concurrent_subagents: int = 5,
    *,
    include_subagent_system_prompt: bool = False,
    agent_name: str | None = None,
    custom_system_prompt: str | None = None,
    available_skills: set[str] | None = None,
    loaded_tool_names: list[str] | None = None,
    all_tool_names: list[str] | None = None,
    use_virtual_paths: bool = False,
    local_workspace_root: str | None = None,
    intent_hint: str | None = None,
    mission_state: dict | None = None,
    collab_phase: str | None = None,
    prompt_source: str = "unknown",
    user_question: str = "",
    include_memory: bool | None = None,
    thread_id: str | None = None,
    prompt_language: str | None = None,
    session_mode: str | None = None,
    session_key: str | None = None,
    loaded_deferred: list[str] | None = None,
    mcp_skill_section: str = "",
    thinking_enabled: bool = False,
    voice_mode: bool = False,
    xiaomi_page_context: dict | None = None,
    principal_id: str | None = None,
    owner_scope_id: str | None = None,
) -> str:
    if isinstance(mission_state, dict) and not str(mission_state.get("task_type") or "").strip():
        from evoflow.exploration.task_router import classify_task_type_heuristic

        hint_text = str(user_question or "").strip()
        if hint_text:
            mission_state = {**mission_state, "task_type": classify_task_type_heuristic(hint_text)}
    lang = resolve_prompt_language(prompt_language)
    dyn = get_prompt_dynamic(lang)
    try:
        from evoflow.agents.middlewares.plan_guard_middleware import is_subagent_focus_mode

        subagent_focus_mode = is_subagent_focus_mode(session_mode=session_mode, collab_phase=collab_phase)
    except Exception:
        subagent_focus_mode = False
    display_name = _display_agent_name(agent_name, prompt_language=lang)
    active_scenario_keys = resolve_active_scenario_keys_for_display(
        intent_hint=intent_hint,
        session_mode=session_mode,
    )
    intent = resolve_prompt_scenario_csv(
        intent_hint=",".join(active_scenario_keys) if active_scenario_keys else intent_hint,
        local_workspace_root=local_workspace_root,
    )
    if not active_scenario_keys and intent != "ask":
        active_scenario_keys = resolve_active_scenario_keys_for_display(intent_hint=intent)
    pure_chat = _is_pure_chat_modules(_enabled_modules_for_scenario(intent))

    # Subagent delegation block is opt-in; tools stay available via ``subagent_enabled`` elsewhere.
    n = max_concurrent_subagents
    subagent_section = (
        _build_subagent_section(n, display_name, prompt_language=lang, intent_hint=intent)
        if include_subagent_system_prompt
        else ""
    )

    # Get skills section
    _t_sk = time.perf_counter()
    skills_section = get_skills_prompt_section(
        available_skills,
        use_virtual_paths=use_virtual_paths,
        prompt_language=lang,
        compact=pure_chat,
        principal_id=principal_id,
        session_scope_id=owner_scope_id,
    )
    try:
        from evoflow.observability.run_latency_trace import record_phase

        record_phase("load_skills_prompt_ms", (time.perf_counter() - _t_sk) * 1000.0)
    except Exception:
        pass
    trae_section = _build_trae_section(loaded_tool_names, display_name, prompt_language=lang)
    worker_guidance_section = _build_worker_guidance_section(loaded_tool_names, prompt_language=lang)
    task_router_section = _build_task_router_section(loaded_tool_names, prompt_language=lang)
    knowledge_map_section = _build_knowledge_map_guidance_section(loaded_tool_names, prompt_language=lang)

    # Build ACP agent section only if ACP agents are configured
    acp_section = _build_acp_section(use_virtual_paths=use_virtual_paths)
    runtime_mode = "VIRTUAL_SANDBOX" if use_virtual_paths else "LOCAL_HOST"
    runtime_os = _runtime_os_label()
    runtime_shell = _runtime_shell_label(prompt_language=lang)
    runtime_now = format_runtime_now_for_prompt(prompt_language=lang)
    runtime_host_hint = dyn.RUNTIME_HOST_HINT_VIRTUAL if use_virtual_paths else ""

    # Lead/main interactive sessions use compact user memory so Work/role narratives
    # (e.g.「验证岗」) don't outweigh the latest user ask. Specialized agents keep full.
    mem_profile = "chat_compact" if (pure_chat or _is_lead_agent_code(agent_name)) else "full"
    if include_memory is False:
        memory_context = ""
        workspace_memory_context = ""
        person_memory_context = ""
    else:
        from evoflow.assets.memory_injection import asset_hub_memory_injection

        _t_mem = time.perf_counter()
        if asset_hub_memory_injection():
            # Runtime: Tier-0 memory rides MemoryLiveFooter (read_path + standing); not static SQLite block.
            memory_context = ""
        else:
            memory_context = _get_memory_context(agent_name, injection_profile=mem_profile, prompt_language=lang)
        workspace_memory_context = ""
        person_memory_context = ""
        try:
            from evoflow.observability.run_latency_trace import record_phase

            record_phase("load_memory_context_ms", (time.perf_counter() - _t_mem) * 1000.0)
        except Exception:
            pass
    _build_intent_modules_section(intent, prompt_language=lang)
    # Live mission rides turn-tail HumanMessage (MissionStateLiveFooterMiddleware), not system.
    _ = mission_state  # retained for bootstrap_mode / callers; not injected into system
    mission_state_section = ""
    collab_phase_section = _build_collab_phase_guard_section(collab_phase, prompt_language=lang)
    plan_workflow_section = _build_plan_workflow_section(
        display_name,
        scenario=intent,
        collab_phase=collab_phase,
        prompt_language=lang,
    )
    plan_runtime_stage_section = _build_plan_runtime_stage_section(collab_phase, thread_id, scenario=intent, prompt_language=lang)
    prompt_session_key = _session_key_for_prompt(thread_id, session_key)
    tool_catalog_section = _build_tool_catalog_section(
        loaded_tool_names,
        all_tool_names=all_tool_names,
        prompt_language=lang,
        compact=_use_compact_tool_catalog(intent),
        session_key=prompt_session_key,
        active_scenarios=active_scenario_keys,
        loaded_deferred=loaded_deferred,
    )
    bootstrap_mode = False
    if mission_state is None:
        bootstrap_mode = True
    elif isinstance(mission_state, dict):
        primary = str(mission_state.get("primary_objective", "") or "").strip()
        active = mission_state.get("active_subproblems")
        done = mission_state.get("done_subproblems")
        if not primary and not active and not done:
            bootstrap_mode = True

    # Employee user-chat (proactive:{code}/:task:/:chat:) → dedicated v2 skeleton.
    # Not duty handbook; not generic EvovexAI <role> + employee_posting stack.
    employee_ok = False
    emp_identity = None
    if not _is_xiaomi_lead_run(agent_name):
        try:
            from evoflow.proactive.employee_prompt import is_employee_chat_session

            employee_ok, emp_identity = is_employee_chat_session(
                prompt_session_key or session_key,
                agent_name,
            )
        except Exception:
            employee_ok, emp_identity = False, None

    if employee_ok and emp_identity is not None:
        from evoflow.proactive.employee_prompt import build_employee_chat_system_prompt

        skills_blob = "\n\n".join(
            p for p in (str(skills_section or "").strip(), str(mcp_skill_section or "").strip()) if p
        )
        # Employee chat: always inject user identity + 画像 (even when runtime clears SQLite memory).
        emp_user_profile = ""
        try:
            from evoflow.assets.profile_injection import build_user_profile_injection_block

            emp_user_profile = build_user_profile_injection_block(
                prompt_language=lang,
                scope="full",
            ).strip()
        except Exception:
            emp_user_profile = ""
        emp_person_memory = person_memory_context
        if include_memory is not False and not str(emp_person_memory or "").strip():
            try:
                from evoflow.assets.injection_budget import TIER1_PERSON_MEMORY_CHARS
                from evoflow.person_kernel import format_person_memory_context

                emp_person_memory = format_person_memory_context(
                    agent_name,
                    query="",
                    max_chars=TIER1_PERSON_MEMORY_CHARS,
                )
            except Exception:
                emp_person_memory = ""
        prompt = build_employee_chat_system_prompt(
            identity=emp_identity,
            soul=_load_agent_soul_text(agent_name),
            skills_section=skills_blob,
            workspace_root_hint=_resolve_workspace_root(local_workspace_root)
            or str(emp_identity.get("workspace_path") or ""),
            runtime_os=runtime_os,
            runtime_shell=runtime_shell,
            runtime_host_hint=runtime_host_hint,
            runtime_now=runtime_now,
            memory_context=memory_context,
            person_memory_context=emp_person_memory,
            user_profile_block=emp_user_profile,
            custom_system_prompt=(custom_system_prompt or "").strip(),
            prompt_language=lang,
            loaded_tool_names=loaded_tool_names,
        )
    else:
        prompt = _assemble_system_prompt(
            scenario=intent,
            agent_name=display_name,
            soul=get_agent_soul(agent_name),
            custom_system_prompt=(custom_system_prompt or "").strip(),
            memory_context=memory_context,
            workspace_memory_context=workspace_memory_context,
            person_memory_context=person_memory_context,
            mission_state_section=mission_state_section,
            tool_catalog_section=tool_catalog_section,
            skills_section=skills_section,
            mcp_skill_section=mcp_skill_section,
            subagent_section=subagent_section,
            trae_section=trae_section,
            worker_guidance_section=worker_guidance_section,
            task_router_section=task_router_section,
            knowledge_map_section=knowledge_map_section,
            acp_section=acp_section,
            workspace_root_hint=_resolve_workspace_root(local_workspace_root),
            runtime_mode=runtime_mode,
            runtime_os=runtime_os,
            runtime_shell=runtime_shell,
            runtime_now=runtime_now,
            runtime_host_hint=runtime_host_hint,
            collab_phase_section=collab_phase_section,
            plan_workflow_section=plan_workflow_section,
            plan_runtime_stage_section=plan_runtime_stage_section,
            active_scenario_keys=active_scenario_keys,
            subagent_enabled=subagent_enabled,
            bootstrap_mode=bootstrap_mode,
            prompt_language=lang,
            subagent_focus_mode=subagent_focus_mode,
            thinking_enabled=bool(thinking_enabled),
            voice_mode=bool(voice_mode),
            # Mind-map policy lives on the mind_map tool description — do not inject
            # TOOL_CALLING_MIND_MAP_RULE / CONTEXT_PRIORITY_MIND_MAP_LINE into system prompt.
            mind_map_prompt_enabled=False,
            xiaomi_mode=_is_xiaomi_lead_run(agent_name),
            # Page UI → ephemeral HumanMessage (XiaomiUiContextLiveFooterMiddleware), not system.
            xiaomi_page_context=None,
        )

    if not use_virtual_paths:
        lw = (local_workspace_root or "").strip()
        for old, new in dyn.LOCAL_HOST_REPLACEMENTS:
            if lw and "{lw}" in new:
                prompt = prompt.replace(old, new.format(lw=lw))
            elif "{lw}" not in new:
                prompt = prompt.replace(old, new)
        prompt = prompt.replace(dyn.LOCAL_HOST_MNT_PREFIX, dyn.LOCAL_HOST_MNT_REPLACEMENT)

    full_prompt = prompt
    return full_prompt
