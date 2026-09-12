"""Rebuild task sidebar / collab panel state for a chat thread (e.g. after page refresh)."""

from __future__ import annotations

import logging
from typing import Any

from evoflow.collab.execution_lifecycle import pack_main_task_lifecycle_fields
from evoflow.collab.models import CollabPhase, ThreadCollabState
from evoflow.collab.storage import (
    find_main_task,
    get_project_storage,
    get_task_detail_storage,
    reconcile_subtask_memory_consistency,
)
from evoflow.collab.thread_collab import load_thread_collab_state, merge_thread_collab_state, save_thread_collab_state
from evoflow.config.paths import Paths

logger = logging.getLogger(__name__)


def _norm(s: Any) -> str:
    return str(s or "").strip().lower()


def _task_has_structured_plan(task: dict[str, Any] | None) -> bool:
    from evoflow.collab.plan_task_storage import task_has_bound_plan

    return task_has_bound_plan(task)


def _phase_idle_like(phase: str) -> bool:
    p = _norm(phase)
    return p in {"", CollabPhase.IDLE.value}


def _plan_scenario_active(collab: ThreadCollabState) -> bool:
    keys = {_norm(x) for x in (collab.activated_scenarios or []) if _norm(x)}
    return "plan" in keys


def _subtask_terminal(st: dict[str, Any]) -> bool:
    return _norm(st.get("status")) in {"completed", "failed", "cancelled", "timed_out"}


def infer_sidebar_collab_phase(collab: ThreadCollabState, main_task: dict[str, Any] | None) -> tuple[str, str]:
    """Infer UI/debug ``collab_phase`` aligned with supervisor truth and plan-guard virtual phases.

    Returns:
        ``(phase, reason)`` where ``reason`` is ``disk`` when unchanged, else a short tag.
    """
    disk_raw = collab.collab_phase.value if isinstance(collab.collab_phase, CollabPhase) else str(collab.collab_phase)
    disk = _norm(disk_raw)

    if main_task is None:
        if _phase_idle_like(disk) and _plan_scenario_active(collab):
            return CollabPhase.PLAN_READY.value, "infer_virtual_plan_ready_no_task"
        return disk_raw if disk_raw else CollabPhase.IDLE.value, "disk"

    subs = [x for x in (main_task.get("subtasks") or []) if isinstance(x, dict)]
    ms = _norm(main_task.get("status"))
    auth = bool(main_task.get("execution_authorized"))

    if not subs and ms in {"completed", "failed", "cancelled"}:
        return CollabPhase.DONE.value, "infer_main_terminal_no_subtasks"

    if subs and all(_subtask_terminal(x) for x in subs) and ms in {"completed", "failed", "cancelled"}:
        return CollabPhase.DONE.value, "infer_main_terminal_all_subtasks_terminal"

    if auth and subs and any(not _subtask_terminal(x) for x in subs):
        if disk in {
            CollabPhase.IDLE.value,
            CollabPhase.PLANNING.value,
            CollabPhase.PLAN_READY.value,
            CollabPhase.AWAITING_EXEC.value,
        }:
            return CollabPhase.EXECUTING.value, "infer_execution_authorized_active_subtasks"

    if _phase_idle_like(disk) and _plan_scenario_active(collab) and _task_has_structured_plan(main_task):
        if not auth and ms not in {"completed", "failed", "cancelled"}:
            return CollabPhase.PLAN_READY.value, "infer_virtual_plan_ready_bound_plan"

    return disk_raw if disk_raw else CollabPhase.IDLE.value, "disk"


