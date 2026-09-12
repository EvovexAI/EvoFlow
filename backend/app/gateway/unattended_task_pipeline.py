"""Unattended (zero-touch) main-task pipeline: Lead plan → authorize → dispatch."""

from __future__ import annotations

import asyncio
import json
import logging
import os
from datetime import UTC, datetime, timedelta
from typing import Any

from evoflow.collab.authorize_execution import authorize_main_task_execution, is_task_execution_authorized
from evoflow.collab.dispatch_authorized_execution import dispatch_authorized_main_task_execution
from evoflow.collab.plan_task_storage import task_has_bound_plan
from evoflow.collab.storage import find_main_task, get_project_storage, rollup_root_task_progress_from_subtasks
from evoflow.collab.thread_collab import (
    advance_collab_phase_to_awaiting_exec_for_task,
    advance_collab_phase_to_executing_for_task,
    load_thread_collab_state,
    merge_thread_collab_state,
    save_thread_collab_state,
)
from evoflow.collab.user_execution_confirm import mark_user_execution_confirmed
from evoflow.config.paths import get_paths
from evoflow.timeutil import utc_now_iso_z

logger = logging.getLogger(__name__)

RUN_MODE_UNATTENDED = "unattended"
RUN_MODE_MANUAL = "manual"

_TERMINAL = frozenset({"completed", "failed", "cancelled"})
_ACTIVE_SUB = frozenset({"executing", "running", "in_progress", "planning", "pending", "active", "planned", "waiting_dispatch"})
_TERMINAL_SUB = frozenset({"completed", "done", "success", "failed", "error", "cancelled", "canceled", "timed_out", "skipped"})
_PLAN_STALE_SECONDS = 20 * 60
_DISPATCH_RETRY_MAX = 3

# Per-task advancement lock (prevents overlapping ticks on the same row)
_advance_locks: dict[str, asyncio.Lock] = {}
_advance_locks_guard: asyncio.Lock | None = None

DEFAULT_LANGGRAPH_URL = "http://127.0.0.1:8070/api/langgraph"
DEFAULT_ASSISTANT_ID = "lead_agent"


def task_queue_max_retries() -> int:
    raw = (os.getenv("EVOFLOW_TASK_QUEUE_RETRY_MAX") or "3").strip()
    try:
        return max(0, int(raw))
    except ValueError:
        return 3


def task_queue_retry_delays_seconds() -> list[int]:
    raw = (os.getenv("EVOFLOW_TASK_QUEUE_RETRY_DELAYS") or "60,300,900").strip()
    out: list[int] = []
    for part in raw.split(","):
        part = part.strip()
        if not part:
            continue
        try:
            out.append(max(1, int(part)))
        except ValueError:
            continue
    return out or [60, 300, 900]


def is_unattended_task(task: dict[str, Any]) -> bool:
    """Only tasks explicitly created with ``run_mode=unattended`` enter the zero-touch queue."""
    if task.get("plan_session_placeholder") is True:
        return False
    # 随手待办绝不入队，即使误写了 run_mode
    if str(task.get("status") or "").strip().lower() == "inbox":
        return False
    return str(task.get("run_mode") or "").strip().lower() == RUN_MODE_UNATTENDED


def _parse_iso(raw: str | None) -> datetime | None:
    s = str(raw or "").strip()
    if not s:
        return None
    try:
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=UTC)
        return dt
    except Exception:
        return None


def _retry_due(task: dict[str, Any]) -> bool:
    nxt = _parse_iso(str(task.get("unattended_next_retry_at") or ""))
    if nxt is None:
        return True
    return datetime.now(UTC) >= nxt


def _schedule_retry(task: dict[str, Any]) -> None:
    attempts = int(task.get("unattended_attempts") or 0)
    delays = task_queue_retry_delays_seconds()
    delay = delays[min(attempts, len(delays) - 1)] if delays else 60
    task["unattended_next_retry_at"] = (datetime.now(UTC) + timedelta(seconds=delay)).isoformat().replace("+00:00", "Z")


def _save_task_row(project: dict[str, Any], task_index: int, task: dict[str, Any]) -> bool:
    project["tasks"][task_index] = task
    project["updated_at"] = utc_now_iso_z()
    return get_project_storage().save_project(project)


