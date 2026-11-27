"""Background data retention for Gateway (logs, SQLite, orphan checkpoints)."""

from __future__ import annotations

import asyncio
import logging
import os
import time
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

DEFAULT_INTERVAL_SECONDS = 24 * 3600
# WAL checkpoint cadence: run more frequently than full retention (hourly)
# to prevent WAL files from growing unbounded between retention passes.
_WAL_CHECKPOINT_INTERVAL_SECONDS = int(os.getenv("EVOFLOW_WAL_CHECKPOINT_INTERVAL_S", str(3600)) or "3600")
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


def _obs_size_cap_retry_seconds() -> int:
    """When still over the obs size cap, retry retention sooner than the daily interval.

    VACUUM INTO may be skipped by the busy guard; without a short retry the file
    stays multi-GB until the next day (2026-11-23 non-dev: 2.5GB with ~1GB freelist).
    """
    raw = (os.getenv("EVOFLOW_OBS_SIZE_CAP_RETRY_S") or "3600").strip()
    try:
        return max(300, int(raw))
    except ValueError:
        return 3600


def _vacuum_busy_guard() -> bool:
    """True = 允许本轮 VACUUM。聊天 REST / 流式 / 事件循环过载时让路。

    VACUUM 独占 SQLite 锁：大库上可达数十秒～数分钟。进程内 ``_lock`` 会在
    writer 等待 SQLite 时一直持有；若此时事件循环线程再同步 ``get_db()``
    （例如旧版 ``execution/state``），整条 Gateway 卡死，表现为
    ``[LG-ROUTE] 等待 LangGraph 接受`` + 新对话 ``first_token_dead``
    （2026-11-15 hang：execution/state / messages / context 等 298s）。

    探测纯内存（流注册表 + hang lag / inflight），不触库；
    ``EVOFLOW_VACUUM_BUSY_GUARD=0`` 关闭回退旧行为；探测异常 fail-open。
    """
    raw = (os.getenv("EVOFLOW_VACUUM_BUSY_GUARD") or "").strip().lower()
    if raw in ("0", "false", "no", "off"):
        return True
    try:
        from app.gateway.routers.langgraph_proxy import list_active_stream_proxies

        active = len(list_active_stream_proxies())
    except Exception:
        active = 0
    if active > 0:
        logger.info("vacuum guard: %d active stream proxy(ies) — skipping VACUUM this pass", active)
        return False
    try:
        from app.gateway.hang_diagnostics import (
            get_event_loop_lag_seconds,
            snapshot_inflight_requests,
        )

        lag = float(get_event_loop_lag_seconds() or 0.0)
        if lag >= 2.0:
            logger.info("vacuum guard: event-loop lag=%.1fs — skipping VACUUM this pass", lag)
            return False
        snap = snapshot_inflight_requests() or {}
        inflight = list(snap.get("all") or snap.get("long_waiting") or [])
        # Any REST in flight (proactive/approvals, mcp/config, …) — not only chat.
        # 2026-11-19 14:59 hang: VACUUM began while /api/proactive/approvals was
        # already waiting; exclusive lock then froze the whole desktop ~86s.
        if inflight:
            logger.info(
                "vacuum guard: %d inflight request(s) — skipping VACUUM this pass",
                len(inflight),
            )
            return False
    except Exception:
        pass
    return True


def run_retention_once() -> dict[str, Any]:
    from evoflow.config.app_config import get_app_config
    from evoflow.config.data_paths import logs_dir, resolve_data_base_dir
    from evoflow.config.paths import get_paths
    from evoflow.persistence.data_layout import ensure_data_layout
    from evoflow.persistence.data_retention import run_data_retention

    base = get_paths().base_dir
    ensure_data_layout(base)
    try:
        from evoflow.config.data_paths import app_db_path, checkpoints_db_path, observability_db_path
        from evoflow.persistence.data_retention import apply_pending_sqlite_rebuild

        for pending in (app_db_path(base), observability_db_path(base), checkpoints_db_path(base)):
            apply_pending_sqlite_rebuild(pending)
    except Exception:
        logger.debug("pending sqlite rebuild before retention skipped", exc_info=True)
    cfg = get_app_config().data_retention
    result = run_data_retention(
        cfg,
        base_dir=base,
        logs_dir=logs_dir(resolve_data_base_dir()),
        vacuum_path_guard=_vacuum_busy_guard,
    )
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


def _run_wal_checkpoint_all(*, truncate: bool = False) -> dict[str, Any]:
    """Run ``PRAGMA wal_checkpoint`` on all EvoFlow SQLite databases.

    常规整点用 PASSIVE（不阻塞写入方；LG 每 superstep put / telemetry 持续写时
    TRUNCATE 要么让写排队、要么自己失败形成「膨胀→TRUNCATE→挤压写」循环）。
    仅 WAL 尺寸保险触发（超过上限、必须回收磁盘）时才用 TRUNCATE。
    """
    try:
        from evoflow.persistence.db import checkpoint_all_databases

        return checkpoint_all_databases(mode="passive" if not truncate else "truncate")
    except Exception:
        logger.warning("checkpoint_all_databases failed", exc_info=True)
        return {}


