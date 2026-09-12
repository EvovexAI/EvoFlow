"""Supervisor tool for multi-agent task planning and coordination.

Thin routing layer: ``@tool("supervisor")`` + action dispatch.
All heavy logic is delegated to the :pymod:`supervisor` sub-package:
- :pymod:`~supervisor.dependency` — DAG depends_on resolution
- :pymod:`~supervisor.execution` — Delegation (task_tool), auto-followup wave
- :pymod:`~supervisor.monitor`  — Background task monitor, recommendation engine
- :pymod:`~supervisor.memory`  — Memory aggregation, SSE broadcast
- :pymod:`~supervisor.utils`    — Runtime helpers, debug, clamping
- :pymod:`~supervisor.display`  — Subtask row formatting, worker_profile rendering
"""

import asyncio
import json
import logging
from pathlib import Path
from typing import Annotated, Any

from langchain.tools import InjectedToolCallId, ToolRuntime, tool
from langgraph.config import get_stream_writer
from langgraph.typing import ContextT
from pydantic import ValidationError

from evoflow.agents.middlewares.collab_cycle_trace_logging import write_cycle_trace
from evoflow.agents.mission_state.plan_binding import attach_bound_plan_from_mission_state
from evoflow.collab.agent_assignment import display_name_for_agent_code
from evoflow.collab.id_format import make_subtask_id
from evoflow.collab.models import WorkerProfile
from evoflow.collab.storage import (
    find_main_task,
    find_subtask_by_ids,
    get_project_storage,
    get_task_detail_storage,
    load_task_detail_for_task_id,
    new_project_bundle_root_task,
    rollup_root_task_progress_from_subtasks,
)
from evoflow.collab.thread_collab import (
    advance_collab_phase_to_executing_for_task,
    load_thread_collab_state,
    merge_thread_collab_state,
    save_thread_collab_state,
)
from evoflow.config.paths import get_paths
from evoflow.subagents import get_available_subagent_names  # re-export for tests/monkeypatching
from evoflow.timeutil import utc_now_iso_z

# ── Sub-module imports (extracted from monolithic layout) ──────────────
from evoflow.tools.builtins.supervisor.dependency import (  # noqa: F401
    _IN_FLIGHT_SUBTASK,
    _TERMINAL_SUBTASK,
    _auto_finalize_unrunnable_pending_subtasks,
    _build_batch_ref_and_index_maps,
    _build_existing_ref_to_id,
    _build_subtask_name_index,
    _extract_dep_refs_from_subtask_spec,
    _max_numeric_subtask_ref,
    _resolve_dep_ref_to_id,
    _resolve_subtasks_for_start_execution,
    _subtask_dep_ids,
    assign_default_refs_to_batch,
    next_subtask_ref_for_append,
    normalize_depends_on_at_create,
    resolve_explicit_subtask_tokens,
)
from evoflow.tools.builtins.supervisor.display import (  # noqa: F401
    _build_monitor_subtask_rows,
    _subtask_row_dict,
    _subtask_worker_profile_suffix,
)
from evoflow.tools.builtins.supervisor.execution import (  # noqa: F401
    _resolved_subagent_type_for_subtask,
    auto_delegate_collab_followup_wave,
    delegate_collab_subtasks_for_start_execution,
)
from evoflow.tools.builtins.supervisor.memory import (  # noqa: F401
    _broadcast_task_event,
    _persist_main_task_memory_snapshot,
    _record_supervisor_ui_step,
)
from evoflow.tools.builtins.supervisor.monitor import (  # noqa: F401
    _compute_monitor_recommendation,
    _ensure_background_task_monitor,
    _monitor_main_task_until_terminal,
    _requeue_and_redispatch_timed_out_subtasks_once,
)
from evoflow.tools.builtins.supervisor.orchestration_hints import merge_orchestration_hints
from evoflow.tools.builtins.supervisor.utils import (  # noqa: F401
    _clamp_progress,
    _dbg_enabled,
    _repr_with_invisibles,
    _runtime_thread_id,
    resolve_supervisor_task_subtask_ids,
)

logger = logging.getLogger(__name__)

_STATUS_ZH_MAP: dict[str, str] = {
    "inbox": "待办",
    "pending": "等待中",
    "planned": "已规划",
    "planning": "规划中",
    "executing": "处理中",
    "waiting_dispatch": "等待派发",
    "waiting_user": "等待用户输入",
    "awaiting_close": "待闭环",
    "reviewed": "已完成",
    "running": "处理中",
    "in_progress": "处理中",
    "completed": "已完成",
    "failed": "失败",
    "cancelled": "已取消",
    "timed_out": "超时",
}


def _status_zh(v: str | None) -> str:
    s = str(v or "").strip().lower()
    return _STATUS_ZH_MAP.get(s, "未知")


def _mark_collab_phase_done_for_task(task: dict[str, Any], runtime: ToolRuntime[ContextT, dict] | None) -> None:
    """When main task reaches terminal, set collab phase to done to stop forced monitor loop."""
    task_id = str(task.get("id") or "").strip()
    if not task_id:
        return
    try:
        from evoflow.collab.thread_collab import finalize_collab_phase_on_main_terminal
        from evoflow.tools.builtins.supervisor.execution import unregister_collab_lead_runtime

        finalize_collab_phase_on_main_terminal(
            get_paths(),
            task_id,
            runtime_thread_id=_runtime_thread_id(runtime),
        )
        unregister_collab_lead_runtime(task_id)
    except Exception:
        logger.warning("failed to mark collab phase done task_id=%s", task_id, exc_info=True)


_ALLOWED_TASK_STATES = {
    "inbox",
    "pending",
    "planned",
    "planning",
    "executing",
    "waiting_dispatch",
    "waiting_user",
    "awaiting_close",
    "reviewed",
    "completed",
    "failed",
    "cancelled",
}

_TASK_STATE_TRANSITIONS: dict[str, set[str]] = {
    # 随手待办：分配/升级 → pending；用户勾完成 / 取消
    "inbox": {"pending", "completed", "cancelled"},
    "pending": {"planned", "planning", "executing", "waiting_user", "cancelled"},
    "planned": {"planning", "executing", "cancelled"},
    "planning": {"executing", "waiting_user", "failed", "cancelled"},
    "executing": {
        "waiting_dispatch",
        "waiting_user",
        "awaiting_close",
        "reviewed",
        "completed",
        "failed",
        "cancelled",
    },
    # waiting_dispatch means "needs next dispatch decision", but monitoring can continue.
    "waiting_dispatch": {
        "executing",
        "waiting_user",
        "awaiting_close",
        "completed",
        "failed",
        "cancelled",
    },
    "waiting_user": {"executing", "cancelled", "failed"},
    # 本岗已交、整单未验收关闭；可验收 completed / 失败 / 返工回 executing
    "awaiting_close": {"completed", "failed", "cancelled", "executing"},
    # reviewed kept for legacy rows; treat as terminal success (maps to completed on write)
    "reviewed": set(),
    "completed": set(),
    "failed": set(),
    "cancelled": set(),
}


def _normalize_task_state(v: str | None) -> str:
    return str(v or "").strip().lower().replace("-", "_")


def _can_transition_task_state(current: str, target: str) -> bool:
    if current == target:
        return True
    allowed = _TASK_STATE_TRANSITIONS.get(current)
    if allowed is None:
        return False
    return target in allowed


def _subtask_status_counts(rows: list[dict[str, Any]]) -> dict[str, int]:
    counts = {
        "total": len(rows),
        "waiting": 0,
        "processing": 0,
        "completed": 0,
        "failed": 0,
        "cancelled": 0,
    }
    for r in rows:
        s = str(r.get("status") or "").strip().lower()
        if s in {"pending", "planned", "planning"}:
            counts["waiting"] += 1
        elif s in {"executing", "running", "in_progress", "waiting_dispatch"}:
            counts["processing"] += 1
        elif s == "waiting_user":
            counts["waiting"] += 1
        elif s == "completed":
            counts["completed"] += 1
        elif s == "failed":
            counts["failed"] += 1
        elif s == "cancelled":
            counts["cancelled"] += 1
    return counts


async def _auto_retry_timed_out_subtasks_once(
    runtime: ToolRuntime[ContextT, dict] | None,
    storage: Any,
    task_id: str,
    *,
    max_retries_per_subtask: int = 1,
) -> dict[str, Any]:
    """Auto-retry timed out subtasks once during monitor polling."""
    return await _requeue_and_redispatch_timed_out_subtasks_once(
        storage,
        task_id,
        runtime=runtime,
        max_retries_per_subtask=max_retries_per_subtask,
        retry_reason="monitor_detected_timeout",
        trace_source="monitor_execution_step",
    )


def _acp_session_summary_for_task(task_id: str) -> dict[str, Any]:
    try:
        from evoflow.tools.builtins.supervisor.acp_session_registry import list_by_task

        sessions = list_by_task(task_id)
        active = 0
        for s in sessions:
            st = str(s.get("status") or "").strip().lower()
            if st in {"starting", "running", "streaming", "waiting_input"}:
                active += 1
        return {
            "count": len(sessions),
            "activeCount": active,
            "sessions": sessions,
        }
    except Exception:
        logger.debug("acp session summary failed", exc_info=True)
        return {"count": 0, "activeCount": 0, "sessions": []}


def _worker_display_name_for_ui(assigned_to: str | None) -> str | None:
    """Map stored ``assigned_to`` (agent_code) to UI ``agent_name``."""
    return display_name_for_agent_code(assigned_to)


def _assigned_worker_from_subtask_spec(spec: dict[str, Any]) -> str | None:
    """Resolve assignee from batch subtask dict (supports agent_code-style aliases)."""
    for key in ("assigned_agent", "assigned_agent_code", "assignedAgentCode", "assignedTo"):
        raw = spec.get(key)
        if raw is None:
            continue
        s = str(raw).strip()
        if s:
            return s
    return None


# ── Module-level state (shared across action handler + monitors) ─────
_MONITOR_TERMINAL_MAIN = frozenset({"completed", "failed", "cancelled"})
_bg_task_monitors: dict[str, asyncio.Task[Any]] = {}
_task_watch_state: dict[str, dict[str, Any]] = {}


async def _save_conversation_to_task(
    runtime: ToolRuntime[Any, Any] | None,
    task_id: str,
) -> bool:
    """Bind lead thread to task and verify chat transcript is reachable."""
    tid = str(task_id or "").strip()
    if not tid:
        return False
    thread_id = _runtime_thread_id(runtime)
    if not thread_id:
        logger.debug("[_save_conversation_to_task] No thread_id in runtime, skipping")
        return False
    try:
        from evoflow.collab.conversation_persist import reconcile_lead_conversation_from_chat
        from evoflow.collab.storage import get_project_storage

        storage = get_project_storage()
        count = reconcile_lead_conversation_from_chat(storage, tid, thread_id)
        logger.info(
            "[_save_conversation_to_task] Reconciled thread %s -> task %s (%d chat messages)",
            thread_id,
            tid,
            count,
        )
        return True
    except Exception as e:
        logger.warning(f"[_save_conversation_to_task] Error saving conversation for task {tid}: {e}")
        return False


# ════════════════════════════════════════════════════════════════════
#  Thin routing layer — @tool decorator + action dispatch
# ════════════════════════════════════════════════════════════════════


