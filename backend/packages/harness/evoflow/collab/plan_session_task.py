"""Plan collaboration: one main task per thread from plan-scenario activation onward."""

from __future__ import annotations

import logging
import time
from datetime import datetime
from typing import Any

from evoflow.collab.models import CollabPhase, ProjectStatus, TaskStatus
from evoflow.collab.storage import (
    find_main_task,
    get_project_storage,
    new_project_bundle_root_task,
)
from evoflow.collab.thread_collab import (
    load_thread_collab_state,
    merge_thread_collab_state,
    save_thread_collab_state,
)
from evoflow.config.paths import Paths, get_paths
from evoflow.timeutil import utc_now_iso_z

logger = logging.getLogger(__name__)

DEFAULT_PLAN_PLACEHOLDER_NAME = "规划任务"
DEFAULT_PLAN_PLACEHOLDER_DESCRIPTION = "协作规划占位任务；调用 plan 工具落库后自动从 Steps 同步子任务。"

# 超过该秒数未激活 plan 场景，再次进入时复用同一占位任务并清空未执行的旧 Plan 草稿。
PLAN_SESSION_IDLE_REUSE_SECONDS = 30 * 60

_TERMINAL_MAIN = frozenset({"completed", "failed", "cancelled"})
_REUSABLE_MAIN = frozenset({"pending", "planning", "planned", "waiting_dispatch", ""})
_ACTIVE_SUBTASK_STATUSES = frozenset(
    {
        "executing",
        "running",
        "in_progress",
        "active",
        "completed",
        "done",
        "failed",
        "cancelled",
        "canceled",
        "timed_out",
    }
)


def _apply_chat_plan_session_run_mode(task: dict[str, Any]) -> None:
    """Main-chat plan placeholders require explicit user authorization before execution."""
    task["run_mode"] = "manual"
    if not str(task.get("source") or "").strip():
        task["source"] = "conversation"


def _has_active_subtasks(task: dict[str, Any]) -> bool:
    """True when any subtask has left the plan-only ``planned`` shell."""
    for st in task.get("subtasks") or []:
        if not isinstance(st, dict):
            continue
        status = str(st.get("status") or "").strip().lower().replace("-", "_")
        if status in _ACTIVE_SUBTASK_STATUSES:
            return True
    return False


def _paths(paths: Paths | None) -> Paths:
    return paths if paths is not None else get_paths()


def _parse_iso_to_epoch(iso: str) -> float | None:
    s = str(iso or "").strip()
    if not s:
        return None
    try:
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        return datetime.fromisoformat(s).timestamp()
    except Exception:
        return None


def _plan_session_last_active_ms(task: dict[str, Any]) -> int:
    raw = task.get("plan_session_last_active_at") or task.get("updated_at") or task.get("created_at")
    if isinstance(raw, (int, float)):
        return int(raw)
    ts = _parse_iso_to_epoch(str(raw))
    if ts is not None:
        return int(ts * 1000)
    return 0


def _has_plan_session_markers(task: dict[str, Any]) -> bool:
    return task.get("plan_session_placeholder") is True or bool(str(task.get("plan_session_initialized_at") or "").strip()) or bool(str(task.get("plan_session_last_active_at") or "").strip())


def _is_plan_placeholder_task(task: dict[str, Any], *, allow_legacy_bound_shell: bool = False) -> bool:
    """True for plan-scenario shell tasks (not arbitrary main tasks on the same thread)."""
    if _has_active_subtasks(task):
        return False
    status = str(task.get("status") or "").strip().lower()
    if bool(task.get("execution_authorized")) and status in {
        TaskStatus.EXECUTING.value,
        "running",
        "in_progress",
    }:
        return False
    if status in _TERMINAL_MAIN:
        return False
    if _has_plan_session_markers(task):
        return True
    if not allow_legacy_bound_shell:
        return False
    return status in {TaskStatus.PLANNING.value, TaskStatus.PLANNED.value, "pending", "waiting_dispatch", ""}


def _task_row_usable_for_plan_session(
    task: dict[str, Any],
    *,
    thread_id: str,
    preferred_task_id: str = "",
) -> bool:
    if str(task.get("thread_id") or "").strip() != thread_id:
        return False
    tid = str(task.get("id") or "").strip()
    pref = str(preferred_task_id or "").strip()
    allow_legacy = bool(pref and tid == pref)
    return _is_plan_placeholder_task(task, allow_legacy_bound_shell=allow_legacy)


