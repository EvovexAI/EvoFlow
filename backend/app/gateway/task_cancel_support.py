"""Shared task/run cancellation support (Task Center + App runs).

Previously the deep cancel path (stream worker + LangGraph runs + supervisor
monitor + cooperative flags + cancel events) lived only in the Task Center
router, while App-run ``cancel_run`` flipped status fields without
interrupting executors — in-flight workers could then overwrite the cancelled
state (workflow-audit-roadmap P1-2 / E-2). This module is the single home for
those helpers; both routers call into it.
"""

from __future__ import annotations

import logging
import os
from datetime import UTC, datetime
from typing import Any

from app.gateway.cancellation import mark_task_cancelled
from app.gateway.events import event_queue
from app.gateway.events.task_events import TaskCancelEvent

logger = logging.getLogger(__name__)


def _publish_task_cancel_event(
    task_id: str,
    project_id: str,
    subtask_ids: list[str],
    reason: str,
    cancelled_by: str = "user",
) -> None:
    """Publish cooperative-cancellation event for running subtasks."""
    if not subtask_ids:
        return
    event = TaskCancelEvent(
        task_id=task_id,
        project_id=project_id,
        subtask_ids=subtask_ids,
        cancelled_by=cancelled_by,
        reason=reason,
        timestamp=datetime.now(UTC),
    )
    event_queue.publish("task_cancelled", event)


def _collect_running_subtask_ids(task: dict[str, Any]) -> list[str]:
    running_subtask_ids: list[str] = []
    for subtask in task.get("subtasks") or []:
        sid = str(subtask.get("id") or "").strip()
        sst = str(subtask.get("status") or "").strip().lower()
        if sid and sst in ("executing", "planning", "pending", "running", "in_progress", "active"):
            running_subtask_ids.append(sid)
    return running_subtask_ids


async def _cancel_plan_worker(thread_id: str | None) -> None:
    """Cancel background stream worker AND LangGraph server-side runs for a thread.

    Previously this only cancelled the local asyncio stream reader, leaving the
    LangGraph server-side run alive. The Lead Agent continued executing and could
    overwrite task status, causing the "cancel doesn't work" bug.
    """
    tid = str(thread_id or "").strip()
    if not tid:
        return
    # 1. Cancel local StreamBackgroundWorker (stops reading the stream).
    try:
        from app.gateway.streaming.background_worker import StreamBackgroundWorker

        worker = StreamBackgroundWorker._workers.get(tid)
        if worker and worker.is_running():
            await worker.cancel()
    except Exception as e:
        logger.warning("Failed to cancel background worker for thread %s: %s", tid, e)
    # 2. Cancel LangGraph server-side runs (stop the actual Lead Agent execution).
    try:
        from langgraph_sdk import get_client

        langgraph_url = os.getenv("EVOFLOW_LANGGRAPH_URL", "http://127.0.0.1:8070/api/langgraph").strip()
        client = get_client(url=langgraph_url)
        runs = await client.runs.list(thread_id=tid, limit=20)
        for run in runs:
            run_id = str(run.get("run_id") or run.get("id") or "").strip()
            status = str(run.get("status") or "").strip().lower()
            if run_id and status in ("pending", "running"):
                try:
                    await client.runs.cancel(thread_id=tid, run_id=run_id)
                    logger.info("Cancelled LangGraph run %s on thread %s", run_id, tid)
                except Exception as e:
                    logger.debug("Failed to cancel run %s on thread %s: %s", tid, run_id, e)
    except Exception as e:
        logger.warning("Failed to cancel LangGraph runs for thread %s: %s", tid, e)