_WAL_SIZE_ALERT_MB = max(
    32, int(os.getenv("EVOFLOW_WAL_SIZE_ALERT_MB", "256") or "256")
)
"""WAL 大于该值（MB）时提前触发 checkpoint，不等整点（实测 WAL 可在两次整点间长到 780MB）。"""

_WAL_SIZE_GUARD_MIN_GAP_S = max(60, int(os.getenv("EVOFLOW_WAL_SIZE_GUARD_MIN_GAP_S", "300") or "300"))
"""尺寸保险两次触发的最小间隔，避免 busy 反复空转。"""


def _any_wal_oversized() -> bool:
    """Cheap stat-only check: any known SQLite WAL beyond the alert size?"""
    from evoflow.config.data_paths import (
        checkpoints_db_path,
        observability_db_path,
        resolve_data_base_dir,
    )
    from evoflow.persistence.db import resolve_evolflow_db_path

    limit = _WAL_SIZE_ALERT_MB * 1024 * 1024
    paths: list[Path] = []
    try:
        paths.append(resolve_evolflow_db_path())
    except Exception:
        pass
    try:
        base = resolve_data_base_dir()
        paths.append(observability_db_path(base))
        paths.append(checkpoints_db_path(base))
    except Exception:
        pass
    for path in paths:
        try:
            if path.suffix == ".db" or path.name.endswith(".db"):
                wal = path.with_name(path.name + "-wal")
            else:
                wal = Path(str(path) + "-wal")
            if wal.is_file() and wal.stat().st_size >= limit:
                logger.warning(
                    "WAL oversized: %s is %.0f MB (limit %d MB)",
                    wal, wal.stat().st_size / (1024 * 1024), _WAL_SIZE_ALERT_MB,
                )
                return True
        except OSError:
            continue
    return False


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
        "Data retention scheduler started (startup_delay=%ss, retention_interval=%sh, wal_checkpoint_interval=%ss; disable with EVOFLOW_DATA_RETENTION=0)",
        startup_delay,
        interval // 3600,
        wal_interval,
    )
    last_wal_checkpoint = 0.0  # monotonic seconds of last WAL checkpoint
    last_wal_size_check = 0.0  # monotonic seconds of last WAL size stat
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
        elif now - last_wal_size_check >= 60:
            # 尺寸保险：两次整点之间 WAL 仍可能因高写入膨胀（实测出现过 780MB）。
            # 每分钟 stat 一次（廉价），超过阈值立即提前回收，不等下一个整点。
            last_wal_size_check = now
            try:
                oversized = await asyncio.to_thread(_any_wal_oversized)
            except Exception:
                oversized = False
            if oversized and now - last_wal_checkpoint >= _WAL_SIZE_GUARD_MIN_GAP_S:
                try:
                    wal_summary = await asyncio.to_thread(_run_wal_checkpoint_all, truncate=True)
                    logger.warning("WAL size guard triggered early checkpoint: %s", wal_summary)
                except Exception:
                    logger.warning("WAL size-guard checkpoint failed", exc_info=True)
                last_wal_checkpoint = time.monotonic()

        # --- Full data retention pass (infrequent; delayed after startup) ---
        # Due time is already encoded in retention_due_at (daily interval OR
        # hourly size-cap retry). Do NOT also require (now - last_retention) >=
        # interval — that made EVOFLOW_OBS_SIZE_CAP_RETRY_S a no-op and left
        # multi-GB freelist unreclaimed for a full day (2026-11-24→25).
        retention_due = now >= retention_due_at
        if retention_due:
            try:
                summary = await asyncio.to_thread(run_retention_once)
                logger.info("Data retention pass: %s", summary)
            except Exception:
                logger.exception("Data retention pass failed")
            last_retention = time.monotonic()
            # Over size cap → retry hourly (busy-guard may have skipped VACUUM INTO).
            if _observability_db_over_size_cap():
                retry_s = _obs_size_cap_retry_seconds()
                retention_due_at = last_retention + retry_s
                logger.warning(
                    "observability.db still over size cap; next retention in %ss (not full interval)",
                    retry_s,
                )
            else:
                retention_due_at = last_retention + interval

        # Wake often enough for WAL + startup delay without busy-looping.
        if last_retention <= 0.0:
            wait_for = max(5.0, min(300.0, retention_due_at - time.monotonic()))
        else:
            wait_for = float(min(interval, wal_interval, 300, max(5.0, retention_due_at - time.monotonic())))
        try:
            await asyncio.wait_for(stop.wait(), timeout=wait_for)
        except TimeoutError:
            continue
    logger.info("Data retention scheduler stopped")