@tool("supervisor", parse_docstring=True)
async def supervisor_tool(
    runtime: ToolRuntime[ContextT, dict],
    action: str,
    tool_call_id: Annotated[str, InjectedToolCallId],
    task_name: str | None = None,
    task_description: str | None = None,
    subtask_name: str | None = None,
    subtask_description: str | None = None,
    task_id: str | None = None,
    subtask_id: str | None = None,
    assigned_agent: str | None = None,
    assigned_agent_code: str | None = None,
    subtasks: Any = None,
    subtask_ids: Any = None,
    progress: int | None = None,
    status: str | None = None,
    memory_key_agent_id: str | None = None,
    authorized_by: str | None = None,
    worker_profile_json: str | None = None,
    project_path: str | None = None,
    monitor_poll_seconds: int = 20,
    monitor_timeout_seconds: int | None = None,
    monitor_step_seconds: int = 10,
    monitor_detail: str = "compact",
    agent_message: str | None = None,
    read_lines: int = 200,
    keep_session_open: bool = True,
    wait_for_completion: bool = False,
    work_checklist: Any = None,
) -> str:
    """Orchestrate multi-agent tasks / subtasks (not a substitute for `subagent`).

    **Plan collaboration gate (when plan scenario is active — read first)**
    - Order: succeed with **`plan(goal=…, steps=[…])`** → user clicks「开始执行」
      (gateway authorizes **and auto-dispatches** wave 1). You usually **monitor**, not start.
    - Keep `start_execution` for fallback (wave never started), re-dispatch, or mid-flight waves.
      Errors before auth: `need_plan_first` / `need_execution_authorization`.
    - Pre-plan recon → **`subagent`** (read-only); not supervisor-as-planning.
    - Mid-flight extra Step only: `create_subtask`. Outside plan: `create_task_with_subtasks`
      with numeric `depends_on` refs (`["1"]`, `["2"]`, …) — never display names.

    **Typical plan execution loop (after UI start)**
    1. Confirm workers are running (`get_status` / `monitor_execution_step`).
    2. On failure: `continue_subtask_session` / `retry_subtask` / `start_execution` as needed.
    3. Workers report via `subtask_progress_report` / `subtask_outcome_report`.
    4. After all subtasks done: run Plan `validation`, then close main with
       `update_progress(100, completed)` or `set_task_state(completed)`.
    Backend auto-syncs main progress from subtask averages (cap 99%) — you still
    finalize the main task after validation.

    Args:
        action: One of create_task, create_task_with_subtasks, create_subtask, create_subtasks, update_progress,
            complete_subtask, start_execution, retry_subtask, continue_subtask_session, set_subtask_work_checklist,
            monitor_execution_step, get_status,
            get_subtask_conversation, interrupt_subtask, steer_subtask,
            list_subtasks, set_task_planned, set_task_state.
        task_name: Name for a new task (required for create_task, create_task_with_subtasks).
        task_description: Description for a new task (required and should be detailed for create_task, create_task_with_subtasks).
        subtask_name: Name for a new subtask (required for create_subtask).
        subtask_description: Description for a new subtask (optional for create_subtask).
        task_id: Main task id (required for create_subtask, get_status, get_subtask_conversation, list_subtasks, set_task_planned).
        subtask_id: ID of an existing subtask (required for complete_subtask/retry_subtask/interrupt_subtask/
            steer_subtask/get_subtask_conversation; optional for update_progress when updating main task).
        assigned_agent: Worker id for create_subtask (optional): a built-in subagent template **or** an ``agent_code``
            from ``list_agents()`` / ``agents/*/config.yaml`` (same value stored as ``assigned_to`` / ``task(subagent_type=...)``).
            When used with `action="create_subtask"`, the new subtask will be created already assigned (create+assign).
            Must be selected from `list_agents()` and capability-matched to subtask content.
            Prefer `code-agent` for code/project work (coding, debugging, refactor, file/repo changes).
            Do not assign `claude-code` unless the user explicitly asks for the Claude Code main-chat preset.
        assigned_agent_code: Same as ``assigned_agent`` (preferred when models/tools use the API field name ``agent_code``).
        subtasks: For create_task_with_subtasks or create_subtasks: list of subtask objects.
            Each item must include a name; optional fields include description, assigned_agent or assigned_agent_code,
            ref (optional; default auto 1,2,3 by array order),
            per-subtask depends_on list uses numeric upstream refs (1, 2, …) only, never display names,
            project_path (optional workspace path), and worker_profile_json (a JSON string for worker constraints).
            Nested profile keys mirror the YAML worker profile; do not inject a per-subtask chat model override unless the user explicitly asks for it (defaults follow the session chat model).
        subtask_ids: For start_execution: optional; if set, only these ids are *considered*
            (must exist on the task). Each subtask actually delegated must still be assigned,
            non-terminal, and have every `worker_profile.depends_on` upstream in `completed`.
            Ready ids in the allowed set run in parallel in one call; others appear in
            `blockedSubtasks` in the JSON result. If omitted/empty after normalize, the tool
            auto-picks every assigned non-terminal subtask whose dependencies are satisfied
            (same parallel batch); still-waiting subtasks are listed in `blockedSubtasks`.
        progress: Progress 0-100 (required for update_progress).
        status: Optional status for update_progress or set_task_state (allowed for set_task_state: pending/planned/planning/executing/waiting_dispatch/waiting_user/reviewed/completed/failed/cancelled).
        memory_key_agent_id: Deprecated alias for ``subtask_id`` on ``get_subtask_conversation``.
        authorized_by: Recorded on authorize/start_execution (default lead for start_execution).
        worker_profile_json: Optional JSON object string for create_subtask (worker constraints). Include
            `base_subagent` and `tools` (allowlist) when the Step needs specific capabilities—query
            `list_assignable_tools` for valid tool names. Do not add a per-subtask chat model override unless the user explicitly requests it.
        project_path: Optional workspace path for subtask execution.
        monitor_poll_seconds: For monitor_execution_step only. Poll interval in seconds.
        monitor_timeout_seconds: Used by start_execution auto-follow loop timeout control.
        monitor_step_seconds: For monitor_execution_step only. How long (max) to wait before returning a snapshot.
        monitor_detail: For monitor_execution_step only. `compact` (default) returns
            minimal status payload during non-terminal polling; `full` returns full subtasks/memory payload.
        agent_message: For ``steer_subtask`` / ``continue_subtask_session``, message to send to the worker.
            For ``interrupt_subtask``, optional reason recorded on the subtask row.
            When ``action`` is ``retry_subtask``, pass failure context for the retried subtask (e.g. test failure logs, error details).
            The message is stored as ``retry_reason`` on the subtask and injected into the subagent prompt.
        read_lines: For continue_subtask_session only. Max response lines returned from session read.
        keep_session_open: For continue_subtask_session only. When true (default), do not close the worker session
            and keep the subtask in_progress for further follow-ups; when false, close the session and mark terminal.
        work_checklist: Optional. For ``set_subtask_work_checklist`` only (Lead override / rare); workers normally
            use ``subtask_work_checklist``. May also be set on ``subtasks[]`` at create time if pre-seeded.
    """
    # Delay import to avoid circular imports when subagent_runner loads executor

    # Valid assignees: built-in subagent templates plus filesystem subagents (agent_code) merged in the registry.
    available_agents = get_available_subagent_names()
    acp_agent_names: set[str] = set()
    try:
        from evoflow.config.acp_config import get_acp_agents

        acp_agent_names = {str(k or "").strip().lower().replace("_", "-") for k in (get_acp_agents() or {}).keys() if str(k or "").strip()}
    except Exception:
        acp_agent_names = set()
    if not acp_agent_names:
        # Fallback to root config.yaml for ACP workers when runtime cache is not populated.
        try:
            import yaml

            cfg_path = Path(__file__).resolve().parents[6] / "config.yaml"
            data = yaml.safe_load(cfg_path.read_text(encoding="utf-8")) or {}
            acp = data.get("acp_agents") or {}
            if isinstance(acp, dict):
                acp_agent_names = {str(k or "").strip().lower().replace("_", "-") for k in acp.keys() if str(k or "").strip()}
        except Exception:
            acp_agent_names = set()
    storage = get_project_storage()

    def _is_supported_worker(agent_name: str | None) -> bool:
        n = str(agent_name or "").strip()
        if not n:
            return False
        if n in available_agents:
            return True
        norm = n.lower().replace("_", "-")
        return norm in {"claude-code", "claude-session", "claude"} or norm in acp_agent_names

    # Normalize ids to avoid mismatches caused by model/tool serialization adding
    # accidental whitespace (e.g. "ccd29719 " or "ccd29719\n").
    def _norm_id(v: str | None) -> str | None:
        if v is None:
            return None
        return v.strip() if isinstance(v, str) else str(v).strip()

    task_id = _norm_id(task_id)
    subtask_id = _norm_id(subtask_id)
    memory_key_agent_id = _norm_id(memory_key_agent_id)
    assigned_agent = _norm_id(assigned_agent) or _norm_id(assigned_agent_code)

    def _coerce_list_arg(raw: Any) -> list[Any] | None:
        if raw is None:
            return None
        if isinstance(raw, list):
            return raw
        if isinstance(raw, str):
            s = raw.strip()
            if not s:
                return None
            try:
                parsed = json.loads(s)
            except Exception:
                return None
            return parsed if isinstance(parsed, list) else None
        return None

    subtasks = _coerce_list_arg(subtasks)
    if subtasks is not None and not isinstance(subtasks, list):
        subtasks = None
    subtask_ids = _coerce_list_arg(subtask_ids)
    if subtask_ids is not None:
        _sid_clean: list[str] = []
        for _s in subtask_ids:
            _n = _norm_id(_s) if _s is not None else None
            if _n:
                _sid_clean.append(_n)
        subtask_ids = _sid_clean or None
    monitor_detail = str(monitor_detail or "compact").strip().lower()
    if monitor_detail not in {"compact", "full"}:
        monitor_detail = "compact"

    _COLLAB_SCOPED_ACTIONS = {
        "complete_subtask",
        "continue_subtask_session",
        "get_subtask_conversation",
        "get_task_memory",
        "interrupt_subtask",
        "retry_subtask",
        "set_subtask_work_checklist",
        "steer_subtask",
    }
    if action in _COLLAB_SCOPED_ACTIONS:
        task_id, subtask_id = resolve_supervisor_task_subtask_ids(storage, runtime, task_id, subtask_id)

    def _validate_task_description_for_creation(desc: str | None) -> str | None:
        text = str(desc or "").strip()
        if not text:
            return "task_description is required and must clearly include goal, scope, and expected output (at least 20 characters)"
        if len(text) < 20:
            return "task_description is too short; please provide a detailed requirement including goal, scope, and expected output (at least 20 characters)"
        return None

    if _dbg_enabled(runtime):
        try:
            storage_dir = getattr(storage, "_storage_dir", None)
        except Exception:
            storage_dir = "<error>"
        logger.warning(
            "supervisor_tool(debug): action=%s tool_call_id=%s runtime_thread_id=%s task_id=%s(%s) subtask_id=%s(%s) assigned_agent=%s(%s) storage_dir=%r available_agents=%r",
            action,
            tool_call_id,
            _runtime_thread_id(runtime),
            task_id,
            _repr_with_invisibles(task_id),
            subtask_id,
            _repr_with_invisibles(subtask_id),
            assigned_agent,
            _repr_with_invisibles(assigned_agent),
            str(storage_dir),
            list(available_agents),
        )

    act = str(action or "").strip()
    from evoflow.collab.supervisor_plan_gate import check_supervisor_collab_gate

    _rt_tid = _runtime_thread_id(runtime)
    gate_payload = check_supervisor_collab_gate(act, _rt_tid, task_id=task_id, storage=storage)
    if gate_payload is not None:
        return json.dumps(gate_payload, ensure_ascii=False)

    # ── Action: create_task ───────────────────────────────────────────
    if action == "create_task":
        if not task_name:
            return json.dumps({"success": False, "action": "create_task", "error": "task_name is required for create_task action"}, ensure_ascii=False)
        desc_error = _validate_task_description_for_creation(task_description)
        if desc_error:
            return json.dumps(
                {
                    "success": False,
                    "action": "create_task",
                    "error": desc_error,
                },
                ensure_ascii=False,
            )

        bound_thread = _runtime_thread_id(runtime)
        from evoflow.collab.plan_session_task import try_reuse_bound_plan_root_task

        reused = try_reuse_bound_plan_root_task(
            storage,
            bound_thread,
            task_name,
            str(task_description or "").strip(),
        )
        if reused:
            project_data, task_data = reused
        else:
            project_data, task_data = new_project_bundle_root_task(
                task_name,
                str(task_description or "").strip(),
                thread_id=bound_thread,
            )
        bp_meta = attach_bound_plan_from_mission_state(task_data, bound_thread)
        if bp_meta.get("attached"):
            try:
                write_cycle_trace(
                    "supervisor_root_task_bound_plan",
                    {
                        "thread_id": bound_thread,
                        "task_id": str(task_data.get("id") or ""),
                        "plan_goal_len": bp_meta.get("plan_goal_len"),
                        "plan_step_count": bp_meta.get("plan_step_count"),
                        "plan_bound_ts_ms": bp_meta.get("plan_bound_ts_ms"),
                    },
                )
            except Exception:
                pass

        if storage.save_project(project_data):
            if bound_thread and task_data.get("id"):
                try:
                    paths = get_paths()
                    cur = load_thread_collab_state(paths, bound_thread)
                    save_thread_collab_state(
                        paths,
                        bound_thread,
                        merge_thread_collab_state(cur, {"bound_task_id": str(task_data["id"])}),
                    )
                except Exception:
                    pass
            logger.info(f"Created task '{task_name}' with ID: {task_data['id']}")
            try:
                from evoflow.debug.task_lifecycle_trace import write_task_lifecycle_trace

                write_task_lifecycle_trace(
                    thread_id=bound_thread,
                    event="main_task_created",
                    main_task_id=str(task_data.get("id") or ""),
                    status="pending",
                    detail={"source": "supervisor", "action": "create_task", "name": task_name},
                )
            except Exception:
                pass

            result = {
                "success": True,
                "taskId": task_data["id"],
                "name": task_name,
                "description": str(task_description or "").strip(),
                "status": "pending",
                "statusZh": _status_zh("pending"),
            }
            _record_supervisor_ui_step(runtime, tool_call_id, "create_task", f"创建主任务：{task_name}")
            return json.dumps(result, ensure_ascii=False)
        return json.dumps({"success": False, "action": "create_task", "error": "Failed to create task"}, ensure_ascii=False)

    # ── Action: create_task_with_subtasks (one-shot) ──────────────────
    elif action == "create_task_with_subtasks":
        if not task_name:
            return json.dumps({"success": False, "action": "create_task_with_subtasks", "error": "task_name is required for create_task_with_subtasks action"}, ensure_ascii=False)
        desc_error = _validate_task_description_for_creation(task_description)
        if desc_error:
            return json.dumps(
                {
                    "success": False,
                    "action": "create_task_with_subtasks",
                    "error": desc_error,
                },
                ensure_ascii=False,
            )
        if not subtasks or not isinstance(subtasks, list):
            return json.dumps({"success": False, "action": "create_task_with_subtasks", "error": "subtasks (array) is required for create_task_with_subtasks action"}, ensure_ascii=False)

        bound_thread = _runtime_thread_id(runtime)
        from evoflow.collab.plan_session_task import try_reuse_bound_plan_root_task

        reused = try_reuse_bound_plan_root_task(
            storage,
            bound_thread,
            task_name,
            str(task_description or "").strip(),
        )
        if reused:
            project_data, task_data = reused
        else:
            project_data, task_data = new_project_bundle_root_task(
                task_name,
                str(task_description or "").strip(),
                thread_id=bound_thread,
            )
        bp_meta = attach_bound_plan_from_mission_state(task_data, bound_thread)
        if bp_meta.get("attached"):
            try:
                write_cycle_trace(
                    "supervisor_root_task_bound_plan",
                    {
                        "thread_id": bound_thread,
                        "task_id": str(task_data.get("id") or ""),
                        "plan_goal_len": bp_meta.get("plan_goal_len"),
                        "plan_step_count": bp_meta.get("plan_step_count"),
                        "plan_bound_ts_ms": bp_meta.get("plan_bound_ts_ms"),
                    },
                )
            except Exception:
                pass

        # Reuse create_subtasks logic: delegate to the same branch with task_id set
        # so we don't duplicate ~300 lines of batch creation code.
        # We set task_id and fall through to create_subtasks branch.
        task_id = task_data["id"]
        # Mark that we need to save project_data (not reload from storage)
        _new_project_for_one_shot = project_data

        # Directly run the batch subtask creation on the in-memory task/project
        now = utc_now_iso_z()

        created: list[dict[str, Any]] = []
        errors: list[dict[str, Any]] = []

        def _parse_wp_json_one_shot(raw: str | None, *, default_base_subagent: str | None = None) -> dict | None:
            if raw is None:
                return None
            if not str(raw).strip():
                return None
            try:
                parsed = json.loads(raw)
            except json.JSONDecodeError:
                raise ValueError("worker_profile_json must be valid JSON")
            if not isinstance(parsed, dict):
                raise ValueError("worker_profile_json must be a JSON object")
            if default_base_subagent and not str(parsed.get("base_subagent") or "").strip():
                parsed = {**parsed, "base_subagent": str(default_base_subagent).strip()}
            wp = WorkerProfile.model_validate(parsed)
            return wp.to_storage_dict() or None

        # Two-phase batch creation
        batch_planned: list[dict[str, Any]] = []
        batch_name_index: dict[str, list[str]] = {}
        for idx, spec in enumerate(subtasks):
            if not isinstance(spec, dict):
                errors.append({"index": idx, "error": "subtasks[i] must be an object"})
                continue
            nm = str(spec.get("name") or spec.get("subtask_name") or "").strip()
            if not nm:
                errors.append({"index": idx, "error": "subtasks[i].name is required"})
                continue
            sid = make_subtask_id()
            row = {"index": idx, "spec": spec, "name": nm, "id": sid}
            batch_planned.append(row)
            batch_name_index.setdefault(nm, []).append(sid)

        _existing_st = [x for x in (task_data.get("subtasks") or []) if isinstance(x, dict)]
        assign_default_refs_to_batch(
            batch_planned,
            ref_offset=_max_numeric_subtask_ref(_existing_st),
        )
        batch_ref_to_id, batch_index_to_id, ref_dup_warnings = _build_batch_ref_and_index_maps(batch_planned)
        existing_ref_to_id = _build_existing_ref_to_id(_existing_st)

        existing_ids: set[str] = set()
        for st in _existing_st:
            _sid = str(st.get("id") or "").strip()
            if _sid:
                existing_ids.add(_sid)

        for row in batch_planned:
            idx = int(row["index"])
            spec = row["spec"]
            nm = str(row["name"])
            preallocated_id = str(row["id"])
            if not isinstance(spec, dict):
                errors.append({"index": idx, "error": "subtasks[i] must be an object"})
                continue
            desc = str(spec.get("description") or spec.get("subtask_description") or "").strip()
            agent = _assigned_worker_from_subtask_spec(spec) if isinstance(spec, dict) else None
            row_warnings: list[dict[str, Any]] = [w for w in ref_dup_warnings if int(w.get("index", -1)) == idx]
            spec_ref = str(row.get("ref") or "").strip()
            if agent and not _is_supported_worker(agent):
                row_warnings.append(
                    {
                        "index": idx,
                        "name": nm,
                        "warning": (f"Unknown worker agent '{agent}' (subtask created unassigned). Use agent_code from list_agents() or a built-in template."),
                        "availableSubagents": list(available_agents),
                    }
                )
                agent = None
            wp_raw = spec.get("worker_profile_json")
            try:
                worker_profile = _parse_wp_json_one_shot(
                    str(wp_raw) if wp_raw is not None else None,
                    default_base_subagent=agent,
                )
            except (ValidationError, ValueError) as e:
                errors.append({"index": idx, "name": nm, "error": str(e)})
                continue

            # Friendly spec fields
            direct_dep = _extract_dep_refs_from_subtask_spec(spec)
            direct_instr = spec.get("instruction")
            direct_tools = spec.get("tools")
            direct_skills = spec.get("skills")
            direct_model = spec.get("model")
            has_direct_profile = any(x is not None for x in [direct_dep, direct_instr, direct_tools, direct_skills, direct_model])
            if has_direct_profile:
                wp_obj: dict[str, Any] = dict(worker_profile or {})
                if direct_dep is not None:
                    if isinstance(direct_dep, list):
                        wp_obj["depends_on"] = [str(x).strip() for x in direct_dep if str(x).strip()]
                    else:
                        row_warnings.append(
                            {
                                "index": idx,
                                "name": nm,
                                "warning": "subtasks[i].depends_on/dependencies must be an array; ignored",
                            }
                        )
                if isinstance(direct_instr, str) and direct_instr.strip():
                    wp_obj["instruction"] = direct_instr.strip()
                if isinstance(direct_tools, list):
                    wp_obj["tools"] = [str(x).strip() for x in direct_tools if str(x).strip()]
                if isinstance(direct_skills, list):
                    wp_obj["skills"] = [str(x).strip() for x in direct_skills if str(x).strip()]
                if isinstance(direct_model, str) and direct_model.strip():
                    wp_obj["model"] = direct_model.strip()
                # depends_on / tools 等「直写字段」合成 profile 时，assigned_to 可能为空；
                # WorkerProfile 仍要求 base_subagent — 与下行兜底一致默认 general-purpose。
                if not str(wp_obj.get("base_subagent") or "").strip():
                    wp_obj["base_subagent"] = (str(agent).strip() if agent else "") or "general-purpose"
                try:
                    wp_valid = WorkerProfile.model_validate(wp_obj)
                    worker_profile = wp_valid.to_storage_dict() or None
                except ValidationError as e:
                    errors.append({"index": idx, "name": nm, "error": f"direct worker profile: {e}"})
                    continue

            # Normalize depends_on (numeric ref / @index / #index / id -> Subtask_* id)
            if isinstance(worker_profile, dict):
                raw_dep = worker_profile.get("depends_on")
                if isinstance(raw_dep, list):
                    normalized_dep, unresolved_dep = normalize_depends_on_at_create(
                        raw_dep,
                        preallocated_id=preallocated_id,
                        existing_ids=existing_ids,
                        batch_planned=batch_planned,
                        batch_ref_to_id=batch_ref_to_id,
                        batch_index_to_id=batch_index_to_id,
                        existing_ref_to_id=existing_ref_to_id,
                    )
                    worker_profile = dict(worker_profile)
                    worker_profile["depends_on"] = normalized_dep
                    if unresolved_dep:
                        row_warnings.append(
                            {
                                "index": idx,
                                "name": nm,
                                "warning": "depends_on contains unresolved or ambiguous references (dropped)",
                                "droppedDependsOn": unresolved_dep,
                            }
                        )

            subtask_data: dict[str, Any] = {
                "id": preallocated_id,
                "name": nm,
                "description": desc,
                "status": "pending",
                "dependencies": [],
                "assigned_to": agent,
                "result": None,
                "error": None,
                "created_at": now,
                "started_at": None,
                "completed_at": None,
                "progress": 0,
            }
            if spec_ref:
                subtask_data["ref"] = spec_ref
            sub_project_path = str(spec.get("project_path") or "").strip()
            if sub_project_path:
                subtask_data["project_path"] = sub_project_path
            if worker_profile is not None:
                subtask_data["worker_profile"] = worker_profile
                if not subtask_data.get("assigned_to"):
                    bs = str(worker_profile.get("base_subagent") or "").strip()
                    if bs:
                        subtask_data["assigned_to"] = bs
            # Final safety-net: subtasks without assignment cannot be dispatched.
            if not subtask_data.get("assigned_to"):
                subtask_data["assigned_to"] = "general-purpose"

            task_data.setdefault("subtasks", []).append(subtask_data)
            _row: dict[str, Any] = {
                "subtaskId": subtask_data["id"],
                "subtaskIndex": idx,
                "name": nm,
                "description": desc,
                "parentTaskId": task_id,
                "status": "pending",
                "statusZh": _status_zh("pending"),
                **({"ref": spec_ref} if spec_ref else {}),
                **({"projectPath": subtask_data.get("project_path")} if subtask_data.get("project_path") else {}),
                **({"assignedTo": subtask_data["assigned_to"]} if subtask_data.get("assigned_to") else {}),
                **({"warnings": row_warnings} if row_warnings else {}),
            }
            _dn_batch = _worker_display_name_for_ui(subtask_data.get("assigned_to"))
            if _dn_batch:
                _row["assignedAgentName"] = _dn_batch
            created.append(_row)

        # Save once
        if storage.save_project(project_data):
            try:
                from evoflow.debug.task_lifecycle_trace import write_task_lifecycle_trace

                write_task_lifecycle_trace(
                    thread_id=bound_thread,
                    event="main_task_and_subtasks_created",
                    main_task_id=str(task_id),
                    status="pending",
                    detail={
                        "source": "supervisor",
                        "action": "create_task_with_subtasks",
                        "name": task_name,
                        "subtask_ids": [str(x.get("subtaskId") or "") for x in created if x.get("subtaskId")],
                        "subtask_count": len(created),
                        "error_count": len(errors),
                    },
                )
            except Exception:
                pass
            _record_supervisor_ui_step(runtime, tool_call_id, "create_task_with_subtasks", f"创建主任务和子任务：{task_name}，{len(created)} 个子任务")
            return json.dumps(
                {
                    "success": len(created) > 0,
                    "action": "create_task_with_subtasks",
                    "taskId": task_id,
                    "name": task_name,
                    "description": task_description or "",
                    "status": "pending",
                    "statusZh": _status_zh("pending"),
                    "created": created,
                    "errors": errors,
                },
                ensure_ascii=False,
            )

        return json.dumps({"success": False, "action": "create_task_with_subtasks", "error": "Failed to save project"}, ensure_ascii=False)

    # ── Action: create_subtasks (batch) ───────────────────────────────
    elif action == "create_subtasks":
        if not task_id:
            return json.dumps(
                {
                    "success": False,
                    "action": "create_subtasks",
                    "error": "task_id is required for create_subtasks action",
                },
                ensure_ascii=False,
            )
        if not subtasks or not isinstance(subtasks, list):
            return json.dumps(
                {
                    "success": False,
                    "action": "create_subtasks",
                    "error": "subtasks (array) is required for create_subtasks action",
                },
                ensure_ascii=False,
            )

        created: list[dict[str, Any]] = []
        errors: list[dict[str, Any]] = []

        def _normalize_depends_on_in_worker_profile(
            wp: dict[str, Any] | None,
            existing_subtasks: list[dict[str, Any]],
        ) -> tuple[dict[str, Any] | None, list[str]]:
            """Normalize worker_profile.depends_on from names/ids -> ids."""
            if not isinstance(wp, dict):
                return wp, []
            raw_dep = wp.get("depends_on")
            if not isinstance(raw_dep, list) or not raw_dep:
                return wp, []

            by_id: dict[str, dict[str, Any]] = {}
            by_name: dict[str, list[str]] = {}
            for st in existing_subtasks:
                if not isinstance(st, dict):
                    continue
                sid = str(st.get("id") or "").strip()
                if not sid:
                    continue
                by_id[sid] = st
                nm = str(st.get("name") or "").strip()
                if nm:
                    by_name.setdefault(nm, []).append(sid)

            normalized: list[str] = []
            unresolved: list[str] = []
            for dep in raw_dep:
                ref = str(dep or "").strip()
                if not ref:
                    continue
                if ref in by_id:
                    normalized.append(ref)
                    continue
                cands = by_name.get(ref) or []
                if len(cands) == 1:
                    normalized.append(cands[0])
                    continue
                unresolved.append(ref)

            if normalized == raw_dep:
                return wp, unresolved
            merged = dict(wp)
            merged["depends_on"] = normalized
            return merged, unresolved

        def _parse_wp_json(raw: str | None, *, default_base_subagent: str | None = None) -> dict | None:
            if raw is None:
                return None
            if not str(raw).strip():
                return None
            try:
                parsed = json.loads(raw)
            except json.JSONDecodeError:
                raise ValueError("worker_profile_json must be valid JSON")
            if not isinstance(parsed, dict):
                raise ValueError("worker_profile_json must be a JSON object")
            # Back-compat/UX: allow omitting base_subagent in worker_profile_json.
            # When absent, default it from the assigned worker (assigned_agent_code / assigned_agent).
            if default_base_subagent and not str(parsed.get("base_subagent") or "").strip():
                parsed = {**parsed, "base_subagent": str(default_base_subagent).strip()}
            wp = WorkerProfile.model_validate(parsed)
            return wp.to_storage_dict() or None

        projects = storage.list_projects()
        for project_summary in projects:
            project = storage.load_project(project_summary["id"])
            if not project:
                continue
            for i, task in enumerate(project.get("tasks", [])):
                if task.get("id") != task_id:
                    continue

                now = utc_now_iso_z()
                # Two-phase batch creation:
                # 1) pre-allocate ids for all valid specs in this batch
                # 2) resolve depends_on against (existing + this-batch) by id/name
                batch_planned: list[dict[str, Any]] = []
                batch_name_index: dict[str, list[str]] = {}
                for idx, spec in enumerate(subtasks):
                    if not isinstance(spec, dict):
                        errors.append({"index": idx, "error": "subtasks[i] must be an object"})
                        continue
                    nm = str(spec.get("name") or spec.get("subtask_name") or "").strip()
                    if not nm:
                        errors.append({"index": idx, "error": "subtasks[i].name is required"})
                        continue
                    sid = make_subtask_id()
                    row = {"index": idx, "spec": spec, "name": nm, "id": sid}
                    batch_planned.append(row)
                    batch_name_index.setdefault(nm, []).append(sid)

                _existing_st = [x for x in (task.get("subtasks") or []) if isinstance(x, dict)]
                assign_default_refs_to_batch(
                    batch_planned,
                    ref_offset=_max_numeric_subtask_ref(_existing_st),
                )
                batch_ref_to_id, batch_index_to_id, ref_dup_warnings = _build_batch_ref_and_index_maps(batch_planned)
                existing_ref_to_id = _build_existing_ref_to_id(_existing_st)

                existing_ids: set[str] = set()
                for st in _existing_st:
                    _sid = str(st.get("id") or "").strip()
                    if _sid:
                        existing_ids.add(_sid)

                for row in batch_planned:
                    idx = int(row["index"])
                    spec = row["spec"]
                    nm = str(row["name"])
                    preallocated_id = str(row["id"])
                    if not isinstance(spec, dict):
                        errors.append({"index": idx, "error": "subtasks[i] must be an object"})
                        continue
                    desc = str(spec.get("description") or spec.get("subtask_description") or "").strip()
                    agent = _assigned_worker_from_subtask_spec(spec) if isinstance(spec, dict) else None
                    # UX: Do not fail the row on unknown assignee.
                    # Create the subtask unassigned and return a warning so the lead agent
                    # can proceed without getting stuck in "Unknown agent" loops.
                    row_warnings: list[dict[str, Any]] = [w for w in ref_dup_warnings if int(w.get("index", -1)) == idx]
                    spec_ref = str(row.get("ref") or "").strip()
                    if agent and not _is_supported_worker(agent):
                        row_warnings.append(
                            {
                                "index": idx,
                                "name": nm,
                                "warning": (f"Unknown worker agent '{agent}' (subtask created unassigned). Use agent_code from list_agents() or a built-in template."),
                                "availableSubagents": list(available_agents),
                            }
                        )
                        agent = None
                    wp_raw = spec.get("worker_profile_json")
                    try:
                        worker_profile = _parse_wp_json(
                            str(wp_raw) if wp_raw is not None else None,
                            default_base_subagent=agent,
                        )
                    except (ValidationError, ValueError) as e:
                        errors.append({"index": idx, "name": nm, "error": str(e)})
                        continue

                    # Friendly spec fields: ref / @index / #index / id / name for depends_on.
                    direct_dep = _extract_dep_refs_from_subtask_spec(spec)
                    direct_instr = spec.get("instruction")
                    direct_tools = spec.get("tools")
                    direct_skills = spec.get("skills")
                    direct_model = spec.get("model")
                    has_direct_profile = any(x is not None for x in [direct_dep, direct_instr, direct_tools, direct_skills, direct_model])
                    if has_direct_profile:
                        wp_obj: dict[str, Any] = dict(worker_profile or {})
                        if direct_dep is not None:
                            if isinstance(direct_dep, list):
                                wp_obj["depends_on"] = [str(x).strip() for x in direct_dep if str(x).strip()]
                            else:
                                row_warnings.append(
                                    {
                                        "index": idx,
                                        "name": nm,
                                        "warning": "subtasks[i].depends_on/dependencies must be an array; ignored",
                                    }
                                )
                        if isinstance(direct_instr, str) and direct_instr.strip():
                            wp_obj["instruction"] = direct_instr.strip()
                        if isinstance(direct_tools, list):
                            wp_obj["tools"] = [str(x).strip() for x in direct_tools if str(x).strip()]
                        if isinstance(direct_skills, list):
                            wp_obj["skills"] = [str(x).strip() for x in direct_skills if str(x).strip()]
                        if isinstance(direct_model, str) and direct_model.strip():
                            wp_obj["model"] = direct_model.strip()
                        if not str(wp_obj.get("base_subagent") or "").strip():
                            wp_obj["base_subagent"] = (str(agent).strip() if agent else "") or "general-purpose"
                        try:
                            wp_valid = WorkerProfile.model_validate(wp_obj)
                            worker_profile = wp_valid.to_storage_dict() or None
                        except ValidationError as e:
                            errors.append({"index": idx, "name": nm, "error": f"direct worker profile: {e}"})
                            continue

                    if isinstance(worker_profile, dict):
                        raw_dep = worker_profile.get("depends_on")
                        if isinstance(raw_dep, list):
                            normalized_dep, unresolved_dep = normalize_depends_on_at_create(
                                raw_dep,
                                preallocated_id=preallocated_id,
                                existing_ids=existing_ids,
                                batch_planned=batch_planned,
                                batch_ref_to_id=batch_ref_to_id,
                                batch_index_to_id=batch_index_to_id,
                                existing_ref_to_id=existing_ref_to_id,
                            )
                            worker_profile = dict(worker_profile)
                            worker_profile["depends_on"] = normalized_dep
                            if unresolved_dep:
                                row_warnings.append(
                                    {
                                        "index": idx,
                                        "name": nm,
                                        "warning": "depends_on contains unresolved or ambiguous references (dropped)",
                                        "droppedDependsOn": unresolved_dep,
                                    }
                                )

                    subtask_data: dict[str, Any] = {
                        "id": preallocated_id,
                        "name": nm,
                        "description": desc,
                        "status": "pending",
                        "dependencies": [],
                        "assigned_to": agent,
                        "result": None,
                        "error": None,
                        "created_at": now,
                        "started_at": None,
                        "completed_at": None,
                        "progress": 0,
                    }
                    if spec_ref:
                        subtask_data["ref"] = spec_ref
                    sub_project_path = str(spec.get("project_path") or "").strip()
                    if sub_project_path:
                        subtask_data["project_path"] = sub_project_path
                    wc_spec = spec.get("work_checklist") or spec.get("work_todos") or spec.get("checklist")
                    if wc_spec is not None:
                        from evoflow.collab.work_checklist import normalize_checklist_items

                        subtask_data["work_checklist"] = normalize_checklist_items(wc_spec)
                    if worker_profile is not None:
                        subtask_data["worker_profile"] = worker_profile
                        # 若未显式 assigned_agent，且 profile 提供 base_subagent，则默认按 profile 分配
                        if not subtask_data.get("assigned_to"):
                            bs = str(worker_profile.get("base_subagent") or "").strip()
                            if bs:
                                subtask_data["assigned_to"] = bs
                    # Final safety-net: subtasks without assignment cannot be dispatched.
                    if not subtask_data.get("assigned_to"):
                        subtask_data["assigned_to"] = "general-purpose"

                    task.setdefault("subtasks", []).append(subtask_data)
                    _row: dict[str, Any] = {
                        "subtaskId": subtask_data["id"],
                        "subtaskIndex": idx,
                        "name": nm,
                        "description": desc,
                        "parentTaskId": task_id,
                        "status": "pending",
                        "statusZh": _status_zh("pending"),
                        **({"ref": spec_ref} if spec_ref else {}),
                        **({"projectPath": subtask_data.get("project_path")} if subtask_data.get("project_path") else {}),
                        **({"assignedTo": subtask_data["assigned_to"]} if subtask_data.get("assigned_to") else {}),
                        **({"warnings": row_warnings} if row_warnings else {}),
                    }
                    _dn_batch = _worker_display_name_for_ui(subtask_data.get("assigned_to"))
                    if _dn_batch:
                        _row["assignedAgentName"] = _dn_batch
                    created.append(_row)

                project["tasks"][i] = task
                storage.save_project(project)
                try:
                    from evoflow.debug.task_lifecycle_trace import write_task_lifecycle_trace

                    _tid_b = str(task.get("thread_id") or "").strip() or _runtime_thread_id(runtime)
                    write_task_lifecycle_trace(
                        thread_id=_tid_b,
                        event="subtasks_batch_created",
                        main_task_id=str(task_id),
                        detail={
                            "source": "supervisor",
                            "action": "create_subtasks",
                            "subtask_ids": [str(x.get("subtaskId") or "") for x in created],
                            "count": len(created),
                            "error_count": len(errors),
                        },
                    )
                except Exception:
                    pass
                _record_supervisor_ui_step(
                    runtime,
                    tool_call_id,
                    "create_subtasks",
                    f"批量创建子任务：{len(created)} 个",
                )
                return json.dumps(
                    {
                        "success": len(created) > 0,
                        "action": "create_subtasks",
                        "taskId": task_id,
                        "created": created,
                        "errors": errors,
                    },
                    ensure_ascii=False,
                )

        return json.dumps(
            {"success": False, "action": "create_subtasks", "error": f"Task '{task_id}' not found"},
            ensure_ascii=False,
        )

    # ── Action: create_subtask (single) ──────────────────────────────
    elif action == "create_subtask":
        if not task_id or not subtask_name:
            return json.dumps({"success": False, "action": "create_subtask", "error": "task_id and subtask_name are required for create_subtask action"}, ensure_ascii=False)
        warnings: list[dict[str, Any]] = []
        if assigned_agent and not _is_supported_worker(assigned_agent):
            warnings.append(
                {
                    "warning": (f"Unknown worker agent '{assigned_agent}' (subtask created unassigned). Use an agent_code from list_agents() or a built-in template."),
                    "availableSubagents": list(available_agents),
                }
            )
            assigned_agent = None

        worker_profile: dict | None = None
        if worker_profile_json and str(worker_profile_json).strip():
            try:
                parsed = json.loads(worker_profile_json)
            except json.JSONDecodeError:
                return json.dumps({"success": False, "action": "create_subtask", "error": "worker_profile_json must be valid JSON"}, ensure_ascii=False)
            if not isinstance(parsed, dict):
                return json.dumps({"success": False, "action": "create_subtask", "error": "worker_profile_json must be a JSON object"}, ensure_ascii=False)
            try:
                # Back-compat/UX: allow omitting base_subagent in worker_profile_json.
                if not str(parsed.get("base_subagent") or "").strip():
                    _bs = (str(assigned_agent).strip() if assigned_agent else "") or "general-purpose"
                    parsed = {**parsed, "base_subagent": _bs}
                wp = WorkerProfile.model_validate(parsed)
            except ValidationError as e:
                return json.dumps({"success": False, "action": "create_subtask", "error": f"worker_profile_json: {e}"}, ensure_ascii=False)
            worker_profile = wp.to_storage_dict() or None

        def _normalize_depends_on_in_worker_profile_single(
            wp: dict[str, Any] | None,
            existing_subtasks: list[dict[str, Any]],
        ) -> tuple[dict[str, Any] | None, list[str]]:
            if not isinstance(wp, dict):
                return wp, []
            raw_dep = wp.get("depends_on")
            if not isinstance(raw_dep, list) or not raw_dep:
                return wp, []
            existing_ids = {str(st.get("id") or "").strip() for st in existing_subtasks if isinstance(st, dict) and str(st.get("id") or "").strip()}
            normalized, unresolved = normalize_depends_on_at_create(
                raw_dep,
                preallocated_id="",
                existing_ids=existing_ids,
                batch_planned=[],
                batch_ref_to_id={},
                batch_index_to_id={},
                existing_ref_to_id=_build_existing_ref_to_id(existing_subtasks),
            )
            merged = dict(wp)
            merged["depends_on"] = normalized
            return merged, unresolved

        projects = storage.list_projects()
        task_found = False

        for project_summary in projects:
            project = storage.load_project(project_summary["id"])
            if project:
                for i, task in enumerate(project.get("tasks", [])):
                    if task.get("id") == task_id:
                        now = utc_now_iso_z()
                        _existing_st = [x for x in (task.get("subtasks") or []) if isinstance(x, dict)]
                        _new_ref = next_subtask_ref_for_append(_existing_st)
                        subtask_data = {
                            "id": make_subtask_id(),
                            "name": subtask_name,
                            "description": subtask_description or "",
                            "status": "pending",
                            "dependencies": [],
                            "ref": _new_ref,
                            "assigned_to": assigned_agent or None,
                            "result": None,
                            "error": None,
                            "created_at": now,
                            "started_at": None,
                            "completed_at": None,
                            "progress": 0,
                        }
                        if project_path and str(project_path).strip():
                            subtask_data["project_path"] = str(project_path).strip()
                        if worker_profile is not None:
                            worker_profile, unresolved_dep = _normalize_depends_on_in_worker_profile_single(
                                worker_profile,
                                _existing_st,
                            )
                            subtask_data["worker_profile"] = worker_profile
                            if unresolved_dep:
                                warnings.append(
                                    {
                                        "warning": "depends_on contains unresolved references (dropped)",
                                        "droppedDependsOn": unresolved_dep,
                                    }
                                )
                            bs = str(worker_profile.get("base_subagent") or "").strip()
                            if bs:
                                # 若未显式指定 assigned_agent，则默认用 profile.base_subagent
                                if not subtask_data.get("assigned_to"):
                                    subtask_data["assigned_to"] = bs

                        task.setdefault("subtasks", []).append(subtask_data)
                        project["tasks"][i] = task
                        storage.save_project(project)
                        try:
                            from evoflow.debug.task_lifecycle_trace import write_task_lifecycle_trace

                            _tid_s = str(task.get("thread_id") or "").strip() or _runtime_thread_id(runtime)
                            write_task_lifecycle_trace(
                                thread_id=_tid_s,
                                event="subtask_created",
                                main_task_id=str(task_id),
                                subtask_id=str(subtask_data.get("id") or ""),
                                status="pending",
                                detail={
                                    "source": "supervisor",
                                    "action": "create_subtask",
                                    "name": subtask_name,
                                },
                            )
                        except Exception:
                            pass
                        task_found = True
                        logger.info(f"Created subtask '{subtask_name}' in task {task_id}")

                        # 返回结构化的 JSON 格式
                        result = {
                            "success": True,
                            "action": "create_subtask",
                            "subtaskId": subtask_data["id"],
                            "ref": _new_ref,
                            "parentTaskId": task_id,
                            "name": subtask_name,
                            "description": subtask_description or "",
                            "status": "pending",
                            "statusZh": _status_zh("pending"),
                            **({"projectPath": subtask_data.get("project_path")} if subtask_data.get("project_path") else {}),
                            **({"assignedTo": subtask_data["assigned_to"]} if subtask_data.get("assigned_to") else {}),
                        }
                        _dn = _worker_display_name_for_ui(subtask_data.get("assigned_to"))
                        if _dn:
                            result["assignedAgentName"] = _dn
                        if warnings:
                            result["warnings"] = warnings
                        _record_supervisor_ui_step(
                            runtime,
                            tool_call_id,
                            "create_subtask",
                            f"创建子任务：{subtask_name}" + (f" → {subtask_data.get('assigned_to')}" if subtask_data.get("assigned_to") else ""),
                        )
                        return json.dumps(result, ensure_ascii=False)

        if not task_found:
            return json.dumps({"success": False, "action": "create_subtask", "error": f"Task '{task_id}' not found"}, ensure_ascii=False)

    # ── Action: update_progress ─────────────────────────────────────
    elif action == "update_progress":
        if not task_id:
            return json.dumps({"success": False, "action": "update_progress", "error": "task_id is required for update_progress action"}, ensure_ascii=False)
        if progress is None:
            return json.dumps({"success": False, "action": "update_progress", "error": "progress is required for update_progress action (0-100)"}, ensure_ascii=False)

        progress_value = _clamp_progress(progress)
        status_norm: str | None = None
        now: str | None = None
        if status is not None:
            status_norm = str(status).strip().lower()
            if status_norm in {"done"}:
                status_norm = "completed"
            if status_norm in {"error"}:
                status_norm = "failed"
            if status_norm in {"canceled"}:
                status_norm = "cancelled"
            if status_norm in {"executing", "running", "in_progress"}:
                status_norm = "in_progress"
            if status_norm in {"pending", "planning", "planned"}:
                status_norm = "in_progress"
            if status_norm in {"completed", "failed", "cancelled"}:
                now = utc_now_iso_z()

        effective_progress = 100 if status_norm == "completed" else progress_value

        projects = storage.list_projects()

        for project_summary in projects:
            project = storage.load_project(project_summary["id"])
            if project:
                for i, task in enumerate(project.get("tasks", [])):
                    if task.get("id") == task_id:
                        if subtask_id:
                            for j, subtask in enumerate(task.get("subtasks", [])):
                                if subtask.get("id") == subtask_id:
                                    if status_norm == "completed":
                                        subtask["status"] = "completed"
                                        subtask["progress"] = effective_progress
                                        if "completed_at" in subtask:
                                            subtask["completed_at"] = subtask.get("completed_at") or now
                                    elif status_norm == "failed":
                                        subtask["status"] = "failed"
                                        subtask["progress"] = effective_progress
                                        subtask["failed_at"] = subtask.get("failed_at") or now
                                    elif status_norm == "cancelled":
                                        subtask["status"] = "cancelled"
                                        subtask["progress"] = effective_progress
                                    elif status_norm:
                                        subtask["status"] = status_norm
                                        subtask["progress"] = effective_progress
                                    else:
                                        subtask["progress"] = progress_value
                                    task["subtasks"][j] = subtask
                                    project["tasks"][i] = task
                                    storage.save_project(project)
                                    # Root status convergence depends on all subtasks' terminal states.
                                    rollup_root_task_progress_from_subtasks(storage, task_id)
                                    await _broadcast_task_event(
                                        task_id,
                                        "task:progress",
                                        {
                                            "task_id": subtask_id,
                                            "progress": effective_progress,
                                            "current_step": "",
                                        },
                                    )

                                    # 返回结构化的 JSON 格式
                                    result = {
                                        "success": True,
                                        "action": "update_progress",
                                        "subtaskId": subtask_id,
                                        "taskId": task_id,
                                        "progress": effective_progress,
                                        "message": f"Updated progress of subtask {subtask_id} to {progress_value}%",
                                    }
                                    return json.dumps(result, ensure_ascii=False)
                            return json.dumps({"success": False, "action": "update_progress", "error": f"Subtask '{subtask_id}' not found"}, ensure_ascii=False)
                        task["progress"] = progress_value
                        if status_norm:
                            if status_norm == "completed":
                                task["status"] = "completed"
                                task["progress"] = effective_progress
                                if "completed_at" in task:
                                    task["completed_at"] = task.get("completed_at") or now
                            elif status_norm == "failed":
                                task["status"] = "failed"
                                if "failed_at" in task:
                                    task["failed_at"] = task.get("failed_at") or now
                            elif status_norm == "cancelled":
                                task["status"] = "cancelled"
                            else:
                                task["status"] = status_norm
                        project["tasks"][i] = task
                        storage.save_project(project)
                        _persist_main_task_memory_snapshot(project, task)
                        rollup_root_task_progress_from_subtasks(storage, task_id)
                        await _broadcast_task_event(
                            task_id,
                            "task:progress",
                            {
                                "task_id": task_id,
                                "progress": effective_progress,
                                "current_step": "",
                            },
                        )

                        # 返回结构化的 JSON 格式
                        result = {"success": True, "action": "update_progress", "taskId": task_id, "progress": effective_progress, "message": f"Updated progress of main task {task_id} to {effective_progress}%"}
                        _record_supervisor_ui_step(
                            runtime,
                            tool_call_id,
                            "update_progress",
                            f"主任务进度 {effective_progress}%",
                        )
                        return json.dumps(result, ensure_ascii=False)

        return json.dumps({"success": False, "action": "update_progress", "error": f"Task '{task_id}' not found"}, ensure_ascii=False)

    # ── Action: complete_subtask ─────────────────────────────────────
    elif action == "complete_subtask":
        if not task_id or not subtask_id:
            return json.dumps({"success": False, "action": "complete_subtask", "error": "task_id and subtask_id are required for complete_subtask action"}, ensure_ascii=False)

        projects = storage.list_projects()

        for project_summary in projects:
            project = storage.load_project(project_summary["id"])
            if project:
                for i, task in enumerate(project.get("tasks", [])):
                    if task.get("id") == task_id:
                        for j, subtask in enumerate(task.get("subtasks", [])):
                            if subtask.get("id") == subtask_id:
                                now = utc_now_iso_z()
                                subtask["status"] = "completed"
                                subtask["progress"] = 100
                                subtask["completed_at"] = now
                                task["subtasks"][j] = subtask
                                project["tasks"][i] = task
                                storage.save_project(project)
                                try:
                                    rollup_root_task_progress_from_subtasks(storage, task_id)
                                except Exception:
                                    logger.debug("complete_subtask: rollup progress failed task_id=%s", task_id, exc_info=True)
                                row_cs = find_main_task(storage, task_id)
                                if row_cs:
                                    project, task = row_cs
                                try:
                                    from evoflow.debug.task_lifecycle_trace import write_task_lifecycle_trace

                                    write_task_lifecycle_trace(
                                        thread_id=str(task.get("thread_id") or "").strip() or _runtime_thread_id(runtime),
                                        event="supervisor_complete_subtask",
                                        main_task_id=str(task_id),
                                        subtask_id=str(subtask_id),
                                        status="completed",
                                        detail={"source": "supervisor", "action": "complete_subtask"},
                                    )
                                except Exception:
                                    pass
                                await _broadcast_task_event(
                                    task_id,
                                    "task:completed",
                                    {"task_id": subtask_id, "result": subtask.get("result")},
                                )
                                facts_count = _persist_main_task_memory_snapshot(project, task)
                                await _broadcast_task_event(
                                    task_id,
                                    "task_detail:updated",
                                    {"task_id": task_id, "facts_count": facts_count},
                                )
                                if task.get("status") == "completed":
                                    await _broadcast_task_event(
                                        task_id,
                                        "task:completed",
                                        {"task_id": task_id, "result": task.get("result")},
                                    )
                                logger.info(f"Completed subtask {subtask_id}")

                                # 返回结构化的 JSON 格式
                                result = {"success": True, "action": "complete_subtask", "subtaskId": subtask_id, "taskId": task_id, "status": "completed", "message": f"Subtask {subtask_id} marked as completed"}
                                return json.dumps(result, ensure_ascii=False)
                        return json.dumps({"success": False, "action": "complete_subtask", "error": f"Subtask '{subtask_id}' not found in task '{task_id}'"}, ensure_ascii=False)
        return json.dumps({"success": False, "action": "complete_subtask", "error": f"Task '{task_id}' not found"}, ensure_ascii=False)

    # ── Action: start_execution ──────────────────────────────────────
    elif action == "start_execution":
        if not task_id:
            from evoflow.collab.supervisor_plan_gate import resolve_main_task_id_for_thread

            task_id = resolve_main_task_id_for_thread(_runtime_thread_id(runtime) or "")
        logger.info(f"[supervisor_tool] start_execution 开始: task_id={task_id}, authorized_by={authorized_by}")

        if not task_id:
            return json.dumps(
                {
                    "success": False,
                    "action": "start_execution",
                    "error": "task_id is required for start_execution action",
                    "hint": (
                        "Pass task_id from get_status / list_subtasks on this thread, "
                        "or ensure plan + create_task bound a main task to the thread."
                    ),
                },
                ensure_ascii=False,
            )
        if subtask_ids:
            row = find_main_task(storage, task_id)
            if not row:
                return json.dumps(
                    {
                        "success": False,
                        "action": "start_execution",
                        "taskId": task_id,
                        "error": f"Task '{task_id}' not found",
                    },
                    ensure_ascii=False,
                )
            _project, _task = row
            _resolved_ids, _unresolved = resolve_explicit_subtask_tokens(storage, task_id, subtask_ids)
            if _unresolved:
                ref_map = {
                    str(st.get("ref") or "").strip(): str(st.get("id") or "").strip()
                    for st in (_task.get("subtasks") or [])
                    if isinstance(st, dict) and str(st.get("ref") or "").strip()
                }
                return json.dumps(
                    {
                        "success": False,
                        "action": "start_execution",
                        "taskId": task_id,
                        "error": f"Subtask id(s) not under this task: {_unresolved}",
                        "hint": (
                            "Use subtaskId from plan() subtasksSync (Subtask_YYYYMMDDHHMMSS_xxxxxx), "
                            "or plan step ref (e.g. \"1\"). Omit subtask_ids to run the next runnable wave."
                        ),
                        "stepRefToSubtaskId": ref_map,
                    },
                    ensure_ascii=False,
                )
            subtask_ids = _resolved_ids

        from evoflow.collab.authorize_execution import (
            ensure_task_execution_authorized_for_user,
            resolve_thread_id_for_task,
        )
        from evoflow.collab.supervisor_plan_gate import build_supervisor_gate_error

        def _messages_from_runtime() -> list[Any] | None:
            if runtime is None:
                return None
            state = getattr(runtime, "state", None)
            if isinstance(state, dict):
                msgs = state.get("messages")
                return msgs if isinstance(msgs, list) else None
            return None

        run_thread = resolve_thread_id_for_task(
            storage,
            task_id,
            thread_id_hint=_runtime_thread_id(runtime) or "",
        )
        auth_ok, auth_detail = ensure_task_execution_authorized_for_user(
            storage,
            task_id,
            thread_id=run_thread,
            messages=_messages_from_runtime(),
        )
        if not auth_ok:
            err = build_supervisor_gate_error(
                action="start_execution",
                error_code="need_execution_authorization",
                message=auth_detail,
            )
            return json.dumps({**err, "taskId": task_id}, ensure_ascii=False)

        from evoflow.collab.plan_subtasks_sync import ensure_subtasks_synced_before_start_execution

        subtasks_sync_meta = ensure_subtasks_synced_before_start_execution(task_id, storage=storage)
        if subtasks_sync_meta.get("attempted"):
            logger.info(
                "[supervisor_tool] start_execution subtasks pre-sync task_id=%s before=%s after=%s steps=%s reason=%s",
                task_id,
                subtasks_sync_meta.get("subtaskCountBefore"),
                subtasks_sync_meta.get("subtaskCountAfter"),
                subtasks_sync_meta.get("planStepCount"),
                subtasks_sync_meta.get("reason"),
            )

        logger.info("[supervisor_tool] 正在解析可执行的子任务")
        to_run, blocked_subtasks = _resolve_subtasks_for_start_execution(storage, task_id, subtask_ids)
        logger.info(f"[supervisor_tool] 解析完成: 可执行={len(to_run) if to_run else 0}, 被阻塞={len(blocked_subtasks) if blocked_subtasks else 0}")
        if to_run:
            logger.info(f"[supervisor_tool] 正在标记 {len(to_run)} 个子任务为已启动")

            _now = utc_now_iso_z()
            row_mark = find_main_task(storage, task_id)
            if row_mark:
                proj_mark, t_mark = row_mark
                to_set = set(to_run)
                for st in t_mark.get("subtasks") or []:
                    if st.get("id") in to_set:
                        st["started_at"] = st.get("started_at") or _now
                main_status = str(t_mark.get("status") or "").strip().lower()
                if main_status in {"planned", "planning", "pending", "awaiting_exec", "waiting_dispatch"}:
                    t_mark["status"] = "executing"
                    t_mark["started_at"] = t_mark.get("started_at") or _now
                t_mark["updated_at"] = _now
                storage.save_project(proj_mark)
                logger.info("[supervisor_tool] 子任务启动时间已保存")

        # 与 HTTP authorize-execution 对齐：必须把该聊天线程的 collab_phase 推进到 executing，
        # 否则 CollabPhaseMiddleware 仍提示「等待执行」。随后对本批子任务并行调用 task 工具，子智能体开始实际执行。
        logger.info("[supervisor_tool] 正在推进协作阶段到 executing")
        phase_ok = False
        try:
            phase_ok = advance_collab_phase_to_executing_for_task(get_paths(), task_id, runtime_thread_id=_runtime_thread_id(runtime))
            logger.info(f"[supervisor_tool] 协作阶段推进{'成功' if phase_ok else '失败'}")
        except Exception:
            logger.exception("start_execution: advance_collab_phase_to_executing_for_task failed for task_id=%s", task_id)

        delegated: list[dict[str, Any]] = []
        if to_run:
            logger.info(f"[supervisor_tool] 正在委派 {len(to_run)} 个子任务给子智能体执行")
            try:
                delegated = await delegate_collab_subtasks_for_start_execution(
                    runtime,
                    storage,
                    task_id,
                    to_run,
                )
                logger.info(f"[supervisor_tool] 子任务委派完成，成功={sum(1 for d in delegated if d.get('ok'))}/{len(delegated)}")
            except Exception as exc:
                logger.exception("start_execution: delegate_collab_subtasks_for_start_execution failed task_id=%s", task_id)
                _err_msg = f"delegation failed: {type(exc).__name__}: {exc}"
                delegated = [{"subtaskId": sid, "ok": False, "error": _err_msg} for sid in to_run]
        else:
            logger.info("[supervisor_tool] 没有可执行的子任务")

        try:
            from evoflow.debug.task_lifecycle_trace import write_task_lifecycle_trace

            write_task_lifecycle_trace(
                thread_id=_runtime_thread_id(runtime),
                event="start_execution_dispatch",
                main_task_id=str(task_id),
                detail={
                    "to_run": list(to_run or []),
                    "blocked": [{"subtaskId": b.get("subtaskId"), "reason": b.get("reason")} for b in (blocked_subtasks or []) if isinstance(b, dict)][:32],
                    "delegated": [
                        {
                            "subtaskId": d.get("subtaskId"),
                            "ok": bool(d.get("ok")),
                            "detached": bool(d.get("detached")),
                        }
                        for d in (delegated or [])
                        if isinstance(d, dict)
                    ],
                },
            )
        except Exception:
            pass

        all_ok = all(d.get("ok") for d in delegated) if delegated else True

        # 记录委派结果摘要
        if delegated:
            success_count = sum(1 for d in delegated if d.get("ok"))
            failed_count = len(delegated) - success_count
            logger.info(f"[supervisor_tool] 子任务执行结果: 成功={success_count}, 失败={failed_count}")
            for d in delegated:
                if d.get("ok"):
                    continue
                logger.error(
                    "[supervisor_tool] subtask delegation failed task_id=%s subtaskId=%s error=%s",
                    task_id,
                    d.get("subtaskId"),
                    (d.get("error") or "")[:500],
                )

        # Broadcast task:started event immediately when execution begins
        if to_run:
            await _broadcast_task_event(
                task_id,
                "task:started",
                {"task_id": task_id, "started_at": utc_now_iso_z()},
            )
            logger.info(f"[supervisor_tool] Broadcasted task:started for {task_id}")

        # Broadcast collab:snapshot after delegation so frontend panel sees updated subtask statuses
        # (advance_collab_phase_to_executing_for_task broadcasts snapshot BEFORE delegation,
        # so subtasks are still "pending" at that point; we need another broadcast AFTER delegation
        # when subtasks have transitioned to "executing")
        try:
            from evoflow.collab.ws_notify import schedule_collab_state_changed

            lead_thread = _runtime_thread_id(runtime) or ""
            if lead_thread:
                schedule_collab_state_changed(lead_thread)
                logger.info(f"[supervisor_tool] Broadcasted collab:snapshot for thread {lead_thread} after delegation")
        except Exception:
            logger.debug("start_execution: schedule_collab_state_changed failed", exc_info=True)

        # Save Lead Agent conversation from current thread to task
        # This ensures conversation history is captured when task is executed from main chat
        try:
            await _save_conversation_to_task(runtime, task_id)
        except Exception as conv_e:
            logger.warning(f"[supervisor_tool] Failed to save conversation for task {task_id}: {conv_e}")

        # Server-side convergence: persist delegated subtask outcomes immediately,
        # so UI does not depend on the model remembering extra supervisor calls.
        row_done = find_main_task(storage, task_id)
        if row_done and delegated:
            proj_done, task_done = row_done
            now_done = utc_now_iso_z()
            delegated_map: dict[str, dict[str, Any]] = {str(d.get("subtaskId")): d for d in delegated if d.get("subtaskId")}
            for st in task_done.get("subtasks") or []:
                sid = str(st.get("id") or "")
                rec = delegated_map.get(sid)
                if not rec:
                    continue
                if rec.get("detached"):
                    continue
                st["updated_at"] = now_done
                if rec.get("ok"):
                    # Terminal status only via subtask_outcome_report (or worker finalize).
                    cur = str(st.get("status") or "").strip().lower()
                    if cur not in _TERMINAL_SUBTASK:
                        st["status"] = "in_progress"
                    if rec.get("result") is not None:
                        st["result"] = rec.get("result")
                    if rec.get("session_id"):
                        st["claude_session_id"] = rec.get("session_id")
                        st["external_session_id"] = rec.get("session_id")
                    if "error" in st:
                        st.pop("error", None)
                else:
                    if (st.get("status") or "").strip().lower() != "completed":
                        st["status"] = "failed"
                    st["failed_at"] = st.get("failed_at") or now_done
                    st["error"] = rec.get("error") or st.get("error")
                    try:
                        await _broadcast_task_event(
                            sid,
                            "task:failed",
                            {"task_id": sid, "error": (st.get("error") or "")[:4000]},
                        )
                    except Exception:
                        logger.debug("start_execution: broadcast subtask task:failed failed sid=%s", sid, exc_info=True)
            # Do not derive main-task terminal status from subtasks; lead sets it explicitly.
            task_done["updated_at"] = now_done
            if storage.save_project(proj_done):
                try:
                    rollup_root_task_progress_from_subtasks(storage, task_id)
                except Exception:
                    logger.debug("start_execution post_delegate: rollup progress failed task_id=%s", task_id, exc_info=True)
                row_ref = find_main_task(storage, task_id)
                if row_ref:
                    proj_done, task_done = row_ref
                try:
                    from evoflow.debug.task_lifecycle_trace import write_task_lifecycle_trace

                    _tid_done = str(task_done.get("thread_id") or "").strip() or _runtime_thread_id(runtime)
                    write_task_lifecycle_trace(
                        thread_id=_tid_done,
                        event="supervisor_post_delegate_convergence",
                        main_task_id=str(task_id),
                        status=str(task_done.get("status") or "").strip().lower() or None,
                        detail={
                            "subtasks_updated": [
                                {
                                    "subtaskId": str(st.get("id") or ""),
                                    "status": str(st.get("status") or "").strip().lower(),
                                }
                                for st in task_done.get("subtasks") or []
                                if isinstance(st, dict) and str(st.get("id") or "") in delegated_map
                            ],
                        },
                    )
                except Exception:
                    pass
                facts_count = _persist_main_task_memory_snapshot(proj_done, task_done)
                await _broadcast_task_event(
                    task_id,
                    "task_detail:updated",
                    {"task_id": task_id, "facts_count": facts_count},
                )
                await _broadcast_task_event(
                    task_id,
                    "task:progress",
                    {
                        "task_id": task_id,
                        "progress": int(task_done.get("progress") or 0),
                        "current_step": "",
                    },
                )
                if (task_done.get("status") or "").strip().lower() == "completed":
                    await _broadcast_task_event(
                        task_id,
                        "task:completed",
                        {"task_id": task_id, "result": task_done.get("result")},
                    )
                if wait_for_completion and (task_done.get("status") or "").strip().lower() in {"completed", "failed", "cancelled"}:
                    _mark_collab_phase_done_for_task(task_done, runtime)

        # 返回结构化的 JSON 格式
        _msg = f"Execution authorized for task {task_id}."
        auto_follow = False
        follow_payload: dict[str, Any] | None = None
        if not wait_for_completion and to_run:
            _msg += " Subagents are running in the background; the lead thread is not blocked."
            _msg += " Note: This response is a snapshot; for final status use the task sidebar or call get_status/list_subtasks."
            # Do not rely only on delegated[].detached flag; for async execution
            # we always start monitor loop when there are runnable subtasks.
            auto_follow = True
            try:
                _ensure_background_task_monitor(
                    storage,
                    task_id,
                    _runtime_thread_id(runtime),
                    poll_seconds=max(5.0, float(monitor_poll_seconds or 20)),
                )
            except Exception:
                logger.warning("start_execution: ensure background monitor failed task_id=%s", task_id, exc_info=True)
            # For async mode, return immediately; streaming is handled by main chat / gateway SSE.
            follow_payload = {
                "success": True,
                "terminal": False,
                "status": "in_progress",
                "message": "Detached execution started; follow real-time updates via chat stream and task sidebar.",
            }
        if blocked_subtasks:
            _msg += (
                f" {len(blocked_subtasks)} subtask(s) skipped (dependency not ready — see blockedSubtasks;"
                " this is not missing user authorization)."
            )
        _auth_row = find_main_task(storage, task_id)
        _auth_by = ""
        if _auth_row:
            _auth_by = str(_auth_row[1].get("authorized_by") or "user").strip()
        result = {
            "success": True,
            "action": "start_execution",
            "taskId": task_id,
            "authorizedBy": _auth_by or "user",
            "message": _msg,
            "collabPhaseAdvanced": phase_ok,
            "waitForCompletion": wait_for_completion,
            "subtaskIds": to_run,
            "blockedSubtasks": blocked_subtasks,
            "delegatedSubtasks": delegated,
            "delegationAllSucceeded": all_ok,
            "autoFollowed": auto_follow,
            "mustContinueMonitoring": bool(auto_follow),
            "nextMonitorInSeconds": 2 if auto_follow else 0,
        }
        terminal_now = bool(wait_for_completion) and not any(bool(d.get("detached")) for d in delegated) and not blocked_subtasks
        if bool(wait_for_completion) and delegated and all(bool(d.get("ok")) for d in delegated):
            terminal_now = True
        result["terminal"] = terminal_now
        result["shouldStopMonitoring"] = terminal_now
        if terminal_now:
            result["nextActionHint"] = "Execution batch finished. Stop polling and summarize."
        if follow_payload is not None:
            result["follow"] = follow_payload
        if blocked_subtasks:
            result["blockedSubtasksNote"] = (
                "blockedSubtasks 表示依赖未满足（如 Step 2 等 Step 1 完成），不是用户未授权。"
                " executionAuthorized 为 true 时勿再要求用户点击「开始执行」。"
            )
        if not to_run:
            result["success"] = False
            _row_diag = find_main_task(storage, task_id)
            _sub_n = len((_row_diag[1].get("subtasks") or []) if _row_diag else [])
            if _sub_n == 0:
                result["error"] = "no_subtasks"
                result["message"] = (
                    "主任务上没有子任务。plan 工具应已写入计划并同步子任务；"
                    "若刚提交 plan，请确认 boundTaskId 与 start_execution 的 task_id 一致，"
                    "或重新调用 plan 后再 start_execution。"
                )
                if subtasks_sync_meta.get("attempted"):
                    result["subtasksSync"] = subtasks_sync_meta.get("subtasksSync")
                    result["subtasksPreSync"] = subtasks_sync_meta
            else:
                result["error"] = "no_runnable_subtasks"
                result["message"] = (
                    "No subtasks are ready to run in this wave (check status, assignee, or dependencies). "
                    + str(result.get("message") or "")
                ).strip()
            if blocked_subtasks:
                result["blockedSubtasks"] = blocked_subtasks
        elif to_run and delegated and not all_ok:
            result["success"] = False
            result["error"] = "delegation_failed"
            result["message"] = (
                "One or more subtasks failed to start. See delegatedSubtasks for details. "
                + str(result.get("message") or "")
            ).strip()
        return json.dumps(result, ensure_ascii=False)

    # ── Action: peer_send ─────────────────────────────────────────────
    elif action == "peer_send":
        if not task_id or not subtask_id:
            return json.dumps(
                {
                    "success": False,
                    "action": "peer_send",
                    "error": "task_id and subtask_id (target) are required for peer_send action",
                },
                ensure_ascii=False,
            )
        msg_body = str(agent_message or "").strip()
        if not msg_body:
            return json.dumps(
                {
                    "success": False,
                    "action": "peer_send",
                    "error": "agent_message is required for peer_send action",
                },
                ensure_ascii=False,
            )
        from evoflow.collab.peer import lead_peer_send

        peer_res = await lead_peer_send(
            main_task_id=str(task_id),
            to_subtask=str(subtask_id),
            message=msg_body,
            expect_reply=True,
        )
        return json.dumps(
            {
                "success": bool(peer_res.get("ok")),
                "action": "peer_send",
                "taskId": task_id,
                "subtaskId": subtask_id,
                "peer": peer_res,
            },
            ensure_ascii=False,
        )

    # ── Action: retry_subtask ─────────────────────────────────────────
    elif action == "retry_subtask":
        if not task_id or not subtask_id:
            return json.dumps(
                {
                    "success": False,
                    "action": "retry_subtask",
                    "error": "task_id and subtask_id are required for retry_subtask action",
                },
                ensure_ascii=False,
            )

        row = find_main_task(storage, task_id)
        if not row:
            return json.dumps(
                {
                    "success": False,
                    "action": "retry_subtask",
                    "taskId": task_id,
                    "error": f"Task '{task_id}' not found",
                },
                ensure_ascii=False,
            )
        proj, task = row
        st_row = find_subtask_by_ids(storage, task_id, subtask_id)
        if not st_row:
            return json.dumps(
                {
                    "success": False,
                    "action": "retry_subtask",
                    "taskId": task_id,
                    "subtaskId": subtask_id,
                    "error": f"Subtask '{subtask_id}' not found in task '{task_id}'",
                },
                ensure_ascii=False,
            )

        # Reset the SAME subtask (keep id) so DAG & history stay intact.
        now = utc_now_iso_z()
        prev_status = ""
        retry_msg = str(agent_message or "").strip()
        for st in task.get("subtasks", []) or []:
            if str(st.get("id") or "").strip() != str(subtask_id).strip():
                continue
            prev_status = str(st.get("status") or "pending").strip().lower()
            st["status"] = "pending"
            st["progress"] = 0
            st["updated_at"] = now
            st.pop("completed_at", None)
            st.pop("failed_at", None)
            st.pop("result", None)
            st.pop("error", None)
            st["retry_count"] = int(st.get("retry_count") or 0) + 1
            st["last_retry_at"] = now
            st["last_retry_from_status"] = prev_status
            if retry_msg:
                st["retry_reason"] = retry_msg
                st["last_retry_reason"] = retry_msg
            break

        storage.save_project(proj)

        from evoflow.collab.authorize_execution import (
            ensure_task_execution_authorized_for_user,
            resolve_thread_id_for_task,
        )
        from evoflow.collab.supervisor_plan_gate import build_supervisor_gate_error

        run_thread = resolve_thread_id_for_task(
            storage,
            task_id,
            thread_id_hint=_runtime_thread_id(runtime) or "",
        )
        auth_ok, auth_detail = ensure_task_execution_authorized_for_user(
            storage,
            task_id,
            thread_id=run_thread,
        )
        if not auth_ok:
            err = build_supervisor_gate_error(
                action="retry_subtask",
                error_code="need_execution_authorization",
                message=auth_detail,
            )
            return json.dumps(
                {**err, "taskId": task_id, "subtaskId": subtask_id},
                ensure_ascii=False,
            )

        to_run, blocked_subtasks = _resolve_subtasks_for_start_execution(storage, task_id, [subtask_id])
        delegated: list[dict[str, Any]] = []
        if to_run:
            try:
                delegated = await delegate_collab_subtasks_for_start_execution(
                    runtime,
                    storage,
                    task_id,
                    to_run,
                )
            except Exception as exc:
                logger.exception("retry_subtask: delegate failed task_id=%s subtask_id=%s", task_id, subtask_id)
                delegated = [{"subtaskId": subtask_id, "ok": False, "error": f"delegation failed: {type(exc).__name__}: {exc}"}]

        return json.dumps(
            {
                "success": True,
                "action": "retry_subtask",
                "taskId": task_id,
                "subtaskId": subtask_id,
                "previousStatus": prev_status,
                "delegatedSubtasks": delegated,
                "blockedSubtasks": blocked_subtasks,
                "message": "Subtask reset and retried (same subtask_id preserved).",
            },
            ensure_ascii=False,
        )

    # ── Action: interrupt_subtask (task_tool workers) ───────────────
    elif action == "interrupt_subtask":
        if not task_id or not subtask_id:
            return json.dumps(
                {
                    "success": False,
                    "action": "interrupt_subtask",
                    "error": "task_id and subtask_id are required for interrupt_subtask action",
                },
                ensure_ascii=False,
            )
        from evoflow.collab.subtask_steering import interrupt_subtask_background_run, is_ephemeral_task_tool_subtask

        st_row = find_subtask_by_ids(storage, task_id, subtask_id)
        if not st_row:
            return json.dumps(
                {
                    "success": False,
                    "action": "interrupt_subtask",
                    "taskId": task_id,
                    "subtaskId": subtask_id,
                    "error": f"Subtask '{subtask_id}' not found",
                },
                ensure_ascii=False,
            )
        if not is_ephemeral_task_tool_subtask(st_row):
            return json.dumps(
                {
                    "success": False,
                    "action": "interrupt_subtask",
                    "taskId": task_id,
                    "subtaskId": subtask_id,
                    "error": "interrupt_subtask supports task_tool workers only (not claude-code / ACP)",
                    "assignedTo": st_row.get("assigned_to"),
                },
                ensure_ascii=False,
            )
        reason = str(agent_message or "").strip() or "interrupted by lead"
        out = interrupt_subtask_background_run(storage, task_id, subtask_id, reason=reason, cancelled_by="lead")
        return json.dumps(
            {
                "success": bool(out.get("ok")),
                "action": "interrupt_subtask",
                **out,
                "terminal": False,
                "mustContinueMonitoring": True,
            },
            ensure_ascii=False,
            default=str,
        )

    # ── Action: steer_subtask (task_tool workers) ─────────────────────
    elif action == "steer_subtask":
        if not task_id or not subtask_id:
            return json.dumps(
                {
                    "success": False,
                    "action": "steer_subtask",
                    "error": "task_id and subtask_id are required for steer_subtask action",
                },
                ensure_ascii=False,
            )
        if not agent_message or not str(agent_message).strip():
            return json.dumps(
                {
                    "success": False,
                    "action": "steer_subtask",
                    "taskId": task_id,
                    "subtaskId": subtask_id,
                    "error": "agent_message is required for steer_subtask action",
                },
                ensure_ascii=False,
            )
        from evoflow.collab.subtask_steering import steer_ephemeral_subtask

        out = await steer_ephemeral_subtask(
            runtime,
            storage,
            main_task_id=task_id,
            subtask_id=subtask_id,
            steer_message=str(agent_message).strip(),
            interrupt_first=True,
            wait_for_completion=bool(wait_for_completion),
        )
        return json.dumps(
            {
                "success": bool(out.get("ok")),
                "action": "steer_subtask",
                **out,
            },
            ensure_ascii=False,
            default=str,
        )

    # ── Action: set_task_planned ─────────────────────────────────────
    elif action == "set_task_planned":
        if not task_id:
            return json.dumps({"success": False, "action": "set_task_planned", "error": "task_id is required for set_task_planned action"}, ensure_ascii=False)

        # 查找并更新任务状态（须遍历全部 project：任务可能在非列表首项的工程中）
        projects = storage.list_projects()
        for project_summary in projects:
            project = storage.load_project(project_summary["id"])
            if not project:
                continue
            for i, task in enumerate(project.get("tasks", [])):
                if task.get("id") == task_id:
                    now = utc_now_iso_z()
                    task["status"] = "planned"
                    task["updated_at"] = now
                    project["tasks"][i] = task

                    if storage.save_project(project):
                        result = {"success": True, "action": "set_task_planned", "taskId": task_id, "status": "planned", "message": f"Task {task_id} status set to planned"}
                        _record_supervisor_ui_step(
                            runtime,
                            tool_call_id,
                            "set_task_planned",
                            f"任务已规划：{task_id}",
                        )
                        return json.dumps(result, ensure_ascii=False)
                    else:
                        return json.dumps({"success": False, "action": "set_task_planned", "taskId": task_id, "error": "Failed to save project"}, ensure_ascii=False)

        return json.dumps({"success": False, "action": "set_task_planned", "taskId": task_id, "error": f"Task '{task_id}' not found"}, ensure_ascii=False)

    # ── Action: set_task_state ───────────────────────────────────────
    elif action == "set_task_state":
        if not task_id:
            return json.dumps(
                {
                    "success": False,
                    "action": "set_task_state",
                    "error": "task_id is required for set_task_state action",
                },
                ensure_ascii=False,
            )
        target_state = _normalize_task_state(status)
        if target_state not in _ALLOWED_TASK_STATES:
            return json.dumps(
                {
                    "success": False,
                    "action": "set_task_state",
                    "taskId": task_id,
                    "error": f"invalid target status '{status}'",
                    "allowedStates": sorted(_ALLOWED_TASK_STATES),
                },
                ensure_ascii=False,
            )

        projects = storage.list_projects()
        for project_summary in projects:
            project = storage.load_project(project_summary["id"])
            if not project:
                continue
            for i, task in enumerate(project.get("tasks", [])):
                if task.get("id") != task_id:
                    continue

                current_state = _normalize_task_state(task.get("status"))
                if current_state not in _ALLOWED_TASK_STATES:
                    current_state = "pending"
                if not _can_transition_task_state(current_state, target_state):
                    return json.dumps(
                        {
                            "success": False,
                            "action": "set_task_state",
                            "taskId": task_id,
                            "fromStatus": current_state,
                            "toStatus": target_state,
                            "error": f"illegal state transition: {current_state} -> {target_state}",
                        },
                        ensure_ascii=False,
                    )

                now = utc_now_iso_z()
                task["status"] = target_state
                task["updated_at"] = now
                if target_state == "completed":
                    task["progress"] = 100
                    task["completed_at"] = task.get("completed_at") or now
                elif target_state == "failed":
                    task["failed_at"] = task.get("failed_at") or now
                elif target_state == "cancelled":
                    task["cancelled_at"] = task.get("cancelled_at") or now
                project["tasks"][i] = task

                if not storage.save_project(project):
                    return json.dumps(
                        {
                            "success": False,
                            "action": "set_task_state",
                            "taskId": task_id,
                            "error": "Failed to save project",
                        },
                        ensure_ascii=False,
                    )

                _persist_main_task_memory_snapshot(project, task)
                if target_state in {"completed", "failed", "cancelled"}:
                    await _broadcast_task_event(
                        task_id,
                        "task:completed",
                        {"task_id": task_id, "result": task.get("result"), "status": target_state},
                    )
                else:
                    await _broadcast_task_event(
                        task_id,
                        "task:progress",
                        {"task_id": task_id, "progress": int(task.get("progress") or 0), "current_step": ""},
                    )
                return json.dumps(
                    {
                        "success": True,
                        "action": "set_task_state",
                        "taskId": task_id,
                        "fromStatus": current_state,
                        "status": target_state,
                        "statusZh": _status_zh(target_state),
                    },
                    ensure_ascii=False,
                )

        return json.dumps(
            {
                "success": False,
                "action": "set_task_state",
                "taskId": task_id,
                "error": f"Task '{task_id}' not found",
            },
            ensure_ascii=False,
        )

    # ── Action: set_subtask_work_checklist (optional Lead override; workers normally use subtask_work_checklist) ──
    elif action == "set_subtask_work_checklist":
        if not task_id or not subtask_id:
            return json.dumps(
                {
                    "success": False,
                    "action": "set_subtask_work_checklist",
                    "error": "task_id and subtask_id are required",
                },
                ensure_ascii=False,
            )
        parsed_wc = _coerce_list_arg(work_checklist)
        if parsed_wc is None and work_checklist is not None:
            try:
                if isinstance(work_checklist, str):
                    parsed_wc = json.loads(work_checklist.strip())
            except Exception:
                parsed_wc = None
        if not isinstance(parsed_wc, list) or not parsed_wc:
            return json.dumps(
                {
                    "success": False,
                    "action": "set_subtask_work_checklist",
                    "error": "work_checklist (array of {content, status?, result?}) is required",
                },
                ensure_ascii=False,
            )
        from evoflow.collab.work_checklist import (
            format_checklist_markdown_table,
        )
        from evoflow.collab.work_checklist import (
            set_subtask_work_checklist as _set_wc,
        )

        ok, msg, rows = _set_wc(storage, task_id, subtask_id, parsed_wc, replace=True)
        if not ok:
            return json.dumps(
                {"success": False, "action": "set_subtask_work_checklist", "taskId": task_id, "subtaskId": subtask_id, "error": msg},
                ensure_ascii=False,
            )
        return json.dumps(
            {
                "success": True,
                "action": "set_subtask_work_checklist",
                "taskId": task_id,
                "subtaskId": subtask_id,
                "count": len(rows),
                "workChecklist": rows,
                "tableMarkdown": format_checklist_markdown_table(rows),
            },
            ensure_ascii=False,
        )

    # ── Action: continue_subtask_session ─────────────────────────────
    elif action == "continue_subtask_session":
        if not task_id or not subtask_id:
            return json.dumps(
                {
                    "success": False,
                    "action": "continue_subtask_session",
                    "error": "task_id and subtask_id are required for continue_subtask_session action",
                    "hint": "Omit task_id only when runtime has collab_task_id or thread bound_task_id; subtask_id is always required.",
                },
                ensure_ascii=False,
            )
        if not agent_message or not str(agent_message).strip():
            return json.dumps(
                {
                    "success": False,
                    "action": "continue_subtask_session",
                    "taskId": task_id,
                    "subtaskId": subtask_id,
                    "error": "agent_message is required for continue_subtask_session action",
                },
                ensure_ascii=False,
            )

        from evoflow.collab.subtask_steering import is_ephemeral_task_tool_subtask, steer_ephemeral_subtask

        st_row = find_subtask_by_ids(storage, task_id, subtask_id)
        if st_row and is_ephemeral_task_tool_subtask(st_row):
            steer_out = await steer_ephemeral_subtask(
                runtime,
                storage,
                main_task_id=task_id,
                subtask_id=subtask_id,
                steer_message=str(agent_message).strip(),
                interrupt_first=True,
                wait_for_completion=bool(wait_for_completion),
            )
            return json.dumps(
                {
                    "success": bool(steer_out.get("ok")),
                    "action": "steer_subtask",
                    "redirectedFrom": "continue_subtask_session",
                    "taskId": task_id,
                    "subtaskId": subtask_id,
                    "message": (
                        "continue_subtask_session applies to Claude/ACP session workers; "
                        "ephemeral task_tool subtask was steered via steer_subtask instead."
                    ),
                    **steer_out,
                },
                ensure_ascii=False,
                default=str,
            )

        from evoflow.collab.continue_subtask_session import continue_subtask_session as run_continue_subtask_session

        if not bool(wait_for_completion):

            async def _bg_runner() -> None:
                try:
                    await run_continue_subtask_session(
                        storage=storage,
                        task_id=task_id,
                        subtask_id=subtask_id,
                        agent_message=str(agent_message).strip(),
                        read_lines=max(1, int(read_lines or 200)),
                        keep_session_open=bool(keep_session_open),
                        wait_for_completion=True,
                        runtime=runtime,
                    )
                except Exception:
                    logger.debug("continue_subtask_session background round failed", exc_info=True)

            asyncio.create_task(_bg_runner())
            return json.dumps(
                {
                    "success": True,
                    "action": "continue_subtask_session",
                    "taskId": task_id,
                    "subtaskId": subtask_id,
                    "detached": True,
                    "waitForCompletion": False,
                    "keepSessionOpen": bool(keep_session_open),
                    "status": "in_progress",
                    "message": "Subtask session round started in background; stream is emitted to subtask ticker.",
                    "terminal": False,
                    "shouldStopMonitoring": False,
                    "mustContinueMonitoring": True,
                    "nextMonitorInSeconds": 2,
                },
                ensure_ascii=False,
            )

        final_res = await run_continue_subtask_session(
            storage=storage,
            task_id=task_id,
            subtask_id=subtask_id,
            agent_message=str(agent_message).strip(),
            read_lines=max(1, int(read_lines or 200)),
            keep_session_open=bool(keep_session_open),
            wait_for_completion=True,
            runtime=runtime,
        )
        return json.dumps(final_res, ensure_ascii=False)

    # ── Action: get_status ───────────────────────────────────────────
    elif action == "get_status":
        if not task_id:
            return json.dumps({"success": False, "action": "get_status", "error": "task_id is required for get_status action"}, ensure_ascii=False)

        projects = storage.list_projects()

        for project_summary in projects:
            project = storage.load_project(project_summary["id"])
            if project:
                for task in project.get("tasks", []):
                    if task.get("id") == task_id:
                        # Ensure main task status/progress is converged from subtasks before reading.
                        try:
                            rollup_root_task_progress_from_subtasks(storage, task_id)
                            refreshed = find_main_task(storage, task_id)
                            if refreshed:
                                _proj2, task2 = refreshed
                                task = task2
                        except Exception:
                            logger.debug("get_status: rollup from subtasks failed task_id=%s", task_id, exc_info=True)
                        subtasks = task.get("subtasks", [])
                        auth = task.get("execution_authorized", False)
                        tid = task.get("thread_id")
                        result = {
                            "success": True,
                            "action": "get_status",
                            "taskId": task_id,
                            "name": task.get("name"),
                            "status": task.get("status", "unknown"),
                            "statusZh": _status_zh(task.get("status", "unknown")),
                            "progress": int(task.get("progress") or 0),
                            "executionAuthorized": bool(auth),
                            "authorizationNote": (
                                "用户已在界面或对话中授权，可直接 start_execution。"
                                if auth
                                else "尚未 execution_authorized：须用户点击「开始执行」或对话确认后再 start_execution。"
                            ),
                            "statusNote": (
                                "主任务 status 可为 planned 且 executionAuthorized=true 并存；"
                                "勿仅凭 status=planned 判断未授权。"
                            ),
                            "threadId": tid,
                            "subtaskCount": len(subtasks),
                            "subtasks": [_subtask_row_dict(st) for st in subtasks],
                            "acpSessions": _acp_session_summary_for_task(task_id),
                        }
                        return json.dumps(merge_orchestration_hints(result, task), ensure_ascii=False, default=str)

        return json.dumps({"success": False, "action": "get_status", "error": f"Task '{task_id}' not found"}, ensure_ascii=False)

    # ── Action: get_subtask_conversation (legacy alias: get_task_memory) ──
    elif action in {"get_subtask_conversation", "get_task_memory"}:
        from evoflow.tools.builtins.supervisor.conversation import build_subtask_conversation_payload

        resolved_action = "get_subtask_conversation"
        if action == "get_task_memory":
            resolved_action = "get_subtask_conversation"
        sid = subtask_id or memory_key_agent_id
        if not sid:
            return json.dumps(
                {
                    "success": False,
                    "action": resolved_action,
                    "error": "subtask_id is required for get_subtask_conversation (task_id optional when subtask_id is unique)",
                },
                ensure_ascii=False,
            )
        try:
            msg_limit = max(1, min(int(read_lines or 200), 500))
        except Exception:
            msg_limit = 200
        result = build_subtask_conversation_payload(
            storage,
            task_id=task_id,
            subtask_id=sid,
            legacy_subtask_selector=memory_key_agent_id if not subtask_id else None,
            limit=msg_limit,
            action=resolved_action,
        )
        if action == "get_task_memory" and result.get("success"):
            result = {**result, "deprecatedAction": "get_task_memory", "action": resolved_action}
        return json.dumps(result, ensure_ascii=False, default=str)

    # ── Action: monitor_execution (deprecated) ───────────────────────
    elif action == "monitor_execution":
        return json.dumps(
            {
                "success": False,
                "action": "monitor_execution",
                "error": "monitor_execution has been removed. Use monitor_execution_step instead.",
            },
            ensure_ascii=False,
        )

    # ── Action: monitor_execution_step (incremental snapshot) ────────
    elif action == "monitor_execution_step":
        """Poll for at most `monitor_step_seconds` and return an incremental snapshot.

        This is used when the lead agent should report progress every N seconds
        without requiring a full terminal wait.
        """
        if not task_id:
            return json.dumps(
                {
                    "success": False,
                    "action": "monitor_execution_step",
                    "error": "task_id is required for monitor_execution_step action",
                },
                ensure_ascii=False,
            )

        try:
            poll_seconds = max(1, int(monitor_poll_seconds))
        except Exception:
            poll_seconds = 5

        try:
            step_seconds = max(5, int(monitor_step_seconds))  # 最小5秒，避免过于频繁的监控
        except Exception:
            step_seconds = 10

        # Cap poll_seconds to step_seconds so a single sleep never exceeds the step budget.
        # Without this, poll_seconds=60 + step_seconds=20 causes a single 60s sleep that
        # exceeds the step budget and gets interrupted by the platform.
        poll_seconds = min(poll_seconds, step_seconds)

        start_ts = asyncio.get_event_loop().time()
        terminal_main = {"completed", "failed", "cancelled"}
        # Prefer returning on meaningful state change to avoid repetitive monitor spam.
        baseline_sig = ""
        try:
            prev = _task_watch_state.get(task_id) or {}
            baseline_sig = str(prev.get("last_monitor_return_sig") or "")
        except Exception:
            baseline_sig = ""

        # Hard iteration cap to prevent infinite loops even if step_seconds is huge.
        max_iterations = max(10, step_seconds // max(1, poll_seconds) + 5)
        iteration = 0

        while True:
            iteration += 1
            # Flush ACP streamed chunks (high-frequency with idle backoff) while we are
            # inside a LangGraph tool turn (writer runtime is available).
            try:
                from evoflow.tools.builtins.supervisor.acp_session_registry import (
                    drain_stream_chunks,
                    list_active_sessions_for_task,
                )

                writer = None
                try:
                    writer = get_stream_writer()
                except Exception:
                    writer = None

                if callable(writer):
                    ws0 = _task_watch_state.get(task_id) or {}
                    cursors: dict[str, int] = ws0.get("acp_stream_cursors") or {}
                    if not isinstance(cursors, dict):
                        cursors = {}
                    pending_by_subtask: dict[str, str] = ws0.get("acp_pending_by_subtask") or {}
                    if not isinstance(pending_by_subtask, dict):
                        pending_by_subtask = {}
                    done_emitted: dict[str, bool] = ws0.get("acp_done_emitted_by_subtask") or {}
                    if not isinstance(done_emitted, dict):
                        done_emitted = {}

                    any_new = False
                    for sid in list_active_sessions_for_task(task_id):
                        last_seq = int(cursors.get(sid) or 0)
                        latest, items = drain_stream_chunks(sid, after_seq=last_seq)
                        if items:
                            any_new = True
                        final_result = None
                        try:
                            from evoflow.tools.builtins.supervisor.acp_session_registry import (
                                get_final_result,
                                require_existing,
                            )

                            rec = require_existing(sid)
                            st = None
                            if rec is not None:
                                try:
                                    st = rec.status.value  # type: ignore[union-attr]
                                except Exception:
                                    st = str(rec.status or "")
                            if rec and str(st or "").strip().lower() == "completed":
                                final_result = get_final_result(sid)
                        except Exception:
                            final_result = None
                        for it in items:
                            stid = it.get("subtask_id")
                            chunk = it.get("chunk")
                            if not stid or not isinstance(chunk, str) or chunk == "":
                                continue
                            prev = pending_by_subtask.get(stid) or ""
                            next_buf = prev + chunk
                            emit = False
                            if "\n" in chunk:
                                emit = True
                            elif len(next_buf) >= 120:
                                emit = True
                            elif any(p in chunk for p in ("。", "！", "？", ".", "!", "?", "；", ";")) and len(next_buf) >= 40:
                                emit = True
                            if emit:
                                out_text = next_buf
                                if not prev:
                                    out_text = out_text.lstrip()
                                if out_text.strip():
                                    writer(
                                        {
                                            "type": "task_running",
                                            "task_id": stid,
                                            "collab_subtask_id": stid,
                                            "subagent_type": "acp",
                                            "message": {"type": "ai", "content": out_text},
                                        }
                                    )
                                pending_by_subtask[stid] = ""
                            else:
                                pending_by_subtask[stid] = next_buf
                        cursors[sid] = int(latest or last_seq)

                        if final_result:
                            stid = None
                            try:
                                from evoflow.tools.builtins.supervisor.acp_session_registry import require_existing

                                rec2 = require_existing(sid)
                                stid = str(getattr(rec2, "subtask_id", "") or "").strip() if rec2 else ""
                            except Exception:
                                stid = ""
                            if stid and not bool(done_emitted.get(stid)):
                                tail = (pending_by_subtask.get(stid) or "").strip()
                                if tail:
                                    writer(
                                        {
                                            "type": "task_running",
                                            "task_id": stid,
                                            "collab_subtask_id": stid,
                                            "subagent_type": "acp",
                                            "message": {"type": "ai", "content": tail},
                                        }
                                    )
                                pending_by_subtask[stid] = ""
                                writer(
                                    {
                                        "type": "task_completed",
                                        "task_id": stid,
                                        "collab_subtask_id": stid,
                                        "subagent_type": "acp",
                                        "result": final_result,
                                    }
                                )
                                done_emitted[stid] = True

                    # Persist cursors + adaptive flush delay for intra-step sleeps.
                    ws0["acp_stream_cursors"] = cursors
                    ws0["acp_pending_by_subtask"] = pending_by_subtask
                    ws0["acp_done_emitted_by_subtask"] = done_emitted
                    # Small delay when active; backoff when idle.
                    prev_delay = float(ws0.get("acp_stream_flush_delay_ms") or 50.0)
                    if any_new:
                        ws0["acp_stream_flush_delay_ms"] = 50.0
                    else:
                        ws0["acp_stream_flush_delay_ms"] = min(1000.0, max(50.0, prev_delay * 1.7))
                    _task_watch_state[task_id] = ws0
            except Exception:
                pass
            try:
                _auto_finalize_unrunnable_pending_subtasks(storage, task_id)
            except Exception:
                logger.debug("monitor_execution_step: auto finalize pending failed task_id=%s", task_id, exc_info=True)

            # Sync main-task progress/status from subtask rows for UI + monitor payload.
            try:
                rollup_root_task_progress_from_subtasks(storage, task_id)
            except Exception:
                logger.debug("monitor_execution_step: rollup root task progress failed task_id=%s", task_id, exc_info=True)

            row = find_main_task(storage, task_id)
            if not row:
                return json.dumps(
                    {
                        "success": False,
                        "action": "monitor_execution_step",
                        "taskId": task_id,
                        "error": f"Task '{task_id}' not found",
                    },
                    ensure_ascii=False,
                )

            _proj, task = row
            t_status = str(task.get("status") or "pending").strip().lower()
            t_progress = task.get("progress", 0) or 0
            subtasks = task.get("subtasks") or []

            sub_rows, failed_subtasks = _build_monitor_subtask_rows(storage, subtasks, main_task=task)
            auto_retry_payload: dict[str, Any] | None = None
            try:
                auto_retry_payload = await _auto_retry_timed_out_subtasks_once(
                    runtime,
                    storage,
                    task_id,
                    max_retries_per_subtask=1,
                )
            except Exception:
                logger.debug("monitor_execution_step: auto retry timed_out failed task_id=%s", task_id, exc_info=True)
            if auto_retry_payload and (auto_retry_payload.get("retriedSubtaskIds") or auto_retry_payload.get("delegatedSubtaskIds")):
                row2 = find_main_task(storage, task_id)
                if row2:
                    _proj2, task2 = row2
                    t_status = str(task2.get("status") or t_status).strip().lower()
                    t_progress = task2.get("progress", t_progress) or 0
                    subtasks = task2.get("subtasks") or []
                    sub_rows, failed_subtasks = _build_monitor_subtask_rows(storage, subtasks, main_task=task2)

            # Determine whether we can treat this snapshot as terminal (**main** task only).
            main_terminal = t_status in terminal_main
            # ``terminal`` / collab lifecycle: all subtasks finishing while the main task stays
            # non-terminal is for the lead orchestrator (validation, follow-up waves, …).

            # Attach task memory snapshot (best-effort, keep small)
            memory_payload: dict[str, Any] | None = None
            try:
                mem_store = get_task_detail_storage()
                mem_row = load_task_detail_for_task_id(storage, mem_store, task_id)
                if mem_row is not None:
                    mem, project_id, agent_id, parent_task_id = mem_row
                    facts = mem.get("facts") or []
                    if not isinstance(facts, list):
                        facts = []
                    memory_payload = {
                        "status": mem.get("status", ""),
                        "statusZh": _status_zh(mem.get("status", "")),
                        "current_step": mem.get("current_step", ""),
                        "output_summary": mem.get("output_summary", ""),
                        "factsCount": len(facts),
                        "facts": facts[:5],
                    }
            except Exception:
                # Monitoring should never fail because memory is unavailable.
                logger.debug("monitor_execution_step: memory snapshot failed", exc_info=True)

            elapsed = asyncio.get_event_loop().time() - start_ts
            cur_sig = json.dumps(
                {
                    "status": t_status,
                    "sub": [(str(x.get("subtaskId") or ""), str(x.get("status") or ""), int(x.get("progress") or 0)) for x in sub_rows],
                    "step": str((memory_payload or {}).get("current_step") or ""),
                },
                ensure_ascii=False,
                default=str,
            )
            # status_sig tracks only status transitions (no progress) so that
            # important events like subtask completing are returned immediately.
            status_sig = json.dumps(
                {
                    "status": t_status,
                    "sub": [(str(x.get("subtaskId") or ""), str(x.get("status") or "")) for x in sub_rows],
                },
                ensure_ascii=False,
            )
            baseline_status_sig = ""
            try:
                prev = _task_watch_state.get(task_id) or {}
                baseline_status_sig = str(prev.get("last_monitor_status_sig") or "")
            except Exception:
                baseline_status_sig = ""
            status_transition = status_sig and status_sig != baseline_status_sig

            # Terminal: return immediately with terminal=true (main task only; see note above).
            if main_terminal:
                rec = _compute_monitor_recommendation(
                    task_id=task_id,
                    status=t_status,
                    progress=int(t_progress or 0),
                    sub_rows=sub_rows,
                    memory_payload=memory_payload,
                )
                return json.dumps(
                    merge_orchestration_hints(
                        {
                            "success": True,
                            "action": "monitor_execution_step",
                            "taskId": task_id,
                            "terminal": True,
                            "status": t_status,
                            "statusZh": _status_zh(t_status),
                            "progress": int(t_progress or 0),
                            "subtasks": sub_rows,
                            "failedSubtasks": failed_subtasks,
                            "memory": memory_payload,
                            "acpSessions": _acp_session_summary_for_task(task_id),
                            "recommendation": rec,
                            "autoRetry": auto_retry_payload or {"retriedSubtaskIds": [], "delegatedSubtaskIds": []},
                            "noChange": False,
                        },
                        task,
                    ),
                    ensure_ascii=False,
                    default=str,
                )

            # State changed – differentiate between significant status transitions
            # (e.g. subtask completed/failed) and minor progress-only changes.
            # - Status transition → return immediately (lead agent must react fast).
            # - Progress-only change → throttle via poll_seconds.
            if cur_sig and cur_sig != baseline_sig:
                if not status_transition and elapsed < poll_seconds:
                    # Minor progress change only – wait the remainder before returning.
                    # During waiting, keep flushing ACP stream with adaptive frequency.
                    remain = min(float(poll_seconds - elapsed), max(0.0, float(step_seconds) - elapsed))
                    end_ts = asyncio.get_event_loop().time() + remain
                    while True:
                        now_ts = asyncio.get_event_loop().time()
                        if now_ts >= end_ts:
                            break
                        try:
                            wsx = _task_watch_state.get(task_id) or {}
                            dms = float(wsx.get("acp_stream_flush_delay_ms") or 50.0)
                        except Exception:
                            dms = 50.0
                        await asyncio.sleep(min(0.2, max(0.05, dms / 1000.0)))
                    continue

                rec = _compute_monitor_recommendation(
                    task_id=task_id,
                    status=t_status,
                    progress=int(t_progress or 0),
                    sub_rows=sub_rows,
                    memory_payload=memory_payload,
                )
                try:
                    ws = _task_watch_state.get(task_id) or {}
                    ws["last_monitor_return_sig"] = cur_sig
                    ws["last_monitor_status_sig"] = status_sig
                    _task_watch_state[task_id] = ws
                except Exception:
                    pass
                return json.dumps(
                    merge_orchestration_hints(
                        {
                            "success": True,
                            "action": "monitor_execution_step",
                            "taskId": task_id,
                            "terminal": False,
                            "status": t_status,
                            "statusZh": _status_zh(t_status),
                            "progress": int(t_progress or 0),
                            **(
                                {
                                    "subtasksSummary": _subtask_status_counts(sub_rows),
                                    "failedCount": len(failed_subtasks),
                                }
                                if monitor_detail == "compact"
                                else {
                                    "subtasks": sub_rows,
                                    "failedSubtasks": failed_subtasks,
                                    "memory": memory_payload,
                                    "acpSessions": _acp_session_summary_for_task(task_id),
                                }
                            ),
                            "recommendation": rec,
                            "autoRetry": auto_retry_payload or {"retriedSubtaskIds": [], "delegatedSubtaskIds": []},
                            "noChange": False,
                            "elapsedSeconds": int(elapsed),
                        },
                        task,
                    ),
                    ensure_ascii=False,
                    default=str,
                )

            # Iteration cap safety net – prevents infinite loops even with extreme parameters.
            if iteration >= max_iterations:
                logger.warning(
                    "monitor_execution_step: hit max_iterations=%d for task_id=%s, returning snapshot",
                    max_iterations,
                    task_id,
                )
                rec = _compute_monitor_recommendation(
                    task_id=task_id,
                    status=t_status,
                    progress=int(t_progress or 0),
                    sub_rows=sub_rows,
                    memory_payload=memory_payload,
                )
                return json.dumps(
                    merge_orchestration_hints(
                        {
                            "success": True,
                            "action": "monitor_execution_step",
                            "taskId": task_id,
                            "terminal": False,
                            "status": t_status,
                            "statusZh": _status_zh(t_status),
                            "progress": int(t_progress or 0),
                            **(
                                {
                                    "subtasksSummary": _subtask_status_counts(sub_rows),
                                    "failedCount": len(failed_subtasks),
                                }
                                if monitor_detail == "compact"
                                else {
                                    "subtasks": sub_rows,
                                    "failedSubtasks": failed_subtasks,
                                    "memory": memory_payload,
                                    "acpSessions": _acp_session_summary_for_task(task_id),
                                }
                            ),
                            "recommendation": rec,
                            "autoRetry": auto_retry_payload or {"retriedSubtaskIds": [], "delegatedSubtaskIds": []},
                            "noChange": True,
                            "elapsedSeconds": int(elapsed),
                            "reason": "max_iterations_reached",
                        },
                        task,
                    ),
                    ensure_ascii=False,
                    default=str,
                )

            # Non-terminal + unchanged: wait and poll again until step_seconds elapsed.
            if elapsed < step_seconds:
                # Cap the sleep to the remaining step budget so we never overshoot.
                remain_budget = max(0.0, float(step_seconds) - elapsed)
                sleep_duration = min(float(poll_seconds), remain_budget)
                # During waiting, keep flushing ACP stream with adaptive frequency.
                end_ts = asyncio.get_event_loop().time() + sleep_duration
                while True:
                    now_ts = asyncio.get_event_loop().time()
                    if now_ts >= end_ts:
                        break
                    try:
                        wsx = _task_watch_state.get(task_id) or {}
                        dms = float(wsx.get("acp_stream_flush_delay_ms") or 50.0)
                    except Exception:
                        dms = 50.0
                    await asyncio.sleep(min(0.2, max(0.05, dms / 1000.0)))
                continue

            # step_seconds timeout reached – return snapshot so caller isn't blocked forever.
            # 目标：每次 monitor_execution_step 都有结构化结果，避免前端显示"无结果"。
            rec = _compute_monitor_recommendation(
                task_id=task_id,
                status=t_status,
                progress=int(t_progress or 0),
                sub_rows=sub_rows,
                memory_payload=memory_payload,
            )
            return json.dumps(
                merge_orchestration_hints(
                    {
                        "success": True,
                        "action": "monitor_execution_step",
                        "taskId": task_id,
                        "terminal": False,
                        "status": t_status,
                        "statusZh": _status_zh(t_status),
                        "progress": int(t_progress or 0),
                        **(
                            {
                                "subtasksSummary": _subtask_status_counts(sub_rows),
                                "failedCount": len(failed_subtasks),
                            }
                            if monitor_detail == "compact"
                            else {
                                "subtasks": sub_rows,
                                "failedSubtasks": failed_subtasks,
                                "memory": memory_payload,
                                "acpSessions": _acp_session_summary_for_task(task_id),
                            }
                        ),
                        "recommendation": rec,
                        "autoRetry": auto_retry_payload or {"retriedSubtaskIds": [], "delegatedSubtaskIds": []},
                        "noChange": True,
                        "elapsedSeconds": int(elapsed),
                    },
                    task,
                ),
                ensure_ascii=False,
                default=str,
            )

    # ── Action: list_subtasks ────────────────────────────────────────
    elif action == "list_subtasks":
        if not task_id:
            return json.dumps({"success": False, "action": "list_subtasks", "error": "task_id is required for list_subtasks action"}, ensure_ascii=False)

        projects = storage.list_projects()

        for project_summary in projects:
            project = storage.load_project(project_summary["id"])
            if project:
                for task in project.get("tasks", []):
                    if task.get("id") == task_id:
                        subtasks = task.get("subtasks", [])
                        payload = merge_orchestration_hints(
                            {
                                "success": True,
                                "action": "list_subtasks",
                                "taskId": task_id,
                                "subtasks": [_subtask_row_dict(st) for st in subtasks],
                            },
                            task,
                        )
                        if not subtasks:
                            payload["message"] = f"No subtasks found for task '{task_id}'"
                        return json.dumps(payload, ensure_ascii=False, default=str)

        return json.dumps({"success": False, "action": "list_subtasks", "error": f"Task '{task_id}' not found"}, ensure_ascii=False)

    # ── Fallback: unknown action ────────────────────────────────────
    return json.dumps(
        {
            "success": False,
            "action": action,
            "error": f"Unknown action '{action}'",
            "availableActions": [
                "create_task",
                "create_subtask",
                "create_subtasks",
                "update_progress",
                "complete_subtask",
                "start_execution",
                "peer_send",
                "continue_subtask_session",
                "monitor_execution_step",
                "set_task_planned",
                "set_task_state",
                "get_status",
                "get_subtask_conversation",
                "interrupt_subtask",
                "steer_subtask",
                "get_task_memory",
                "list_subtasks",
            ],
        },
        ensure_ascii=False,
    )