async def _cancel_supervisor_monitor(task_id: str) -> None:
    """Cancel the supervisor background monitor asyncio task for a task.

    The background monitor (_ensure_background_task_monitor) runs a 3-second poll
    loop that triggers _trigger_lead_follow_run -> new LangGraph runs. If not
    cancelled here, the monitor keeps spawning Lead Agent runs even after the user
    cancelled the task, causing the "supervisor keeps calling monitor" death loop.
    """
    tid = str(task_id or "").strip()
    if not tid:
        return
    try:
        from evoflow.tools.builtins.supervisor.monitor import (
            _bg_task_monitors,
            _cleanup_monitor_state_for_task,
        )

        monitor_task = _bg_task_monitors.pop(tid, None)
        if monitor_task and not monitor_task.done():
            monitor_task.cancel()
            try:
                await monitor_task
            except BaseException:
                pass
            logger.info("Cancelled supervisor background monitor for task %s", tid)
        _cleanup_monitor_state_for_task(tid)
    except Exception as e:
        logger.debug("Failed to cancel supervisor monitor for task %s: %s", tid, e)


async def cancel_app_run_deep(run_id: str, reason: str = "User cancelled") -> bool:
    """Deep cancel for App runs — same depth as Task Center cancel (E-2).

    Layers, in order:
    1. status flip (harness ``cancel_run``: main task + open subtasks + run row)
    2. revoke execution authorization (no re-dispatch after cancel)
    3. cooperative cancel flags (main + running subtasks)
    4. executor interrupts (stream worker, LangGraph runs, supervisor monitor)
    5. cooperative cancel event for running subtask workers
    """
    from evoflow.collab.app_runner import cancel_run as _cancel_run_status
    from evoflow.persistence import app_repositories

    run = app_repositories.load_run(run_id)
    if run is None:
        return False
    task_id = str(run.get("task_id") or "").strip()

    ok = _cancel_run_status(run_id, reason)

    _app_name = ""
    if task_id:
        thread_id: str | None = None
        running_ids: list[str] = []
        project_id = ""
        try:
            from evoflow.persistence.task_repositories import load_task_bundle

            bundle = load_task_bundle(task_id)
            if bundle and bundle.get("tasks"):
                main_task = bundle["tasks"][0]
                thread_id = main_task.get("thread_id") or run.get("thread_id")
                running_ids = _collect_running_subtask_ids(main_task)
                project_id = str(bundle.get("id") or "")
                _app_name = str(main_task.get("source_app_name") or "").strip()
        except Exception:
            logger.warning("cancel_app_run_deep: bundle read failed run_id=%s", run_id, exc_info=True)

        try:
            from evoflow.collab.authorize_execution import revoke_main_task_execution_authorization
            from evoflow.collab.storage import get_project_storage

            revoke_main_task_execution_authorization(get_project_storage(), task_id)
        except Exception:
            logger.debug("cancel_app_run_deep: revoke authorization skipped task_id=%s", task_id, exc_info=True)

        try:
            mark_task_cancelled(task_id, "user", str(reason or "run_cancelled"))
            for sid in running_ids:
                mark_task_cancelled(sid, "user", "parent_run_cancelled")
        except Exception:
            logger.warning("cancel_app_run_deep: flag propagation failed task_id=%s", task_id, exc_info=True)

        await _cancel_plan_worker(thread_id)
        await _cancel_supervisor_monitor(task_id)
        try:
            _publish_task_cancel_event(
                task_id=task_id,
                project_id=project_id,
                subtask_ids=running_ids,
                reason=f"App run cancelled: {reason}",
                cancelled_by="user",
            )
        except Exception:
            logger.warning("cancel_app_run_deep: cancel event publish failed task_id=%s", task_id, exc_info=True)

    if ok:
        # Cancel may not flow through a rollup emit — push the terminal
        # notification directly so the result lands in the notification center.
        try:
            from evoflow.collab.app_run_events import notify_workflow_terminal

            notify_workflow_terminal(
                app_id=str(run.get("app_id") or "").strip(),
                run_id=run_id,
                app_name=_app_name,
                status="cancelled",
                summary=str(reason or "User cancelled")[:200],
            )
        except Exception:
            logger.debug("cancel_app_run_deep: terminal notify skipped run_id=%s", run_id, exc_info=True)
    return ok
