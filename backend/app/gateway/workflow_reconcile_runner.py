"""Background workflow reconciler — boot + interval crash/node recover."""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Any

logger = logging.getLogger(__name__)

_DEFAULT_INTERVAL_S = 45
_loop_running = False
_last_tick: dict[str, Any] = {}


def workflow_reconcile_enabled() -> bool:
    raw = (os.getenv("EVOFLOW_WORKFLOW_RECONCILE") or "1").strip().lower()
    return raw not in ("0", "false", "no", "off", "disabled")


def workflow_reconcile_tick_seconds() -> int:
    raw = (os.getenv("EVOFLOW_WORKFLOW_RECONCILE_TICK_S") or str(_DEFAULT_INTERVAL_S)).strip()
    try:
        return max(15, int(raw))
    except ValueError:
        return _DEFAULT_INTERVAL_S


def get_workflow_reconcile_status() -> dict[str, Any]:
    return {
        "enabled": workflow_reconcile_enabled(),
        "loop_running": _loop_running,
        "tick_seconds": workflow_reconcile_tick_seconds(),
        "last_tick": dict(_last_tick),
    }


async def workflow_reconcile_tick(*, reason: str = "tick", limit: int = 50) -> dict[str, Any]:
    from evoflow.collab.workflow_reconciler import reconcile_open_workflows

    global _last_tick
    result = await reconcile_open_workflows(limit=limit, reason=reason)
    _last_tick = {
        "reason": reason,
        "scanned": result.get("scanned"),
        "healedCount": result.get("healedCount"),
        "runnerEpoch": result.get("runnerEpoch"),
    }
    return result


async def run_workflow_reconcile_scheduler(stop: asyncio.Event) -> None:
    """Boot pass then periodic reconcile for open App workflow runs."""
    global _loop_running
    interval = workflow_reconcile_tick_seconds()
    _loop_running = True
    logger.info(
        "Workflow reconciler started (interval=%ss; disable EVOFLOW_WORKFLOW_RECONCILE=0)",
        interval,
    )
    try:
        try:
            boot = await workflow_reconcile_tick(reason="boot", limit=100)
            if int(boot.get("healedCount") or 0) > 0:
                logger.info(
                    "workflow reconcile boot: scanned=%s healed=%s",
                    boot.get("scanned"),
                    boot.get("healedCount"),
                )
        except Exception:
            logger.exception("workflow reconcile boot failed")

        while not stop.is_set():
            try:
                await asyncio.wait_for(stop.wait(), timeout=interval)
                break
            except TimeoutError:
                pass
            if stop.is_set():
                break
            try:
                tick = await workflow_reconcile_tick(reason="tick", limit=50)
                if int(tick.get("healedCount") or 0) > 0:
                    logger.info(
                        "workflow reconcile tick: scanned=%s healed=%s",
                        tick.get("scanned"),
                        tick.get("healedCount"),
                    )
            except Exception:
                logger.debug("workflow reconcile tick failed", exc_info=True)
    finally:
        _loop_running = False
        logger.info("Workflow reconciler stopped")