def _patch_task(task_id: str, mutator) -> dict[str, Any] | None:
    storage = get_project_storage()
    row = find_main_task(storage, task_id)
    if not row:
        return None
    project, task = row
    idx = next(i for i, t in enumerate(project.get("tasks") or []) if t.get("id") == task_id)
    updated = mutator(dict(task))
    if updated is None:
        return None
    if not _save_task_row(project, idx, updated):
        return None
    return updated


def _has_active_subtasks(task: dict[str, Any]) -> bool:
    subs = task.get("subtasks") or []
    return any(
        str(s.get("status") or "").strip().lower() in _ACTIVE_SUB for s in subs if isinstance(s, dict)
    )


_IN_FLIGHT_SUB = frozenset({"executing", "running", "in_progress"})


def _has_in_flight_subtasks(task: dict[str, Any]) -> bool:
    """True when at least one subtask is actively running (not merely pending/planned)."""
    subs = task.get("subtasks") or []
    return any(
        str(s.get("status") or "").strip().lower() in _IN_FLIGHT_SUB for s in subs if isinstance(s, dict)
    )


def _all_subtasks_terminal(task: dict[str, Any]) -> bool:
    subs = [s for s in (task.get("subtasks") or []) if isinstance(s, dict)]
    if not subs:
        return False
    return all(str(s.get("status") or "").strip().lower() in _TERMINAL_SUB for s in subs)


def _all_subtasks_success(task: dict[str, Any]) -> bool:
    subs = [s for s in (task.get("subtasks") or []) if isinstance(s, dict)]
    if not subs:
        return False
    ok = frozenset({"completed", "done", "success"})
    return all(str(s.get("status") or "").strip().lower() in ok for s in subs)


async def _advance_lock_for(task_id: str) -> asyncio.Lock:
    global _advance_locks_guard
    if _advance_locks_guard is None:
        _advance_locks_guard = asyncio.Lock()
    async with _advance_locks_guard:
        if task_id not in _advance_locks:
            _advance_locks[task_id] = asyncio.Lock()
        return _advance_locks[task_id]


def _prepare_unattended_plan_context(task_id: str, thread_id: str, *, enter_planning: bool = True) -> None:
    """Bind task to thread; optionally enter plan collaboration phase (only before first plan)."""
    from evoflow.collab.plan_session_task import _bind_thread_to_task

    paths = get_paths()
    _bind_thread_to_task(paths, thread_id, task_id, force_planning=enter_planning)
    collab = load_thread_collab_state(paths, thread_id)
    patch: dict[str, Any] = {"bound_task_id": task_id}
    if enter_planning:
        patch["activated_scenarios"] = ["plan"]
    save_thread_collab_state(
        paths,
        thread_id,
        merge_thread_collab_state(collab, patch),
    )
    if enter_planning:
        try:
            from evoflow.agents.automation_runtime import bootstrap_unattended_automation_scenarios
            from evoflow.tools.builtins.scenario_activation import (
                hydrate_activated_scenarios_context_var_from_disk,
                replace_activated_scenarios_from_mission_list,
            )

            bootstrap_unattended_automation_scenarios(thread_id=thread_id, scenarios=["plan"])
            replace_activated_scenarios_from_mission_list(["plan"])
            hydrate_activated_scenarios_context_var_from_disk(thread_id)
        except Exception:
            logger.debug("unattended_pipeline: plan scenario hydrate skipped thread=%s", thread_id, exc_info=True)


def _build_unattended_plan_prompt(task_id: str, task: dict[str, Any], thread_id: str) -> str:
    name = str(task.get("name") or "未命名任务").strip() or "未命名任务"
    desc = str(task.get("description") or "").strip() or "（无）"
    return f"""【系统】任务中心无人值守模式：请为以下主任务制定结构化执行计划。

任务名称：{name}
任务说明：{desc}
任务 ID：{task_id}

要求：
1. 若无歧义可跳过 ask_clarification；有歧义时先澄清再规划。
2. 必须调用 plan 工具提交 goal + steps，绑定到本任务（bound_task_id={task_id}），同步子任务 DAG。
3. 规划完成后停止；不要询问用户是否开始执行，系统会自动授权并派发。

会话 thread_id：{thread_id}
"""


def _plan_trigger_stale(task: dict[str, Any]) -> bool:
    triggered_at = _parse_iso(str(task.get("unattended_plan_triggered_at") or ""))
    if triggered_at is None:
        return True
    return (datetime.now(UTC) - triggered_at).total_seconds() >= _PLAN_STALE_SECONDS