def _find_reusable_plan_placeholder(
    storage: Any,
    thread_id: str,
    *,
    preferred_task_id: str = "",
) -> tuple[dict[str, Any], dict[str, Any]] | None:
    """Pick the newest plan placeholder for this thread (avoids duplicate shells on re-toggle)."""
    tid = str(thread_id or "").strip()
    if not tid:
        return None

    best: tuple[dict[str, Any], dict[str, Any]] | None = None
    best_ms = -1

    def _consider(project: dict[str, Any], task: dict[str, Any]) -> None:
        nonlocal best, best_ms
        if not _task_row_usable_for_plan_session(task, thread_id=tid, preferred_task_id=pref):
            return
        ms = _plan_session_last_active_ms(task)
        if ms > best_ms:
            best_ms = ms
            best = (project, task)

    pref = str(preferred_task_id or "").strip()
    if pref:
        row = find_main_task(storage, pref)
        if row:
            _consider(row[0], row[1])

    for summary in storage.list_projects():
        pid = str(summary.get("id") or "").strip()
        if not pid:
            continue
        project = storage.load_project(pid)
        if not project:
            continue
        for task in project.get("tasks") or []:
            if not isinstance(task, dict):
                continue
            if pref and str(task.get("id") or "").strip() == pref:
                continue
            _consider(project, task)

    return best


def _reset_stale_plan_shell(task: dict[str, Any]) -> bool:
    """Clear abandoned plan draft when re-entering plan after long idle."""
    from evoflow.collab.plan_task_storage import clear_plan_fields, task_has_bound_plan

    changed = False
    if task_has_bound_plan(task):
        clear_plan_fields(task)
        changed = True
    subs = task.get("subtasks") or []
    if subs:
        kept = [
            st
            for st in subs
            if isinstance(st, dict)
            and str(st.get("status") or "").strip().lower().replace("-", "_") in _ACTIVE_SUBTASK_STATUSES
        ]
        if len(kept) != len(subs):
            task["subtasks"] = kept
            changed = True
    if bool(task.get("execution_authorized")):
        task["execution_authorized"] = False
        task.pop("authorized_at", None)
        task.pop("authorized_by", None)
        changed = True
    status = str(task.get("status") or "").strip().lower()
    if status not in {TaskStatus.PLANNING.value, "pending"}:
        task["status"] = TaskStatus.PLANNING.value
        changed = True
    if int(task.get("progress") or 0) != 0:
        task["progress"] = 0
        changed = True
    return changed


def _touch_plan_session(
    storage: Any,
    project: dict[str, Any],
    task: dict[str, Any],
    *,
    now_epoch: float | None = None,
) -> tuple[bool, bool]:
    """Bump last-active time; optionally reset shell if idle longer than reuse window.

    Returns:
        (saved_ok, stale_reset_applied)
    """
    now = float(now_epoch if now_epoch is not None else time.time())
    now_iso = utc_now_iso_z()
    last_ms = _plan_session_last_active_ms(task)
    idle_sec = now - (last_ms / 1000.0) if last_ms > 0 else PLAN_SESSION_IDLE_REUSE_SECONDS + 1

    stale_reset = False
    if idle_sec >= PLAN_SESSION_IDLE_REUSE_SECONDS:
        stale_reset = _reset_stale_plan_shell(task)

    task["plan_session_placeholder"] = True
    if not str(task.get("plan_session_initialized_at") or "").strip():
        task["plan_session_initialized_at"] = now_iso
    task["plan_session_last_active_at"] = now_iso
    task["updated_at"] = now_iso
    _apply_chat_plan_session_run_mode(task)
    project["updated_at"] = now_iso

    return bool(storage.save_project(project)), stale_reset


def _task_row_is_terminal(task: dict[str, Any]) -> bool:
    return str(task.get("status") or "").strip().lower() in _TERMINAL_MAIN


def _bound_task_is_terminal(storage: Any, bound_task_id: str | None) -> bool:
    bid = str(bound_task_id or "").strip()
    if not bid:
        return False
    row = find_main_task(storage, bid)
    if not row:
        return False
    _proj, task = row
    return _task_row_is_terminal(task)