def _maybe_repair_disk_collab_done(paths: Paths, thread_id: str, collab: ThreadCollabState, inferred: str, _reason: str) -> ThreadCollabState:
    """Persist ``done`` when disk phase is stale but inference says main-terminal done (idempotent)."""
    if inferred != CollabPhase.DONE.value:
        return collab
    cur = _norm(collab.collab_phase.value if isinstance(collab.collab_phase, CollabPhase) else collab.collab_phase)
    if cur == CollabPhase.DONE.value:
        return collab
    try:
        merged = merge_thread_collab_state(collab, {"collab_phase": CollabPhase.DONE.value})
        save_thread_collab_state(paths, thread_id, merged)
        logger.info(
            "task_progress_snapshot: repaired stale collab_phase %r -> done (thread_id=%s)",
            cur,
            thread_id,
        )
        return merged
    except Exception:
        logger.debug("task_progress_snapshot: collab_phase repair failed", exc_info=True)
        return collab


def find_root_tasks_bound_to_thread(storage: Any, thread_id: str) -> list[tuple[dict[str, Any], dict[str, Any]]]:
    """All top-level tasks whose ``thread_id`` matches the LangGraph chat thread."""
    out: list[tuple[dict[str, Any], dict[str, Any]]] = []
    tid = (thread_id or "").strip()
    if not tid:
        return out
    for summary in storage.list_projects():
        project = storage.load_project(summary["id"])
        if not project:
            continue
        for task in project.get("tasks", []) or []:
            if (task.get("thread_id") or "").strip() == tid:
                out.append((project, task))
    return out


def _as_int_progress(v: Any) -> int:
    try:
        if v is None:
            return 0
        return max(0, min(100, int(v)))
    except (TypeError, ValueError):
        return 0


def _as_int_ts_ms(v: Any) -> int:
    try:
        return int(v or 0)
    except (TypeError, ValueError):
        return 0