async def _trigger_unattended_plan_run(task_id: str, thread_id: str, task: dict[str, Any]) -> bool:
    """Start Lead Agent plan turn via background stream worker."""
    from app.gateway.streaming.background_worker import StreamBackgroundWorker
    from evoflow.runtime.long_run_limits import LONG_RUN_RECURSION_LIMIT

    prompt_text = _build_unattended_plan_prompt(task_id, task, thread_id)
    run_config = {
        "recursion_limit": LONG_RUN_RECURSION_LIMIT,
        "configurable": {
            "task_id": task_id,
            "collab_task_id": task_id,
            "collab_phase": "planning",
            "is_plan_mode": True,
            "triggered_by": "unattended_task_queue",
        },
    }
    run_body = json.dumps(
        {
            "assistant_id": DEFAULT_ASSISTANT_ID,
            "input": {"messages": [{"role": "human", "content": prompt_text}]},
            "config": run_config,
            "stream_mode": "messages-tuple",
            "multitask_strategy": "enqueue",
        },
        ensure_ascii=False,
    ).encode("utf-8")

    langgraph_url = os.getenv("EVOFLOW_LANGGRAPH_URL", DEFAULT_LANGGRAPH_URL).strip()
    worker, is_new = await StreamBackgroundWorker.get_or_create_with_langgraph(
        thread_id=thread_id,
        langgraph_path=f"threads/{thread_id}/runs/stream",
        request_method="POST",
        request_body=run_body,
        request_headers={"content-type": "application/json"},
    )
    if is_new:
        await worker.start()
        logger.info("unattended_pipeline: plan worker started task_id=%s thread_id=%s url=%s", task_id, thread_id, langgraph_url)
        return True

    if StreamBackgroundWorker.is_worker_running(thread_id):
        logger.info("unattended_pipeline: plan worker already running task_id=%s thread_id=%s", task_id, thread_id)
        return False

    # Stale registry entry — replace and start a fresh plan run.
    stale = await StreamBackgroundWorker.pop_stale_worker(thread_id)
    if stale is not None:
        try:
            await stale.cancel()
        except Exception:
            logger.debug("unattended_pipeline: stale worker cancel failed thread=%s", thread_id, exc_info=True)

    worker, is_new = await StreamBackgroundWorker.get_or_create_with_langgraph(
        thread_id=thread_id,
        langgraph_path=f"threads/{thread_id}/runs/stream",
        request_method="POST",
        request_body=run_body,
        request_headers={"content-type": "application/json"},
    )
    await worker.start()
    logger.info("unattended_pipeline: plan worker restarted task_id=%s thread_id=%s", task_id, thread_id)
    return True


async def _maybe_trigger_unattended_plan(task_id: str, thread_id: str, task: dict[str, Any]) -> str:
    """Return action token: plan_triggered | plan_in_progress | plan_retry."""
    from app.gateway.streaming.background_worker import StreamBackgroundWorker

    if StreamBackgroundWorker.is_worker_running(thread_id):
        return "plan_in_progress"
    triggered_at = str(task.get("unattended_plan_triggered_at") or "").strip()
    if triggered_at and not _plan_trigger_stale(task):
        # Triggered recently but worker not running — only wait during brief startup race.
        triggered_dt = _parse_iso(triggered_at)
        if triggered_dt is not None and (datetime.now(UTC) - triggered_dt).total_seconds() < 45:
            return "plan_in_progress"
        logger.warning(
            "unattended_pipeline: plan trigger stale/missing worker task_id=%s thread_id=%s triggered_at=%s",
            task_id,
            thread_id,
            triggered_at,
        )

    had_prior_trigger = bool(str(task.get("unattended_plan_triggered_at") or "").strip())
    started = await _trigger_unattended_plan_run(task_id, thread_id, task)

    def _mark(t: dict[str, Any]) -> dict[str, Any]:
        t["unattended_plan_triggered_at"] = utc_now_iso_z()
        t["status"] = "planning"
        t["unattended_stage"] = "planning"
        return t

    _patch_task(task_id, _mark)
    if not started and StreamBackgroundWorker.is_worker_running(thread_id):
        return "plan_in_progress"
    return "plan_retry" if had_prior_trigger else "plan_triggered"


