"""Background queue dispatcher for unattended task-center jobs."""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Any

from app.gateway.unattended_task_pipeline import (
    advance_unattended_task,
    count_active_unattended_tasks,
    list_unattended_candidates,
    list_unattended_in_progress,
)

logger = logging.getLogger(__name__)

DEFAULT_TICK_SECONDS = 60
_scheduler_loop_running = False
_last_tick_info: dict[str, Any] = {}


def task_queue_enabled() -> bool:
    v = (os.getenv("EVOFLOW_TASK_QUEUE_ENABLED") or "1").strip().lower()
    return v not in ("0", "false", "no", "off", "disabled")


def task_queue_max_concurrent() -> int:
    raw = (os.getenv("EVOFLOW_TASK_QUEUE_MAX_CONCURRENT") or "3").strip()
    try:
        return max(1, int(raw))
    except ValueError:
        return 3


def task_queue_tick_seconds() -> int:
    raw = (os.getenv("EVOFLOW_TASK_QUEUE_TICK_SECONDS") or str(DEFAULT_TICK_SECONDS)).strip()
    try:
        return max(5, int(raw))
    except ValueError:
        return DEFAULT_TICK_SECONDS


def get_task_queue_status() -> dict[str, Any]:
    return {
        "backend_env_enabled": task_queue_enabled(),
        "backend_loop_running": _scheduler_loop_running,
        "max_concurrent": task_queue_max_concurrent(),
        "tick_seconds": task_queue_tick_seconds(),
        "active_unattended": count_active_unattended_tasks(),
        "queued_candidates": len(list_unattended_candidates()),
        "in_progress": len(list_unattended_in_progress()),
        "last_tick": dict(_last_tick_info),
        "hint": "Unattended tasks (run_mode=unattended) auto plan/authorize/dispatch. Disable with EVOFLOW_TASK_QUEUE_ENABLED=0.",
    }


def _task_queue_tick_snapshot(max_concurrent: int) -> dict[str, Any]:
    active = count_active_unattended_tasks()
    slots = max(0, max_concurrent - active)
    return {
        "in_progress": list_unattended_in_progress(),
        "active": active,
        "slots": slots,
        "candidates": list_unattended_candidates()[:slots],
    }


async def task_queue_tick() -> dict[str, Any]:
    """One scheduler tick: start up to N pending unattended tasks."""
    from evoflow.observability.poll_loop_log import log_poll_tick

    log_poll_tick("task_queue_scheduler", key="global", interval_s=60.0)
    if not task_queue_enabled():
        return {"skipped": True, "reason": "disabled"}

    max_concurrent = task_queue_max_concurrent()
    results: list[dict[str, Any]] = []

    snapshot = await asyncio.to_thread(_task_queue_tick_snapshot, max_concurrent)
    in_progress = snapshot["in_progress"]

    for task in in_progress:
        task_id = str(task.get("id") or "").strip()
        if not task_id:
            continue
        if await asyncio.to_thread(count_active_unattended_tasks) >= max_concurrent:
            logger.info("task_queue_tick: concurrency cap reached, defer in_progress task_id=%s", task_id)
            break
        try:
            result = await advance_unattended_task(task_id)
            results.append(result)
            logger.info(
                "task_queue_tick: continued task_id=%s result=%s",
                task_id,
                result.get("action") or result.get("error"),
            )
        except Exception:
            logger.exception("task_queue_tick: continue failed task_id=%s", task_id)
            results.append({"task_id": task_id, "ok": False, "error": "exception"})

    snapshot = await asyncio.to_thread(_task_queue_tick_snapshot, max_concurrent)
    active = snapshot["active"]
    slots = snapshot["slots"]
    candidates = snapshot["candidates"]
    for task in candidates:
        if await asyncio.to_thread(count_active_unattended_tasks) >= max_concurrent:
            break
        task_id = str(task.get("id") or "").strip()
        if not task_id:
            continue
        try:
            result = await advance_unattended_task(task_id)
            results.append(result)
            logger.info("task_queue_tick: advanced task_id=%s result=%s", task_id, result.get("action") or result.get("error"))
        except Exception:
            logger.exception("task_queue_tick: advance failed task_id=%s", task_id)
            results.append({"task_id": task_id, "ok": False, "error": "exception"})

    info = {
        "active": active,
        "slots": slots,
        "picked": len(candidates),
        "results": results,
    }
    global _last_tick_info
    _last_tick_info = info
    return info


async def run_task_queue_scheduler(stop: asyncio.Event) -> None:
    global _scheduler_loop_running
    interval = task_queue_tick_seconds()
    _scheduler_loop_running = True
    logger.info(
        "task_queue_runner: loop started tick_interval_s=%s max_concurrent=%s diagnostics=GET /api/tasks/queue/status",
        interval,
        task_queue_max_concurrent(),
    )
    try:
        while not stop.is_set():
            from evoflow.observability.poll_loop_log import log_poll_tick

            log_poll_tick("task_queue_scheduler_loop", key="global", interval_s=60.0)
            try:
                await task_queue_tick()
            except Exception:
                logger.exception("task_queue_runner: tick failed")
            try:
                await asyncio.wait_for(stop.wait(), timeout=interval)
            except TimeoutError:
                pass
    finally:
        _scheduler_loop_running = False
        logger.info("task_queue_runner: loop stopped")
