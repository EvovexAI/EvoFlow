"""Background data retention for Gateway (logs, SQLite, orphan checkpoints)."""

from __future__ import annotations

import asyncio
import logging
import os
import time
from typing import Any

logger = logging.getLogger(__name__)

DEFAULT_INTERVAL_SECONDS = 24 * 3600
# WAL checkpoint cadence: run more frequently than full retention (hourly)
# to prevent WAL files from growing unbounded between retention passes.
_WAL_CHECKPOINT_INTERVAL_SECONDS = int(
    os.getenv("EVOFLOW_WAL_CHECKPOINT_INTERVAL_S", str(3600)) or "3600"
)
# Default: wait 15m after startup before the first full retention+VACUUM so the
# first chat is not blocked by exclusive locks on large SQLite files.
_DEFAULT_STARTUP_DELAY_SECONDS = 900


def data_retention_enabled() -> bool:
    raw = (os.getenv("EVOFLOW_DATA_RETENTION") or "").strip().lower()
    if raw in ("0", "false", "no", "off", "disabled"):
        return False
    try:
        from evoflow.config.app_config import get_app_config

        return bool(get_app_config().data_retention.enabled)
    except Exception:
        return True


def _interval_seconds() -> int:
    try:
        from evoflow.config.app_config import get_app_config

        hours = int(get_app_config().data_retention.interval_hours)
        return max(3600, hours * 3600)
    except Exception:
        return DEFAULT_INTERVAL_SECONDS


def _observability_db_over_size_cap() -> bool:
    try:
        from evoflow.config.app_config import get_app_config
        from evoflow.config.data_paths import observability_db_path, resolve_data_base_dir
        from evoflow.persistence.data_retention import _observability_db_bytes

        cfg = get_app_config().data_retention
        cap_gb = float(cfg.observability_max_size_gb)
        if cap_gb <= 0:
            return False
        obs_path = observability_db_path(resolve_data_base_dir())
        return _observability_db_bytes(obs_path) > int(cap_gb * (1024**3))
    except Exception:
        return False


def _startup_delay_seconds() -> int:
    raw = (os.getenv("EVOFLOW_DATA_RETENTION_STARTUP_DELAY_S") or "").strip()
    if raw:
        try:
            return max(0, int(raw))
        except ValueError:
            pass
    try:
        from evoflow.config.app_config import get_app_config

        return max(0, int(get_app_config().data_retention.startup_delay_seconds))
    except Exception:
        return _DEFAULT_STARTUP_DELAY_SECONDS


def _effective_startup_delay_seconds() -> int:
    """Use a short delay when observability.db already exceeds the size cap."""
    if _observability_db_over_size_cap():
        raw = (os.getenv("EVOFLOW_OBS_SIZE_CAP_STARTUP_DELAY_S") or "60").strip()
        try:
            return max(0, int(raw))
        except ValueError:
            return 60
    return _startup_delay_seconds()


def run_retention_once() -> dict[str, Any]:
    from evoflow.config.app_config import get_app_config
    from evoflow.config.data_paths import logs_dir, resolve_data_base_dir
    from evoflow.config.paths import get_paths
    from evoflow.persistence.data_layout import ensure_data_layout
    from evoflow.persistence.data_retention import run_data_retention

    base = get_paths().base_dir
    ensure_data_layout(base)
    cfg = get_app_config().data_retention
    result = run_data_retention(cfg, base_dir=base, logs_dir=logs_dir(resolve_data_base_dir()))
    return {
        "logs_removed": result.logs_removed,
        "obs_rows_deleted": result.obs_rows_deleted,
        "obs_gateway_stripped": result.obs_gateway_stripped,
        "obs_size_cap_deleted": result.obs_size_cap_deleted,
        "task_stream_deleted": result.task_stream_deleted,
        "task_status_deleted": result.task_status_deleted,
        "automation_runs_deleted": result.automation_runs_deleted,
        "soft_deleted_messages": result.soft_deleted_messages,
        "checkpoint_threads_purged": result.checkpoint_threads_purged,
        "checkpoint_rows_deleted": result.checkpoint_rows_deleted,
        "checkpoint_history_rows_deleted": result.checkpoint_history_rows_deleted,
        "writes_rows_deleted": result.writes_rows_deleted,
        "vacuumed": result.vacuumed,
        "errors": result.errors,
    }


def _run_wal_checkpoint_all() -> dict[str, Any]:
    """Run ``PRAGMA wal_checkpoint(TRUNCATE)`` on all EvoFlow SQLite databases.

    Called periodically (default ~hourly) by the data retention scheduler to
    prevent WAL files from growing unbounded between full retention passes.
    """
    try:
        from evoflow.persistence.db import checkpoint_all_databases

        return checkpoint_all_databases()
    except Exception:
        logger.warning("checkpoint_all_databases failed", exc_info=True)
        return {}


async def run_data_retention_scheduler(stop: asyncio.Event) -> None:
    """Run retention on an interval, with a startup delay; WAL checkpoint hourly.

    Full retention (including optional VACUUM) used to run immediately on every
    Gateway start. On machines with multi-GB observability / app DBs that
    exclusive-locked SQLite for 1–2+ minutes and made the first chat hang on
    ``SSE 已开启,等待第一个 token [准备中…]``.
    """
    interval = _interval_seconds()
    wal_interval = max(300, _WAL_CHECKPOINT_INTERVAL_SECONDS)
    startup_delay = _effective_startup_delay_seconds()
    logger.info(
        "Data retention scheduler started (startup_delay=%ss, retention_interval=%sh, "
        "wal_checkpoint_interval=%ss; disable with EVOFLOW_DATA_RETENTION=0)",
        startup_delay,
        interval // 3600,
        wal_interval,
    )
    last_wal_checkpoint = 0.0  # monotonic seconds of last WAL checkpoint
    last_retention = 0.0  # 0 => not yet run; set after first successful/attempted pass
    retention_due_at = time.monotonic() + startup_delay

    while not stop.is_set():
        from evoflow.observability.poll_loop_log import log_poll_tick

        log_poll_tick("data_retention_scheduler", key="global", interval_s=300.0)
        now = time.monotonic()

        # --- WAL checkpoint (frequent, ~hourly; safe for concurrent readers) ---
        if now - last_wal_checkpoint >= wal_interval:
            try:
                wal_summary = await asyncio.to_thread(_run_wal_checkpoint_all)
                if wal_summary:
                    logger.info("WAL checkpoint pass: %s", wal_summary)
            except Exception:
                logger.warning("WAL checkpoint pass failed", exc_info=True)
            last_wal_checkpoint = now

        # --- Full data retention pass (infrequent; delayed after startup) ---
        retention_due = now >= retention_due_at and (
            last_retention <= 0.0 or (now - last_retention) >= interval
        )
        if retention_due:
            try:
                summary = await asyncio.to_thread(run_retention_once)
                logger.info("Data retention pass: %s", summary)
            except Exception:
                logger.exception("Data retention pass failed")
            last_retention = time.monotonic()
            retention_due_at = last_retention + interval

        # Wake often enough for WAL + startup delay without busy-looping.
        if last_retention <= 0.0:
            wait_for = max(5.0, min(300.0, retention_due_at - time.monotonic()))
        else:
            wait_for = float(min(interval, wal_interval, 300))
        try:
            await asyncio.wait_for(stop.wait(), timeout=wait_for)
        except TimeoutError:
            continue
    logger.info("Data retention scheduler stopped")