async def _ensure_langgraph_thread(task_id: str, task: dict[str, Any]) -> str | None:
    from evoflow.collab.thread_ids import is_langgraph_lead_thread_id, resolve_langgraph_lead_thread_id

    raw = str(task.get("thread_id") or task.get("current_execution_thread_id") or "").strip()
    tid = resolve_langgraph_lead_thread_id(raw) or ""

    langgraph_url = os.getenv("EVOFLOW_LANGGRAPH_URL", DEFAULT_LANGGRAPH_URL).strip()
    if tid and is_langgraph_lead_thread_id(tid):
        try:
            from langgraph_sdk import get_client

            client = get_client(url=langgraph_url)
            await client.threads.get(tid)
            return tid
        except Exception:
            logger.warning(
                "unattended_pipeline: stored thread_id=%r unusable for task_id=%s, creating new LangGraph thread",
                raw or tid,
                task_id,
            )
            tid = ""
    elif raw:
        logger.warning(
            "unattended_pipeline: ignoring non-UUID thread_id=%r for task_id=%s, creating new LangGraph thread",
            raw,
            task_id,
        )

    try:
        from langgraph_sdk import get_client

        client = get_client(url=langgraph_url)
        thread = await client.threads.create(
            metadata={
                "task_id": task_id,
                "source": "unattended_task_pipeline",
                "run_mode": RUN_MODE_UNATTENDED,
                **({"replaced_thread_id": raw} if raw else {}),
            }
        )
        thread_id = str(thread.get("thread_id") or "").strip()
        if not thread_id:
            return None

        def _set_thread(t: dict[str, Any]) -> dict[str, Any]:
            t["thread_id"] = thread_id
            t["current_execution_thread_id"] = thread_id
            t["unattended_stage"] = t.get("unattended_stage") or "planning"
            if str(t.get("status") or "").strip().lower() in {"", "pending"}:
                t["status"] = "planning"
            return t

        patched = _patch_task(task_id, _set_thread)
        return str(patched.get("thread_id") or thread_id) if patched else thread_id
    except Exception:
        logger.exception("unattended_pipeline: thread create failed task_id=%s", task_id)
        return None


def _finalize_executing_task(task_id: str) -> dict[str, Any] | None:
    """When all subtasks are terminal, rollup progress and close the main task."""
    storage = get_project_storage()
    row = find_main_task(storage, task_id)
    if not row:
        return None
    _project, task = row
    status = str(task.get("status") or "").strip().lower()
    if status != "executing" or not (task.get("subtasks") or []):
        return None
    try:
        from evoflow.tools.builtins.supervisor.dependency import (
            skip_subtasks_blocked_by_exhausted_upstream_failure,
            subtask_auto_retry_max,
        )

        skip_subtasks_blocked_by_exhausted_upstream_failure(
            storage,
            task_id,
            max_auto_retries=subtask_auto_retry_max(),
        )
        row = find_main_task(storage, task_id)
        if row:
            _project, task = row
    except Exception:
        logger.debug("unattended_pipeline: skip blocked subtasks failed task_id=%s", task_id, exc_info=True)
    if _has_active_subtasks(task) or not _all_subtasks_terminal(task):
        return None

    rollup_root_task_progress_from_subtasks(storage, task_id)
    row = find_main_task(storage, task_id)
    if not row:
        return None
    _project, task = row

    if _all_subtasks_success(task):
        try:
            from evoflow.tools.builtins.supervisor.execution import _verify_upstream_artifacts_before_followup

            _verify_upstream_artifacts_before_followup(storage, task_id)
            row = find_main_task(storage, task_id)
            if row:
                _project, task = row
        except Exception:
            logger.warning("unattended_pipeline: artifact verification failed task_id=%s", task_id, exc_info=True)

        if not _all_subtasks_success(task):
            final_status = str(task.get("status") or "executing").strip().lower()
            return {"task_id": task_id, "ok": True, "action": "artifact_check_failed", "status": final_status}

        def _complete(t: dict[str, Any]) -> dict[str, Any]:
            t["status"] = "completed"
            t["progress"] = 100
            t["unattended_stage"] = "completed"
            t["completed_at"] = utc_now_iso_z()
            return t

        _patch_task(task_id, _complete)
        return {"task_id": task_id, "ok": True, "action": "completed", "status": "completed"}

    final_status = str(task.get("status") or "executing").strip().lower()
    if final_status in _TERMINAL:
        return {"task_id": task_id, "ok": True, "action": "finalized", "status": final_status}

    # All subtasks are terminal but some failed -> mark main task as failed.
    # Without this, the task stays "executing" and is picked up every tick by
    # list_unattended_in_progress -> _finalize_executing_task -> same result,
    # forming an infinite death loop.
    def _fail(t: dict[str, Any]) -> dict[str, Any]:
        t["status"] = "failed"
        t["unattended_stage"] = "failed"
        t["failed_at"] = utc_now_iso_z()
        return t

    _patch_task(task_id, _fail)
    logger.warning(
        "unattended_pipeline: main task marked failed - subtasks terminal but not all success task_id=%s",
        task_id,
    )
    return {"task_id": task_id, "ok": True, "action": "failed", "status": "failed"}


