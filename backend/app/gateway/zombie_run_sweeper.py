"""Background zombie-run sweeper — periodically cancels stale active runs.

Similar to Apache Airflow's ``find_and_kill_zombies``: scans sessions marked
running/pending in SQLite, and if the run has been active longer than the
staleness threshold (``EVOFLOW_STARTUP_STALE_RUN_MAX_AGE_S``, default 180s),
cancels the underlying LangGraph run and marks the session idle.

Disable with ``EVOFLOW_ZOMBIE_SWEEPER=0``.
"""

from __future__ import annotations

import asyncio
import logging
import os

logger = logging.getLogger(__name__)

_DEFAULT_INTERVAL_S = int(os.getenv("EVOFLOW_ZOMBIE_SWEEP_INTERVAL_S", "120") or "120")
_ZOMBIE_SWEEP_BATCH_SIZE = int(os.getenv("EVOFLOW_ZOMBIE_SWEEP_BATCH", "100") or "100")


def zombie_sweeper_enabled() -> bool:
    """Return True unless explicitly disabled via env var."""
    raw = (os.getenv("EVOFLOW_ZOMBIE_SWEEPER") or "").strip().lower()
    if raw in ("0", "false", "no", "off", "disabled"):
        return False
    return True


async def run_zombie_sweeper_scheduler(stop: asyncio.Event) -> None:
    """Periodically scan for and cancel stale active runs.

    Runs every ``EVOFLOW_ZOMBIE_SWEEP_INTERVAL_S`` seconds (default 120).
    Reuses ``reconcile_stale_session_runs`` from run_status_reconcile so the
    sweep logic (stale detection, LangGraph cancel, DB idle mark) stays in
    one place.

    One pass per interval (up to ``EVOFLOW_ZOMBIE_SWEEP_BATCH`` sessions). A
    previous multi-batch loop re-queried the same top-N rows with no offset and
    could tight-loop every 0.5s when ≥ batch sticky running sessions existed.
    Remaining rows are picked up on the next interval.
    """
    interval = max(10, _DEFAULT_INTERVAL_S)
    batch_size = max(10, _ZOMBIE_SWEEP_BATCH_SIZE)
    logger.info(
        "Zombie run sweeper started (interval=%ss, batch=%d; disable with EVOFLOW_ZOMBIE_SWEEPER=0)",
        interval,
        batch_size,
    )
    while not stop.is_set():
        try:
            from app.gateway.run_status_reconcile import reconcile_stale_session_runs

            stats = await reconcile_stale_session_runs(
                wait_for_langgraph=False, max_sessions=batch_size
            )
            cancelled = stats.get("cancelled", 0)
            cleared = stats.get("cleared", 0)
            if cancelled or cleared:
                logger.info(
                    "zombie sweeper pass: cancelled=%d cleared=%d kept=%d healed=%d scanned=%d",
                    cancelled,
                    cleared,
                    stats.get("kept", 0),
                    stats.get("healed", 0),
                    stats.get("scanned", 0),
                )
        except Exception:
            logger.debug("zombie sweeper pass failed", exc_info=True)

        try:
            await asyncio.wait_for(stop.wait(), timeout=interval)
        except TimeoutError:
            continue
    logger.info("Zombie run sweeper stopped")