def needs_new_plan_cycle(
    collab: Any,
    storage: Any,
    *,
    paths: Paths | None = None,
) -> bool:
    """True when this thread should start a fresh plan placeholder (prior cycle finished)."""
    del paths  # reserved for future disk-only checks
    phase = _norm_phase(collab)
    if phase == CollabPhase.DONE.value:
        return True
    bound = str(getattr(collab, "bound_task_id", None) or "").strip()
    if not bound:
        return False
    return _bound_task_is_terminal(storage, bound)


def _bind_thread_to_task(
    paths: Paths,
    thread_id: str,
    task_id: str,
    *,
    force_planning: bool = False,
) -> None:
    collab = load_thread_collab_state(paths, thread_id)
    phase_patch: dict[str, Any] = {"bound_task_id": task_id}
    phase = _norm_phase(collab)
    if force_planning or phase in {"", CollabPhase.IDLE.value, CollabPhase.DONE.value}:
        phase_patch["collab_phase"] = CollabPhase.PLANNING.value
    save_thread_collab_state(paths, thread_id, merge_thread_collab_state(collab, phase_patch))


def begin_new_plan_cycle(
    thread_id: str,
    *,
    paths: Paths | None = None,
    task_name: str | None = None,
    task_description: str | None = None,
) -> dict[str, Any]:
    """Allocate a new placeholder main task and enter ``planning`` (same thread, new collab cycle)."""
    tid = str(thread_id or "").strip()
    out: dict[str, Any] = {
        "thread_id": tid,
        "newCycle": False,
        "previousTaskId": "",
        "created": False,
        "reused": False,
        "staleReset": False,
        "task_id": "",
        "name": "",
        "status": "",
        "progress": 0,
        "planSessionLastActiveAt": "",
    }
    if not tid:
        return out

    p = _paths(paths)
    storage = get_project_storage()
    collab = load_thread_collab_state(p, tid)
    previous = str(collab.bound_task_id or "").strip()
    if not needs_new_plan_cycle(collab, storage, paths=p):
        out["previousTaskId"] = previous
        out["task_id"] = previous
        if previous:
            row = find_main_task(storage, previous)
            if row:
                _proj, task = row
                out["name"] = str(task.get("name") or "")
                out["status"] = str(task.get("status") or "")
                out["progress"] = int(task.get("progress") or 0)
                out["planSessionLastActiveAt"] = str(task.get("plan_session_last_active_at") or "")
        return out

    nm = str(task_name or "").strip() or DEFAULT_PLAN_PLACEHOLDER_NAME
    desc = str(task_description or "").strip() or DEFAULT_PLAN_PLACEHOLDER_DESCRIPTION
    project_data, task_data = new_project_bundle_root_task(nm, desc, thread_id=tid)
    now_iso = utc_now_iso_z()
    task_data["status"] = TaskStatus.PLANNING.value
    task_data["progress"] = 0
    task_data["plan_session_placeholder"] = True
    task_data["plan_session_initialized_at"] = now_iso
    task_data["plan_session_last_active_at"] = now_iso
    _apply_chat_plan_session_run_mode(task_data)
    project_data["status"] = ProjectStatus.PLANNING.value

    if not storage.save_project(project_data):
        logger.warning("begin_new_plan_cycle: save failed thread=%s", tid)
        return out

    task_id = str(task_data.get("id") or "").strip()
    _bind_thread_to_task(p, tid, task_id, force_planning=True)

    out.update(
        {
            "newCycle": True,
            "previousTaskId": previous,
            "created": True,
            "reused": False,
            "staleReset": False,
            "task_id": task_id,
            "name": nm,
            "status": task_data["status"],
            "progress": 0,
            "planSessionLastActiveAt": now_iso,
        }
    )
    logger.info(
        "begin_new_plan_cycle: task_id=%s thread=%s previous_task_id=%s",
        task_id,
        tid,
        previous or "(none)",
    )
    return out