async def _notify_lead_agent_task_failed(task_id: str, task: dict[str, Any]) -> None:
    """Broadcast task:failed and trigger a Lead Agent follow-up run so it can
    report the failure to the user or take corrective action (retry / re-plan).

    Called from ``_advance_unattended_task_impl`` right after ``_finalize_executing_task``
    marks the main task as ``failed`` due to subtask failures.
    """
    # 1. Broadcast task:failed SSE event for UI + collab listeners.
    try:
        from evoflow.collab.sse_notify import broadcast_collab_task_event

        await broadcast_collab_task_event(
            task_id,
            "task:failed",
            {"task_id": task_id, "error": "One or more subtasks failed"},
        )
    except Exception:
        logger.debug("broadcast task:failed after finalize failed task_id=%s", task_id, exc_info=True)

    # 2. Cancel the supervisor background monitor - the task is terminal now,
    #    no need to keep polling.
    try:
        from evoflow.tools.builtins.supervisor.monitor import _bg_task_monitors, _cleanup_monitor_state_for_task

        monitor_task = _bg_task_monitors.pop(task_id, None)
        if monitor_task and not monitor_task.done():
            monitor_task.cancel()
            try:
                await monitor_task
            except BaseException:
                pass
            logger.info("cancelled supervisor monitor for failed task_id=%s", task_id)
        _cleanup_monitor_state_for_task(task_id)
    except Exception:
        logger.debug("cancel supervisor monitor for failed task failed task_id=%s", task_id, exc_info=True)

    # 3. Trigger a Lead Agent follow-up run so it can report the failure to the user.
    thread_id = str(task.get("thread_id") or "").strip()
    if thread_id:
        try:
            from evoflow.tools.builtins.supervisor.monitor import _trigger_lead_follow_run

            failed_ids = [
                str(st.get("id") or "").strip()
                for st in (task.get("subtasks") or [])
                if str(st.get("status") or "").strip().lower() in ("failed", "error", "timed_out")
            ]
            await _trigger_lead_follow_run(
                thread_id=thread_id,
                main_task_id=task_id,
                recommendation={
                    "action": "retry_or_reassign",
                    "failedSubtaskIds": failed_ids,
                    "reason": "subtasks_failed",
                },
            )
        except Exception:
            logger.debug("trigger lead follow run for failed task failed task_id=%s", task_id, exc_info=True)