def build_task_progress_snapshot(paths: Paths, thread_id: str) -> dict[str, Any]:
    """Return JSON-serializable snapshot for the EvoPanel task sidebar (main + subtasks).

    ``supervisor_steps`` mirror persisted ``sidebar_supervisor_steps`` on thread collab state
    (plus live streaming events on connected clients).

    ``collab_phase`` is **inferred** from disk state plus main/subtask rows so it matches
    ``PlanGuardMiddleware`` virtual ``plan_ready`` and terminal ``done`` (and may self-heal
    stuck ``planning`` after all subtasks finish). ``collab_phase_disk`` is the raw persisted
    phase before optional repair.
    """
    storage = get_project_storage()
    mem_store = get_task_detail_storage()
    collab = load_thread_collab_state(paths, thread_id)
    phase_disk = collab.collab_phase.value if hasattr(collab.collab_phase, "value") else str(collab.collab_phase)
    supervisor_steps: list[dict[str, Any]] = [dict(x) for x in (collab.sidebar_supervisor_steps or []) if isinstance(x, dict)]

    def pack(project: dict[str, Any], task: dict[str, Any]) -> dict[str, Any]:
        subs: list[dict[str, Any]] = []
        for st in task.get("subtasks") or []:
            if not isinstance(st, dict):
                continue
            sid = st.get("id")
            if not sid:
                continue
            otc = st.get("observed_tool_calls")
            if not isinstance(otc, list):
                otc = []
            claude_sid = str(st.get("claude_session_id") or st.get("external_session_id") or "").strip() or None
            sub_tid = str(st.get("subtask_thread_id") or "").strip() or None
            wc_raw = st.get("work_checklist")
            work_checklist = [x for x in wc_raw if isinstance(x, dict)] if isinstance(wc_raw, list) else []
            sid_s = str(sid)
            from evoflow.collab.subtask_outcome import get_subtask_task_report, is_subtask_outcome_reported

            task_report = get_subtask_task_report(st)
            subs.append(
                {
                    "subtaskId": sid_s,
                    "parentTaskId": str(task.get("id") or ""),
                    "name": st.get("name"),
                    "description": st.get("description"),
                    "status": st.get("status"),
                    "progress": _as_int_progress(st.get("progress")),
                    "assignedAgent": st.get("assigned_to"),
                    "assignedAgentDisplay": (str(st.get("assigned_agent_name") or st.get("assignedAgentName") or "").strip() or None),
                    "workChecklist": work_checklist,
                    "claude_session_id": claude_sid,
                    "subtask_thread_id": sub_tid,
                    "taskReport": task_report or None,
                    "outcomeReported": is_subtask_outcome_reported(st) if isinstance(st, dict) else False,
                    # For tooltip: backend-observed tool calls (with input/output)
                    "observed_tool_calls": [x for x in otc if isinstance(x, dict)],
                }
            )
        mid = task.get("id")
        lifecycle = pack_main_task_lifecycle_fields(task, collab_phase=phase_disk)
        from evoflow.collab.plan_task_storage import task_has_bound_plan

        goal = str(task.get("plan_goal") or "").strip()
        plan_preview = goal[:480] if goal else ""
        bound_at = str(task.get("plan_bound_at") or "")
        return {
            "main_task": {
                "taskId": str(mid) if mid else None,
                "name": task.get("name"),
                "status": task.get("status"),
                "progress": _as_int_progress(task.get("progress")),
                "bound_plan_ts_ms": _as_int_ts_ms(bound_at),
                "boundPlanPreview": plan_preview,
                "boundPlanReady": task_has_bound_plan(task),
                "planGoal": goal,
                "executionAuthorized": bool(task.get("execution_authorized")),
                "updatedAt": str(task.get("updated_at") or task.get("created_at") or ""),
                **lifecycle,
            },
            "subtasks": subs,
        }

    main_choice: tuple[dict[str, Any], dict[str, Any]] | None = None
    bound = (collab.bound_task_id or "").strip()
    if bound:
        found = find_main_task(storage, bound)
        if found:
            proj, task = found
            bt = (task.get("thread_id") or "").strip()
            if not bt or bt == thread_id.strip():
                main_choice = (proj, task)

    if main_choice is None:
        cands = find_root_tasks_bound_to_thread(storage, thread_id)
        if not cands:
            inf, reason = infer_sidebar_collab_phase(collab, None)
            collab = _maybe_repair_disk_collab_done(paths, thread_id, collab, inf, reason)
            return {
                "thread_id": thread_id,
                "collab_phase": inf,
                "collab_phase_disk": phase_disk,
                "collab_phase_inference": reason if reason != "disk" else None,
                "bound_task_id": collab.bound_task_id,
                "main_task": None,
                "subtasks": [],
                "supervisor_steps": supervisor_steps,
            }

        # Prefer authorized tasks, then latest updated_at / created_at string sort
        def sort_key(item: tuple[dict[str, Any], dict[str, Any]]) -> tuple[Any, ...]:
            _p, t = item
            auth = 1 if t.get("execution_authorized") else 0
            u = str(t.get("updated_at") or t.get("created_at") or "")
            return (auth, u)

        cands.sort(key=sort_key, reverse=True)
        main_choice = cands[0]

    # Best-effort consistency check: reconcile subtask row vs task-memory snapshot.
    try:
        _p0, t0 = main_choice
        mtid = str(t0.get("id") or "").strip()
        if mtid:
            reconcile_subtask_memory_consistency(storage, mem_store, mtid)
    except Exception:
        pass

    packed = pack(main_choice[0], main_choice[1])
    _, task_m = main_choice
    inf, reason = infer_sidebar_collab_phase(collab, task_m)
    mt = packed.get("main_task")
    if isinstance(mt, dict):
        mt.update(pack_main_task_lifecycle_fields(task_m, collab_phase=inf))
    collab = _maybe_repair_disk_collab_done(paths, thread_id, collab, inf, reason)
    return {
        "thread_id": thread_id,
        "collab_phase": inf,
        "collab_phase_disk": phase_disk,
        "collab_phase_inference": reason if reason != "disk" else None,
        "bound_task_id": collab.bound_task_id,
        **packed,
        "supervisor_steps": supervisor_steps,
    }