def ensure_plan_session_task(
    thread_id: str,
    *,
    paths: Paths | None = None,
    task_name: str | None = None,
    task_description: str | None = None,
) -> dict[str, Any]:
    """Ensure this thread has a bound plan placeholder task (reuse within idle window).

    Reuses the latest initialized placeholder for the thread when possible; only creates
    a new row when none exists. Each plan-scenario activation refreshes
    ``plan_session_last_active_at``. If idle for at least ``PLAN_SESSION_IDLE_REUSE_SECONDS``,
    the same task id is reused but stale plan draft fields are cleared.
    """
    tid = str(thread_id or "").strip()
    out: dict[str, Any] = {
        "thread_id": tid,
        "created": False,
        "reused": False,
        "staleReset": False,
        "task_id": "",
        "name": "",
        "status": "",
        "progress": 0,
        "planSessionLastActiveAt": "",
    }
    if not tid:
        return out

    p = _paths(paths)
    storage = get_project_storage()
    collab = load_thread_collab_state(p, tid)
    if needs_new_plan_cycle(collab, storage, paths=p):
        cycle = begin_new_plan_cycle(
            tid,
            paths=p,
            task_name=task_name,
            task_description=task_description,
        )
        if cycle.get("task_id"):
            return cycle
        collab = load_thread_collab_state(p, tid)
    bound = str(collab.bound_task_id or "").strip()

    found = _find_reusable_plan_placeholder(storage, tid, preferred_task_id=bound)
    if found:
        project, task = found
        saved, stale_reset = _touch_plan_session(storage, project, task)
        if not saved:
            logger.warning("ensure_plan_session_task: touch failed thread=%s", tid)
            return out
        task_id = str(task.get("id") or "").strip()
        _bind_thread_to_task(p, tid, task_id)
        out.update(
            {
                "created": False,
                "reused": True,
                "staleReset": stale_reset,
                "task_id": task_id,
                "name": str(task.get("name") or ""),
                "status": str(task.get("status") or TaskStatus.PLANNING.value),
                "progress": int(task.get("progress") or 0),
                "planSessionLastActiveAt": str(task.get("plan_session_last_active_at") or ""),
            }
        )
        logger.info(
            "ensure_plan_session_task: reused task_id=%s thread=%s stale_reset=%s",
            task_id,
            tid,
            stale_reset,
        )
        return out

    nm = str(task_name or "").strip() or DEFAULT_PLAN_PLACEHOLDER_NAME
    desc = str(task_description or "").strip() or DEFAULT_PLAN_PLACEHOLDER_DESCRIPTION
    project_data, task_data = new_project_bundle_root_task(nm, desc, thread_id=tid)
    now_iso = utc_now_iso_z()
    task_data["status"] = TaskStatus.PLANNING.value
    task_data["progress"] = 0
    task_data["plan_session_placeholder"] = True
    task_data["plan_session_initialized_at"] = now_iso
    task_data["plan_session_last_active_at"] = now_iso
    _apply_chat_plan_session_run_mode(task_data)
    project_data["status"] = ProjectStatus.PLANNING.value

    if not storage.save_project(project_data):
        logger.warning("ensure_plan_session_task: save failed thread=%s", tid)
        return out

    task_id = str(task_data.get("id") or "").strip()
    _bind_thread_to_task(p, tid, task_id)

    out.update(
        {
            "created": True,
            "reused": False,
            "staleReset": False,
            "task_id": task_id,
            "name": nm,
            "status": task_data["status"],
            "progress": 0,
            "planSessionLastActiveAt": now_iso,
        }
    )
    logger.info("ensure_plan_session_task: created placeholder task_id=%s thread=%s", task_id, tid)
    return out


def _norm_phase(collab: Any) -> str:
    raw = collab.collab_phase.value if hasattr(collab.collab_phase, "value") else collab.collab_phase
    return str(raw or "").strip().lower()


def try_reuse_bound_plan_root_task(
    storage: Any,
    thread_id: str | None,
    task_name: str,
    task_description: str,
    *,
    paths: Paths | None = None,
) -> tuple[dict[str, Any], dict[str, Any]] | None:
    """Reuse bound placeholder task for supervisor create (fill name, keep plan binding)."""
    tid = str(thread_id or "").strip()
    if not tid:
        return None
    collab = load_thread_collab_state(_paths(paths), tid)
    bound = str(collab.bound_task_id or "").strip()
    row = _find_reusable_plan_placeholder(storage, tid, preferred_task_id=bound)
    if not row:
        return None
    project, task = row
    nm = str(task_name or "").strip()
    desc = str(task_description or "").strip()
    if nm:
        task["name"] = nm
        project["name"] = nm
    if desc:
        task["description"] = desc
    status = str(task.get("status") or "").strip().lower()
    if status in _REUSABLE_MAIN:
        from evoflow.collab.plan_task_storage import task_has_bound_plan

        task["status"] = TaskStatus.PLANNED.value if task_has_bound_plan(task) else TaskStatus.PLANNING.value
    saved, _ = _touch_plan_session(storage, project, task)
    if not saved:
        return None
    _bind_thread_to_task(_paths(paths), tid, str(task.get("id") or ""))
    return project, task