async def _advance_unattended_task_impl(task_id: str) -> dict[str, Any]:
    """Advance one unattended task by a single pipeline step."""
    storage = get_project_storage()
    row = find_main_task(storage, task_id)
    if not row:
        return {"task_id": task_id, "ok": False, "error": "not_found"}

    _project, task = row
    if not is_unattended_task(task):
        return {"task_id": task_id, "ok": False, "error": "not_unattended"}

    status = str(task.get("status") or "").strip().lower()
    if status == "paused":
        return {"task_id": task_id, "ok": True, "action": "paused", "status": status}

    if status in _TERMINAL:
        if status == "failed" and _retry_due(task):
            attempts = int(task.get("unattended_attempts") or 0)
            if attempts < task_queue_max_retries():

                def _requeue(t: dict[str, Any]) -> dict[str, Any]:
                    t["status"] = "pending"
                    t["unattended_stage"] = "queued"
                    t["unattended_attempts"] = attempts + 1
                    t["execution_authorized"] = False
                    t["authorized_at"] = None
                    t["authorized_by"] = None
                    t["error"] = None
                    t["failed_at"] = None
                    t["subtasks"] = []
                    t["plan_bound_at"] = None
                    t["plan_goal"] = None
                    t["plan_steps"] = []
                    t["plan_steps_json"] = None
                    t["unattended_plan_triggered_at"] = None
                    t["progress"] = 0
                    _schedule_retry(t)
                    return t

                _patch_task(task_id, _requeue)
                return {"task_id": task_id, "ok": True, "action": "requeued_for_retry", "attempt": attempts + 1}
        return {"task_id": task_id, "ok": True, "action": "terminal", "status": status}

    needs_heal = (
        status == "executing"
        and not (task.get("subtasks") or [])
        and not is_task_execution_authorized(storage, task_id)
    )
    if needs_heal:

        def _heal(t: dict[str, Any]) -> dict[str, Any]:
            t["status"] = "pending"
            t["unattended_stage"] = "queued"
            t["unattended_plan_triggered_at"] = None
            t["progress"] = 0
            return t

        _patch_task(task_id, _heal)
        row = find_main_task(storage, task_id)
        if not row:
            return {"task_id": task_id, "ok": False, "error": "not_found_after_heal"}
        _project, task = row
        status = "pending"

    finalized = _finalize_executing_task(task_id)
    if finalized is not None:
        # When subtasks fail, notify the Lead Agent so it can report to the user
        # or take corrective action (retry / re-plan).
        if finalized.get("action") == "failed":
            await _notify_lead_agent_task_failed(task_id, task)
        return finalized

    if status == "executing" and _has_in_flight_subtasks(task):
        return {"task_id": task_id, "ok": True, "action": "already_active", "status": status}

    # Plan bound while status still planning — promote before authorize/dispatch.
    if status == "planning" and task_has_bound_plan(task):

        def _promote_planned(t: dict[str, Any]) -> dict[str, Any]:
            t["status"] = "planned"
            t["unattended_stage"] = "planned"
            t["plan_bound_at"] = t.get("plan_bound_at") or utc_now_iso_z()
            return t

        _patch_task(task_id, _promote_planned)
        row = find_main_task(storage, task_id)
        if not row:
            return {"task_id": task_id, "ok": False, "error": "not_found_after_promote"}
        _project, task = row
        status = "planned"

    redispatch = status == "planned" and is_task_execution_authorized(storage, task_id)
    if status in {"planned", "awaiting_exec", "waiting_dispatch"} and not redispatch and task_has_bound_plan(task):
        # Plan ready but not yet authorized — fall through to authorize/dispatch below.
        pass
    elif status in {"planned", "awaiting_exec", "waiting_dispatch", "running", "in_progress"} and not redispatch:
        return {"task_id": task_id, "ok": True, "action": "already_active", "status": status}

    from evoflow.collab.app_runner import _dispatch_result_ok, dispatch_workflow_task_now, is_workflow_bound_task

    if is_workflow_bound_task(task) and task_has_bound_plan(task):
        if status == "pending":

            def _promote_pending(t: dict[str, Any]) -> dict[str, Any]:
                t["status"] = "planned"
                return t

            _patch_task(task_id, _promote_pending)
        parsed = await dispatch_workflow_task_now(task_id, authorized_by="system")
        if _dispatch_result_ok(parsed):
            return {"task_id": task_id, "ok": True, "action": "dispatched", "dispatch": parsed}
        err = str((parsed or {}).get("error") or (parsed or {}).get("message") or "dispatch_failed")
        return {"task_id": task_id, "ok": False, "error": err, "dispatch": parsed}

    thread_id = await _ensure_langgraph_thread(task_id, task)
    if not thread_id:
        if is_workflow_bound_task(task) and task_has_bound_plan(task):
            parsed = await dispatch_workflow_task_now(task_id, authorized_by="system")
            if _dispatch_result_ok(parsed):
                return {"task_id": task_id, "ok": True, "action": "dispatched", "dispatch": parsed}
            err = str((parsed or {}).get("error") or (parsed or {}).get("message") or "dispatch_failed")
            return {"task_id": task_id, "ok": False, "error": err, "dispatch": parsed}
        return {"task_id": task_id, "ok": False, "error": "thread_create_failed"}

    row = find_main_task(storage, task_id)
    if not row:
        return {"task_id": task_id, "ok": False, "error": "not_found_after_thread"}
    _project, task = row

    has_plan = task_has_bound_plan(task)
    _prepare_unattended_plan_context(task_id, thread_id, enter_planning=not has_plan)

    row = find_main_task(storage, task_id)
    if not row:
        return {"task_id": task_id, "ok": False, "error": "not_found_after_bind"}
    _project, task = row

    if not task_has_bound_plan(task):
        plan_action = await _maybe_trigger_unattended_plan(task_id, thread_id, task)
        return {"task_id": task_id, "ok": True, "action": plan_action, "status": "planning"}

    from evoflow.collab.plan_subtasks_sync import ensure_subtasks_synced_before_start_execution

    try:
        ensure_subtasks_synced_before_start_execution(task_id, storage=storage)
    except Exception as sync_exc:
        logger.warning("unattended_pipeline: subtasks pre-sync failed task_id=%s: %s", task_id, sync_exc, exc_info=True)
        return {"task_id": task_id, "ok": False, "error": f"subtasks_sync_failed:{sync_exc}"}
    row = find_main_task(storage, task_id)
    if not row:
        return {"task_id": task_id, "ok": False, "error": "not_found_after_sync"}
    _project, task = row

    if not (task.get("subtasks") or []):
        return {"task_id": task_id, "ok": False, "error": "plan_bound_no_subtasks"}

    def _mark_planned(t: dict[str, Any]) -> dict[str, Any]:
        t["status"] = "planned"
        t["unattended_stage"] = "planned"
        t["plan_bound_at"] = t.get("plan_bound_at") or utc_now_iso_z()
        return t

    _patch_task(task_id, _mark_planned)
    row = find_main_task(storage, task_id)
    if not row:
        return {"task_id": task_id, "ok": False, "error": "not_found_after_planned"}
    _project, task = row

    if not is_task_execution_authorized(storage, task_id):
        ok, msg = authorize_main_task_execution(storage, task_id, "system")
        if not ok:
            return {"task_id": task_id, "ok": False, "error": f"authorize_failed:{msg}"}
        try:
            mark_user_execution_confirmed(get_paths(), thread_id)
            advance_collab_phase_to_awaiting_exec_for_task(get_paths(), task_id, runtime_thread_id=thread_id)
        except Exception:
            logger.debug("unattended_pipeline: collab phase advance skipped task_id=%s", task_id, exc_info=True)

        def _mark_auth(t: dict[str, Any]) -> dict[str, Any]:
            t["unattended_stage"] = "authorized"
            return t

        _patch_task(task_id, _mark_auth)

    dispatch_result = await dispatch_authorized_main_task_execution(
        task_id,
        thread_id=thread_id,
        authorized_by="system",
    )
    parsed = dispatch_result if isinstance(dispatch_result, dict) else {}
    delegated = parsed.get("delegatedSubtasks")
    delegated_ok = isinstance(delegated, list) and any(isinstance(d, dict) and d.get("ok") for d in delegated)
    if not parsed.get("success") and not delegated_ok:
        err = str(parsed.get("error") or parsed.get("message") or "dispatch_failed")
        logger.warning(
            "unattended_pipeline: dispatch failed task_id=%s err=%s raw=%s",
            task_id,
            err,
            json.dumps(parsed, ensure_ascii=False)[:500],
        )

        def _fail(t: dict[str, Any]) -> dict[str, Any]:
            attempts = int(t.get("unattended_dispatch_attempts") or 0) + 1
            t["unattended_dispatch_attempts"] = attempts
            t["error"] = err[:2000]
            if attempts >= _DISPATCH_RETRY_MAX:
                t["status"] = "failed"
                t["unattended_stage"] = "failed"
            else:
                t["status"] = "planned"
                t["unattended_stage"] = "dispatch_retry"
                t["execution_authorized"] = False
                t["authorized_at"] = None
                t["authorized_by"] = None
            return t

        _patch_task(task_id, _fail)
        return {"task_id": task_id, "ok": False, "error": err, "dispatch": parsed}

    try:
        advance_collab_phase_to_executing_for_task(get_paths(), task_id, runtime_thread_id=thread_id)
    except Exception:
        logger.debug("unattended_pipeline: executing phase advance skipped task_id=%s", task_id, exc_info=True)

    def _running(t: dict[str, Any]) -> dict[str, Any]:
        t["status"] = "executing"
        t["unattended_stage"] = "executing"
        t["started_at"] = t.get("started_at") or utc_now_iso_z()
        t["unattended_enqueued_at"] = t.get("unattended_enqueued_at") or utc_now_iso_z()
        return t

    _patch_task(task_id, _running)
    return {"task_id": task_id, "ok": True, "action": "dispatched", "dispatch": parsed}


async def advance_unattended_task(task_id: str) -> dict[str, Any]:
    """Advance one unattended task (serialized per task_id)."""
    lock = await _advance_lock_for(task_id)
    async with lock:
        return await _advance_unattended_task_impl(task_id)


def list_unattended_candidates() -> list[dict[str, Any]]:
    """Pending/failed tasks eligible for new unattended queue pickup."""
    storage = get_project_storage()
    out: list[dict[str, Any]] = []
    for summary in storage.list_projects():
        project = storage.load_project(summary["id"])
        if not project:
            continue
        for task in project.get("tasks") or []:
            if not isinstance(task, dict) or not is_unattended_task(task):
                continue
            status = str(task.get("status") or "").strip().lower()
            if status == "paused":
                continue
            if status == "pending":
                out.append(task)
            elif status == "failed" and _retry_due(task):
                attempts = int(task.get("unattended_attempts") or 0)
                if attempts < task_queue_max_retries():
                    out.append(task)
            elif (
                status == "executing"
                and not (task.get("subtasks") or [])
                and not task.get("execution_authorized")
            ):
                out.append(task)
    out.sort(key=lambda t: str(t.get("unattended_enqueued_at") or t.get("created_at") or ""))
    return out


def list_unattended_in_progress() -> list[dict[str, Any]]:
    """In-flight unattended tasks that still need queue ticks (plan → authorize → dispatch)."""
    storage = get_project_storage()
    out: list[dict[str, Any]] = []
    for summary in storage.list_projects():
        project = storage.load_project(summary["id"])
        if not project:
            continue
        for task in project.get("tasks") or []:
            if not isinstance(task, dict) or not is_unattended_task(task):
                continue
            status = str(task.get("status") or "").strip().lower()
            if status == "paused":
                continue
            has_plan = task_has_bound_plan(task)
            has_subs = bool(task.get("subtasks") or [])
            if status == "planning":
                out.append(task)
            elif status in {"planned", "awaiting_exec", "waiting_dispatch"} and has_plan and not _has_in_flight_subtasks(task):
                out.append(task)
            elif status == "executing" and has_subs and not _has_in_flight_subtasks(task) and not _all_subtasks_terminal(task):
                out.append(task)
    out.sort(key=lambda t: str(t.get("unattended_enqueued_at") or t.get("created_at") or ""))
    return out