def assert_thread_plan_task_binding(thread_id: str, bound_task_id: str, *, paths: Paths | None = None) -> str | None:
    """Return an error message when ``bound_task_id`` does not match this thread's plan task."""
    tid = str(thread_id or "").strip()
    want = str(bound_task_id or "").strip()
    if not tid or not want:
        return None
    p = _paths(paths)
    storage = get_project_storage()
    collab = load_thread_collab_state(p, tid)
    bound = str(collab.bound_task_id or "").strip()
    if bound and bound != want:
        return (
            f"bound_task_id '{want}' does not match this thread's bound task '{bound}'. "
            "Use boundTaskId from the latest plan() on this session, or omit bound_task_id."
        )
    row = find_main_task(storage, want)
    if not row:
        return f"Task '{want}' not found."
    _proj, task = row
    task_thread = str(task.get("thread_id") or "").strip()
    if task_thread and task_thread != tid:
        return f"Task '{want}' belongs to thread '{task_thread}', not '{tid}'."
    return None


def bind_plan_to_thread_task(
    thread_id: str,
    *,
    goal: str,
    steps: list[dict[str, Any]],
    flowchart_mermaid: str | None = None,
    validation: list[str] | str | None = None,
    open_questions: str = "无",
    paths: Paths | None = None,
) -> dict[str, Any]:
    """Persist structured plan on the thread-bound main task row (``evoflow_collab_tasks``)."""

    tid = str(thread_id or "").strip()
    goal_text = str(goal or "").strip()
    step_list = [s for s in (steps or []) if isinstance(s, dict)]
    out: dict[str, Any] = {"thread_id": tid, "task_id": "", "bound": False}
    if not tid or not goal_text or not step_list:
        return out

    p = _paths(paths)
    try:
        from evoflow.persistence.db import get_db
        from evoflow.persistence.task_repositories import _ensure_plan_columns_compat

        _ensure_plan_columns_compat(get_db())
    except Exception:
        logger.debug("bind_plan: ensure plan columns failed", exc_info=True)
    storage = get_project_storage()
    collab = load_thread_collab_state(p, tid)
    new_cycle_meta: dict[str, Any] | None = None
    if needs_new_plan_cycle(collab, storage, paths=p):
        new_cycle_meta = begin_new_plan_cycle(tid, paths=p)
        collab = load_thread_collab_state(p, tid)
    pref = str(collab.bound_task_id or "").strip()
    had_plan = False
    had_execution_auth = False
    if pref:
        row0 = find_main_task(storage, pref)
        if row0:
            from evoflow.collab.plan_task_storage import task_has_bound_plan

            had_plan = task_has_bound_plan(row0[1])
            had_execution_auth = bool(row0[1].get("execution_authorized"))

    task_id = ""
    if pref:
        bound_row = find_main_task(storage, pref)
        if bound_row:
            project_b, task_b = bound_row
            if (
                not _task_row_is_terminal(task_b)
                and str(task_b.get("thread_id") or "").strip() in {"", tid}
            ):
                saved_touch, _ = _touch_plan_session(storage, project_b, task_b)
                if saved_touch:
                    task_id = pref
                    _bind_thread_to_task(p, tid, task_id)
    if not task_id:
        meta = ensure_plan_session_task(tid, paths=paths)
        if meta.get("newCycle"):
            new_cycle_meta = meta
        task_id = str(meta.get("task_id") or "").strip()
    out["task_id"] = task_id
    if new_cycle_meta and new_cycle_meta.get("newCycle"):
        out["newCycle"] = True
        out["previousTaskId"] = str(new_cycle_meta.get("previousTaskId") or "").strip()
    if not task_id:
        return out

    row = find_main_task(storage, task_id)
    if not row:
        return out
    project, task = row
    import json

    from evoflow.collab.plan_task_storage import load_plan_steps

    old_sig = (
        json.dumps(
            {"goal": str(task.get("plan_goal") or "").strip(), "steps": load_plan_steps(task)},
            ensure_ascii=False,
            sort_keys=True,
        )
        if had_plan
        else ""
    )
    new_sig = json.dumps({"goal": goal_text, "steps": step_list}, ensure_ascii=False, sort_keys=True)
    plan_revised = bool(old_sig) and old_sig != new_sig
    auth_revoked = False
    if plan_revised and had_execution_auth:
        from evoflow.collab.authorize_execution import revoke_main_task_execution_authorization
        from evoflow.collab.thread_collab import advance_collab_phase_to_plan_ready_for_task

        auth_revoked, _ = revoke_main_task_execution_authorization(storage, task_id)
        try:
            advance_collab_phase_to_plan_ready_for_task(_paths(paths), task_id)
        except Exception:
            logger.debug("bind_plan: revert collab to plan_ready failed", exc_info=True)
        row2 = find_main_task(storage, task_id)
        if row2:
            project, task = row2

    from evoflow.collab.plan_task_storage import write_plan_fields

    write_plan_fields(
        task,
        goal=goal_text,
        steps=step_list,
        flowchart_mermaid=flowchart_mermaid,
        validation=validation,
        open_questions=open_questions,
    )
    from evoflow.collab.plan_task_storage import sync_main_task_identity_from_plan_goal

    sync_main_task_identity_from_plan_goal(task, project, goal_text)
    if str(task.get("status") or "").strip().lower() not in _TERMINAL_MAIN:
        task["status"] = TaskStatus.PLANNED.value
        project["status"] = TaskStatus.PLANNED.value
        # 规划/定稿阶段主任务未开始执行，进度保持 0（与任务管理列表一致）。
        task["progress"] = 0
    saved, _ = _touch_plan_session(storage, project, task)
    if not saved:
        out["bindError"] = (
            "无法保存计划到任务表（常见原因：数据库缺少 plan_goal 等列）。"
            "请完全重启 EvoFlow Gateway 后再提交 plan；若仍失败，请检查 data/evoflow.db 是否可写。"
        )
        return out
    out["planRevised"] = plan_revised
    out["authorizationRevoked"] = auth_revoked
    out["bound"] = True
    out["status"] = task.get("status")
    out["progress"] = int(task.get("progress") or 0)
    out["planSessionLastActiveAt"] = str(task.get("plan_session_last_active_at") or "")
    try:
        from evoflow.collab.plan_subtasks_sync import load_bound_plan_steps, sync_subtasks_from_plan_steps

        steps_for_sync = load_bound_plan_steps(task)
        if steps_for_sync:
            out["subtasksSync"] = sync_subtasks_from_plan_steps(
                task_id,
                steps_for_sync,
                storage=storage,
                goal=goal_text,
            )
        else:
            out["subtasksSync"] = {
                "success": False,
                "task_id": task_id,
                "warnings": ["structured_steps_required"],
            }
    except Exception:
        logger.warning("bind_plan: sync subtasks from plan failed", exc_info=True)
    if out.get("bound"):
        try:
            from evoflow.collab.thread_collab import advance_collab_phase_to_plan_ready_for_task

            advance_collab_phase_to_plan_ready_for_task(_paths(paths), task_id)
        except Exception:
            logger.debug("bind_plan: advance to plan_ready failed", exc_info=True)
    return out


def bind_plan_markdown_to_thread_task(
    thread_id: str,
    markdown: str,
    *,
    paths: Paths | None = None,
    structured_steps: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Deprecated: markdown plans are no longer stored. Use ``bind_plan_to_thread_task``."""
    del markdown
    steps = structured_steps or []
    if not steps:
        return {"thread_id": thread_id, "task_id": "", "bound": False, "error": "structured_steps_required"}
    goal = ""
    if steps and isinstance(steps[0], dict):
        goal = str(steps[0].get("goal") or "").strip()
    return bind_plan_to_thread_task(
        thread_id,
        goal=goal or "计划",
        steps=steps,
        paths=paths,
    )


__all__ = [
    "DEFAULT_PLAN_PLACEHOLDER_NAME",
    "DEFAULT_PLAN_PLACEHOLDER_DESCRIPTION",
    "PLAN_SESSION_IDLE_REUSE_SECONDS",
    "begin_new_plan_cycle",
    "needs_new_plan_cycle",
    "ensure_plan_session_task",
    "try_reuse_bound_plan_root_task",
    "assert_thread_plan_task_binding",
    "bind_plan_to_thread_task",
    "bind_plan_markdown_to_thread_task",
]