def _planning_consumes_concurrency_slot(task: dict[str, Any]) -> bool:
    """Only in-flight plan workers (or brief startup race) should occupy queue slots."""
    status = str(task.get("status") or "").strip().lower()
    if status != "planning":
        return False
    thread_id = str(task.get("thread_id") or task.get("current_execution_thread_id") or "").strip()
    if thread_id:
        try:
            from app.gateway.streaming.background_worker import StreamBackgroundWorker

            if StreamBackgroundWorker.is_worker_running(thread_id):
                return True
        except Exception:
            logger.debug("unattended_pipeline: plan worker probe failed thread=%s", thread_id, exc_info=True)
    triggered_at = str(task.get("unattended_plan_triggered_at") or "").strip()
    if triggered_at and not _plan_trigger_stale(task):
        return True
    return False


def count_active_unattended_tasks() -> int:
    """Tasks consuming unattended queue concurrency slots (in-flight execution + active planning).

    ``planned`` rows waiting for dispatch must NOT count — otherwise stuck planned tasks
    exhaust ``max_concurrent`` and block the entire queue (observed: active_unattended=20, slots=0).

    Stale ``planning`` rows (dead plan worker, triggered_at > 20min) must NOT count either.
    """
    storage = get_project_storage()
    n = 0
    for summary in storage.list_projects():
        project = storage.load_project(summary["id"])
        if not project:
            continue
        for task in project.get("tasks") or []:
            if not isinstance(task, dict) or not is_unattended_task(task):
                continue
            status = str(task.get("status") or "").strip().lower()
            if status == "paused":
                continue
            if status == "planning":
                if _planning_consumes_concurrency_slot(task):
                    n += 1
            elif status == "executing":
                if _has_in_flight_subtasks(task):
                    n += 1
                elif (task.get("subtasks") or []) and not _all_subtasks_terminal(task):
                    n += 1
            elif status in {"planned", "awaiting_exec", "waiting_dispatch"} and _has_in_flight_subtasks(task):
                n += 1
    return n
