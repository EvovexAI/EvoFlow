"""Retention helpers for EvoFlow SQLite databases and logs."""

from __future__ import annotations

import logging
import sqlite3
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path

from evoflow.config.data_paths import checkpoints_db_path, observability_db_path, resolve_checkpoints_config_path
from evoflow.config.data_retention_config import DataRetentionConfig
from evoflow.observability.tables import ObservabilityTable
from evoflow.persistence.db import get_db, resolve_evolflow_db_path, run_db_with_retry
from evoflow.persistence.timestamps import iso_z_to_ms

logger = logging.getLogger(__name__)

_TERMINAL_TASK_STATUSES = ("completed", "failed", "cancelled", "archived")


def _checkpoints_table_exists(conn: sqlite3.Connection) -> bool:
    """True when LangGraph's SqliteSaver schema is present (``setup()`` has run)."""
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='checkpoints' LIMIT 1"
    ).fetchone()
    return row is not None
_ACTIVE_SUBTASK_STATUSES = ("pending", "executing", "paused", "running", "in_progress")


@dataclass
class RetentionRunResult:
    logs_removed: int = 0
    obs_rows_deleted: int = 0
    obs_gateway_stripped: int = 0
    obs_size_cap_deleted: int = 0
    task_stream_deleted: int = 0
    task_status_deleted: int = 0
    automation_runs_deleted: int = 0
    soft_deleted_messages: int = 0
    checkpoint_threads_purged: int = 0
    checkpoint_rows_deleted: int = 0
    checkpoint_history_rows_deleted: int = 0
    writes_rows_deleted: int = 0
    vacuumed: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)


def _cutoff_iso(days: int) -> str:
    dt = datetime.now(UTC) - timedelta(days=max(1, int(days)))
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def _delete_older_than(conn: sqlite3.Connection, table: str, time_col: str, cutoff: str) -> int:
    cur = conn.execute(f"DELETE FROM {table} WHERE {time_col} < ?", (cutoff,))
    conn.commit()
    return int(cur.rowcount or 0)


def prune_gateway_logs(log_dir: Path, *, days: int) -> int:
    from app.gateway.logging_setup import prune_old_daily_logs

    return prune_old_daily_logs(log_dir, "gateway", days=days)


def _observability_db_bytes(obs_path: Path) -> int:
    if not obs_path.is_file():
        return 0
    total = obs_path.stat().st_size
    wal_path = Path(f"{obs_path}-wal")
    if wal_path.is_file():
        total += wal_path.stat().st_size
    return total


def strip_gateway_request_heavy_columns(conn: sqlite3.Connection, *, json_limit: int = 512) -> int:
    """Drop body samples and truncate large JSON blobs (in-place shrink)."""
    limit = max(128, int(json_limit))
    cur = conn.execute(
        f"""
        UPDATE {ObservabilityTable.GATEWAY_REQUESTS}
        SET request_body_sample = NULL,
            response_body_sample = NULL,
            request_headers_json = CASE
                WHEN request_headers_json IS NOT NULL AND length(request_headers_json) > ?
                THEN substr(request_headers_json, 1, ?)
                ELSE request_headers_json
            END,
            response_headers_json = CASE
                WHEN response_headers_json IS NOT NULL AND length(response_headers_json) > ?
                THEN substr(response_headers_json, 1, ?)
                ELSE response_headers_json
            END,
            metadata_json = CASE
                WHEN metadata_json IS NOT NULL AND length(metadata_json) > ?
                THEN substr(metadata_json, 1, ?)
                ELSE metadata_json
            END
        WHERE request_body_sample IS NOT NULL
           OR response_body_sample IS NOT NULL
           OR (request_headers_json IS NOT NULL AND length(request_headers_json) > ?)
           OR (response_headers_json IS NOT NULL AND length(response_headers_json) > ?)
           OR (metadata_json IS NOT NULL AND length(metadata_json) > ?)
        """,
        (limit, limit, limit, limit, limit, limit, limit, limit, limit),
    )
    conn.commit()
    return int(cur.rowcount or 0)


def _delete_oldest_rows(conn: sqlite3.Connection, table: str, *, batch: int, time_col: str = "occurred_at") -> int:
    cur = conn.execute(
        f"""
        DELETE FROM {table}
        WHERE rowid IN (
            SELECT rowid FROM {table}
            ORDER BY {time_col} ASC
            LIMIT ?
        )
        """,
        (max(1, int(batch)),),
    )
    conn.commit()
    return int(cur.rowcount or 0)


def strip_model_invocation_heavy_columns(conn: sqlite3.Connection, *, json_limit: int = 32 * 1024) -> int:
    """Truncate oversized model request/response JSON blobs (major size win)."""
    limit = max(1024, int(json_limit))
    cur = conn.execute(
        f"""
        UPDATE {ObservabilityTable.MODEL_INVOCATIONS}
        SET request_json = CASE
                WHEN request_json IS NOT NULL AND length(request_json) > ?
                THEN substr(request_json, 1, ?) || char(10) || '… [truncated]'
                ELSE request_json
            END,
            response_json = CASE
                WHEN response_json IS NOT NULL AND length(response_json) > ?
                THEN substr(response_json, 1, ?) || char(10) || '… [truncated]'
                ELSE response_json
            END
        WHERE (request_json IS NOT NULL AND length(request_json) > ?)
           OR (response_json IS NOT NULL AND length(response_json) > ?)
        """,
        (limit, limit, limit, limit, limit, limit),
    )
    conn.commit()
    return int(cur.rowcount or 0)


def _vacuum_observability_rebuild(obs_path: Path) -> bool:
    """Rebuild observability.db via ``VACUUM INTO`` (compact file, drop WAL).

    Requires no other connections holding the DB. Returns True when the rebuilt
    file replaced the original.
    """
    if not obs_path.is_file():
        return False
    rebuilt = obs_path.with_suffix(".db.rebuild")
    backup = obs_path.with_suffix(".db.bak")
    try:
        if rebuilt.exists():
            rebuilt.unlink()
        conn = sqlite3.connect(str(obs_path), timeout=300.0)
        conn.execute("PRAGMA busy_timeout=300000")
        # Forward slashes work on Windows for SQLite path args.
        conn.execute(f"VACUUM INTO '{rebuilt.as_posix()}'")
        conn.close()
        if not rebuilt.is_file() or rebuilt.stat().st_size <= 0:
            return False
        if backup.exists():
            backup.unlink()
        obs_path.rename(backup)
        rebuilt.rename(obs_path)
        for suffix in ("-wal", "-shm"):
            side = Path(f"{obs_path}{suffix}")
            if side.is_file():
                side.unlink()
        if backup.is_file():
            backup.unlink()
        return True
    except Exception as exc:
        logger.warning("observability VACUUM INTO rebuild failed: %s", exc)
        if rebuilt.is_file():
            try:
                rebuilt.unlink()
            except OSError:
                pass
        return False


def enforce_observability_db_size_cap(
    obs_path: Path,
    *,
    max_bytes: int,
    min_gateway_days: int = 3,
    model_json_limit: int = 32 * 1024,
) -> tuple[int, int, bool]:
    """Shrink observability.db when it exceeds *max_bytes*. Returns (stripped, deleted, vacuumed)."""
    _ = min_gateway_days  # reserved for future soft-retention tuning
    if not obs_path.is_file() or max_bytes <= 0:
        return (0, 0, False)
    before = _observability_db_bytes(obs_path)
    if before <= max_bytes:
        return (0, 0, False)

    stripped = 0
    deleted = 0
    vacuumed = False
    conn = sqlite3.connect(str(obs_path), timeout=120.0)
    try:
        logger.warning(
            "observability.db size %.2f GB exceeds cap %.2f GB; compacting",
            before / (1024**3),
            max_bytes / (1024**3),
        )
        stripped = strip_gateway_request_heavy_columns(conn)
        model_stripped = strip_model_invocation_heavy_columns(conn, json_limit=model_json_limit)
        stripped += model_stripped
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        conn.commit()

        gw_count_row = conn.execute(
            f"SELECT COUNT(*) FROM {ObservabilityTable.GATEWAY_REQUESTS}"
        ).fetchone()
        gw_count = int(gw_count_row[0] or 0) if gw_count_row else 0
        # SQLite file size barely drops until VACUUM — estimate rows to delete from ratio.
        target_ratio = max(0.05, min(1.0, max_bytes / before))
        keep_gateway = max(1, int(gw_count * target_ratio * 0.85))
        if gw_count > 10_000:
            keep_gateway = max(5_000, keep_gateway)
        keep_gateway = min(gw_count, keep_gateway)
        to_delete = max(0, gw_count - keep_gateway)
        batch = 50_000
        while to_delete > 0:
            n = _delete_oldest_rows(
                conn,
                ObservabilityTable.GATEWAY_REQUESTS,
                batch=min(batch, to_delete),
            )
            if n <= 0:
                break
            deleted += n
            to_delete -= n

        if before > max_bytes * 1.2:
            model_count_row = conn.execute(
                f"SELECT COUNT(*) FROM {ObservabilityTable.MODEL_INVOCATIONS}"
            ).fetchone()
            model_count = int(model_count_row[0] or 0) if model_count_row else 0
            keep_model = max(1_000, int(model_count * target_ratio * 0.85))
            if model_count > 5_000:
                keep_model = max(2_000, keep_model)
            keep_model = min(model_count, keep_model)
            model_to_delete = max(0, model_count - keep_model)
            while model_to_delete > 0:
                n = _delete_oldest_rows(
                    conn,
                    ObservabilityTable.MODEL_INVOCATIONS,
                    batch=min(batch, model_to_delete),
                    time_col="requested_at",
                )
                if n <= 0:
                    break
                deleted += n
                model_to_delete -= n

        if before > max_bytes * 1.5:
            trace_count_row = conn.execute(
                f"SELECT COUNT(*) FROM {ObservabilityTable.TRACE_EVENTS}"
            ).fetchone()
            trace_count = int(trace_count_row[0] or 0) if trace_count_row else 0
            keep_trace = max(10_000, int(trace_count * target_ratio * 0.85))
            trace_to_delete = max(0, trace_count - keep_trace)
            while trace_to_delete > 0:
                n = _delete_oldest_rows(
                    conn,
                    ObservabilityTable.TRACE_EVENTS,
                    batch=min(batch, trace_to_delete),
                )
                if n <= 0:
                    break
                deleted += n
                trace_to_delete -= n

        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        conn.commit()
    finally:
        conn.close()

    if stripped > 0 or deleted > 0:
        vacuumed = _vacuum_observability_rebuild(obs_path)
        if not vacuumed:
            try:
                conn = sqlite3.connect(str(obs_path), timeout=300.0)
                conn.execute("PRAGMA busy_timeout=300000")
                conn.execute("VACUUM")
                conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
                conn.close()
                vacuumed = True
            except Exception as exc:
                logger.warning("observability size-cap VACUUM failed: %s", exc)
    elif before > max_bytes:
        vacuumed = _vacuum_observability_rebuild(obs_path)

    after = _observability_db_bytes(obs_path)
    logger.info(
        "observability size cap: stripped=%d deleted=%d vacuum=%s size %.2f GB -> %.2f GB",
        stripped,
        deleted,
        vacuumed,
        before / (1024**3),
        after / (1024**3),
    )
    return (stripped, deleted, vacuumed)


def prune_observability_db(
    obs_path: Path,
    *,
    days: int,
    gateway_requests_days: int | None = None,
) -> int:
    if not obs_path.is_file():
        return 0
    gw_days = max(1, int(gateway_requests_days if gateway_requests_days is not None else days))
    conn = sqlite3.connect(str(obs_path), timeout=60.0)
    try:
        total = 0
        for table, col in (
            (ObservabilityTable.TRACE_EVENTS, "occurred_at"),
            (ObservabilityTable.MODEL_INVOCATIONS, "requested_at"),
            (ObservabilityTable.TOOL_INVOCATIONS, "started_at"),
            (ObservabilityTable.TASK_LIFECYCLE_EVENTS, "occurred_at"),
            (ObservabilityTable.IM_CHANNEL_ERRORS, "occurred_at"),
            (ObservabilityTable.GATEWAY_REQUESTS, "occurred_at"),
        ):
            table_days = gw_days if table == ObservabilityTable.GATEWAY_REQUESTS else days
            total += _delete_older_than(conn, table, col, _cutoff_iso(table_days))
        conn.execute(
            f"""
            DELETE FROM {ObservabilityTable.THREADS}
            WHERE last_seen_at < ?
              AND thread_id NOT IN (
                SELECT DISTINCT thread_id FROM {ObservabilityTable.TRACE_EVENTS}
                WHERE thread_id IS NOT NULL AND thread_id != ''
              )
            """,
            (_cutoff_iso(days),),
        )
        conn.commit()
        return total
    finally:
        conn.close()


def prune_task_stream_events(*, days: int) -> int:
    cutoff = _cutoff_iso(days)

    def _do() -> int:
        conn = get_db()
        if not conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='evoflow_task_events'"
        ).fetchone():
            return 0
        rows = conn.execute(
            f"""
            SELECT DISTINCT main_task_id FROM evoflow_collab_tasks
            WHERE task_id = main_task_id
              AND lower(status) IN ({",".join("?" * len(_TERMINAL_TASK_STATUSES))})
              AND updated_at < ?
            """,
            (*_TERMINAL_TASK_STATUSES, cutoff),
        ).fetchall()
        ids = [str(r[0]) for r in rows if r and r[0]]
        if not ids:
            return 0
        deleted = 0
        for mid in ids:
            cur = conn.execute(
                "DELETE FROM evoflow_task_events WHERE event_type = ? AND task_id = ?",
                ("stream", mid),
            )
            deleted += int(cur.rowcount or 0)
        conn.commit()
        return deleted

    return run_db_with_retry(_do)


def prune_task_status_events(*, days: int) -> int:
    cutoff = _cutoff_iso(days)

    def _do() -> int:
        conn = get_db()
        if not conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='evoflow_task_events'"
        ).fetchone():
            return 0
        cur = conn.execute(
            "DELETE FROM evoflow_task_events WHERE event_type = ? AND created_at < ?",
            ("status", cutoff),
        )
        conn.commit()
        return int(cur.rowcount or 0)

    return run_db_with_retry(_do)


def prune_automation_runs(*, keep_per_task: int) -> int:
    keep = max(5, int(keep_per_task))

    def _do() -> int:
        conn = get_db()
        task_rows = conn.execute("SELECT DISTINCT task_id FROM evoflow_automation_runs").fetchall()
        deleted = 0
        for row in task_rows:
            tid = str(row[0] or "").strip()
            if not tid:
                continue
            ids = conn.execute(
                """
                SELECT id FROM evoflow_automation_runs
                WHERE task_id = ?
                ORDER BY id DESC
                LIMIT -1 OFFSET ?
                """,
                (tid, keep),
            ).fetchall()
            if not ids:
                continue
            placeholders = ",".join("?" * len(ids))
            cur = conn.execute(
                f"DELETE FROM evoflow_automation_runs WHERE id IN ({placeholders})",
                [int(r[0]) for r in ids],
            )
            deleted += int(cur.rowcount or 0)
        conn.commit()
        return deleted

    return run_db_with_retry(_do)


def prune_soft_deleted_session_messages() -> int:
    def _do() -> int:
        conn = get_db()
        rows = conn.execute(
            """
            SELECT session_key FROM evoflow_chat_sessions
            WHERE is_deleted = 1
            """
        ).fetchall()
        deleted = 0
        for row in rows:
            sk = str(row[0] or "").strip()
            if not sk:
                continue
            cur = conn.execute("DELETE FROM evoflow_chat_messages WHERE session_key = ?", (sk,))
            deleted += int(cur.rowcount or 0)
        conn.commit()
        return deleted

    return run_db_with_retry(_do)


def _protected_thread_ids(conn: sqlite3.Connection) -> set[str]:
    protected: set[str] = set()
    for row in conn.execute(
        """
        SELECT thread_id FROM evoflow_chat_sessions
        WHERE is_deleted = 0 AND thread_id IS NOT NULL AND thread_id != ''
        """
    ).fetchall():
        protected.add(str(row[0]))
    placeholders = ",".join("?" * len(_ACTIVE_SUBTASK_STATUSES))
    for row in conn.execute(
        f"""
        SELECT DISTINCT thread_id FROM evoflow_collab_subtasks
        WHERE thread_id IS NOT NULL AND thread_id != ''
          AND lower(status) IN ({placeholders})
        """,
        _ACTIVE_SUBTASK_STATUSES,
    ).fetchall():
        protected.add(str(row[0]))
    for row in conn.execute(
        f"""
        SELECT DISTINCT thread_id FROM evoflow_collab_tasks
        WHERE thread_id IS NOT NULL AND thread_id != ''
          AND lower(status) IN ({placeholders})
        """,
        _ACTIVE_SUBTASK_STATUSES,
    ).fetchall():
        protected.add(str(row[0]))
    return protected


def _stale_deleted_session_threads(conn: sqlite3.Connection, *, days: int) -> set[str]:
    cutoff_ms = int((datetime.now(UTC) - timedelta(days=max(7, int(days)))).timestamp() * 1000)
    out: set[str] = set()
    for row in conn.execute(
        """
        SELECT thread_id, updated_at FROM evoflow_chat_sessions
        WHERE is_deleted = 1 AND thread_id IS NOT NULL AND thread_id != ''
        """
    ).fetchall():
        tid = str(row[0] or "").strip()
        if not tid:
            continue
        updated_ms = iso_z_to_ms(str(row[1] or ""))
        if updated_ms <= 0 or updated_ms < cutoff_ms:
            out.add(tid)
    return out


def _inactive_session_threads(conn: sqlite3.Connection, *, days: int) -> set[str]:
    """Sessions still listed but not updated recently (abandoned chats)."""
    cutoff_ms = int((datetime.now(UTC) - timedelta(days=max(7, int(days)))).timestamp() * 1000)
    out: set[str] = set()
    for row in conn.execute(
        """
        SELECT thread_id, updated_at FROM evoflow_chat_sessions
        WHERE is_deleted = 0 AND thread_id IS NOT NULL AND thread_id != ''
        """
    ).fetchall():
        tid = str(row[0] or "").strip()
        if not tid:
            continue
        updated_ms = iso_z_to_ms(str(row[1] or ""))
        if updated_ms <= 0 or updated_ms < cutoff_ms:
            out.add(tid)
    return out


def _all_session_thread_ids(conn: sqlite3.Connection) -> set[str]:
    out: set[str] = set()
    for row in conn.execute(
        """
        SELECT DISTINCT thread_id FROM evoflow_chat_sessions
        WHERE thread_id IS NOT NULL AND thread_id != ''
        """
    ).fetchall():
        out.add(str(row[0]))
    return out


def prune_orphan_writes(conn: sqlite3.Connection) -> int:
    """Remove ``writes`` rows whose ``checkpoint_id`` no longer exists (safety net after partial deletes)."""
    cur = conn.execute(
        """
        DELETE FROM writes
        WHERE NOT EXISTS (
            SELECT 1 FROM checkpoints c
            WHERE c.thread_id = writes.thread_id AND c.checkpoint_id = writes.checkpoint_id
        )
        """
    )
    return int(cur.rowcount or 0)


def prune_checkpoint_history_per_thread(
    cp_path: Path,
    *,
    keep_per_thread: int,
    conn: sqlite3.Connection | None = None,
) -> tuple[int, int]:
    """Keep only the newest N checkpoints per thread; drop all ``writes`` for removed checkpoints.

    Returns:
        (checkpoints_deleted, writes_deleted)
    """
    keep = max(1, int(keep_per_thread))
    if not cp_path.is_file():
        return 0, 0
    own_conn = conn is None
    if own_conn:
        conn = sqlite3.connect(str(cp_path), timeout=120.0)
    cp_deleted = 0
    writes_deleted = 0
    try:
        if conn is None or not _checkpoints_table_exists(conn):
            return 0, 0
        thread_rows = conn.execute("SELECT DISTINCT thread_id FROM checkpoints").fetchall()
        for trow in thread_rows:
            tid = str(trow[0] or "").strip()
            if not tid:
                continue
            rows = conn.execute(
                """
                SELECT checkpoint_ns, checkpoint_id FROM checkpoints
                WHERE thread_id = ?
                ORDER BY rowid DESC
                """,
                (tid,),
            ).fetchall()
            if len(rows) <= keep:
                continue
            kept = rows[:keep]
            drop = rows[keep:]
            kept_ids = [str(r[1]) for r in kept]
            drop_ids = [str(r[1]) for r in drop]
            if drop_ids:
                w_ph = ",".join("?" * len(drop_ids))
                cur_w = conn.execute(
                    f"DELETE FROM writes WHERE thread_id = ? AND checkpoint_id IN ({w_ph})",
                    [tid, *drop_ids],
                )
                writes_deleted += int(cur_w.rowcount or 0)
            for ns, cid in drop:
                cur_c = conn.execute(
                    """
                    DELETE FROM checkpoints
                    WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?
                    """,
                    (tid, str(ns or ""), str(cid or "")),
                )
                cp_deleted += int(cur_c.rowcount or 0)
            # Belt-and-suspenders: no writes may reference dropped checkpoint ids.
            if kept_ids:
                k_ph = ",".join("?" * len(kept_ids))
                cur_w2 = conn.execute(
                    f"DELETE FROM writes WHERE thread_id = ? AND checkpoint_id NOT IN ({k_ph})",
                    [tid, *kept_ids],
                )
                writes_deleted += int(cur_w2.rowcount or 0)
        if own_conn:
            writes_deleted += prune_orphan_writes(conn)
            conn.commit()
        return cp_deleted, writes_deleted
    finally:
        if own_conn and conn is not None:
            conn.close()


def run_checkpoint_db_retention(
    cp_path: Path,
    *,
    protected: set[str],
    purge_thread_ids: set[str],
    keep_per_thread: int,
) -> tuple[int, int, int, int, int]:
    """One connection: whole-thread purge, per-thread trim, orphan writes.

    Returns:
        (threads_purged, checkpoints_deleted, writes_deleted, history_cp_deleted, history_writes_deleted)
    """
    if not cp_path.is_file():
        return 0, 0, 0, 0, 0
    conn = sqlite3.connect(str(cp_path), timeout=120.0)
    threads_purged = 0
    cp_deleted = 0
    writes_deleted = 0
    hist_cp = 0
    hist_writes = 0
    try:
        if not _checkpoints_table_exists(conn):
            return 0, 0, 0, 0, 0
        all_threads = {str(r[0]) for r in conn.execute("SELECT DISTINCT thread_id FROM checkpoints").fetchall() if r[0]}
        to_drop = (purge_thread_ids - protected) & all_threads
        for tid in to_drop:
            cur_w = conn.execute("DELETE FROM writes WHERE thread_id = ?", (tid,))
            cur_c = conn.execute("DELETE FROM checkpoints WHERE thread_id = ?", (tid,))
            writes_deleted += int(cur_w.rowcount or 0)
            cp_deleted += int(cur_c.rowcount or 0)
            threads_purged += 1
        hist_cp, hist_writes = prune_checkpoint_history_per_thread(
            cp_path,
            keep_per_thread=keep_per_thread,
            conn=conn,
        )
        writes_deleted += hist_writes
        writes_deleted += prune_orphan_writes(conn)
        cp_deleted += hist_cp
        conn.commit()
        return threads_purged, cp_deleted, writes_deleted, hist_cp, hist_writes
    finally:
        conn.close()


def purge_orphan_checkpoints(
    cp_path: Path,
    *,
    protected: set[str],
    stale_deleted_threads: set[str],
    never_session_threads: set[str],
) -> tuple[int, int]:
    """Delete checkpoint rows for stale/orphan threads (never drops ``protected``)."""
    if not cp_path.is_file():
        return 0, 0
    conn = sqlite3.connect(str(cp_path), timeout=120.0)
    try:
        if not _checkpoints_table_exists(conn):
            return 0, 0
        rows = conn.execute("SELECT DISTINCT thread_id FROM checkpoints").fetchall()
        all_threads = {str(r[0]) for r in rows if r and r[0]}
        to_drop = (stale_deleted_threads | never_session_threads) - protected
        to_drop &= all_threads
        if not to_drop:
            return 0, 0
        rows_deleted = 0
        for tid in to_drop:
            cur_w = conn.execute("DELETE FROM writes WHERE thread_id = ?", (tid,))
            cur_c = conn.execute("DELETE FROM checkpoints WHERE thread_id = ?", (tid,))
            rows_deleted += int(cur_w.rowcount or 0) + int(cur_c.rowcount or 0)
        conn.commit()
        return len(to_drop), rows_deleted
    finally:
        conn.close()


def _vacuum_paths(paths: list[Path]) -> list[str]:
    done: list[str] = []
    for p in paths:
        if not p.is_file():
            continue
        try:
            conn = sqlite3.connect(str(p), timeout=120.0)
            conn.execute("VACUUM")
            conn.close()
            done.append(str(p))
        except Exception as exc:
            logger.warning("VACUUM failed for %s: %s", p, exc)
    return done


def run_data_retention(
    cfg: DataRetentionConfig,
    *,
    base_dir: Path,
    logs_dir: Path | None = None,
) -> RetentionRunResult:
    """Execute one retention pass (safe to call periodically)."""
    from evoflow.config.app_config import get_app_config
    from evoflow.config.data_paths import resolve_observability_db_config_path

    result = RetentionRunResult()
    try:
        log_path = logs_dir
        if log_path is None:
            from evoflow.config.data_paths import logs_dir as canonical_logs_dir

            log_path = canonical_logs_dir(base_dir)
        result.logs_removed = prune_gateway_logs(log_path, days=cfg.logs_days)
    except Exception as exc:
        result.errors.append(f"logs: {exc}")
        logger.warning("retention: log prune failed", exc_info=True)

    try:
        obs_raw = ""
        try:
            obs_raw = str(get_app_config().observability.sqlite_path or "")
        except Exception:
            pass
        obs_path = resolve_observability_db_config_path(obs_raw, base_dir=base_dir)
        if not obs_path.is_file():
            obs_path = observability_db_path(base_dir)
        result.obs_rows_deleted = prune_observability_db(
            obs_path,
            days=cfg.observability_days,
            gateway_requests_days=cfg.gateway_requests_days,
        )
        max_bytes = int(float(cfg.observability_max_size_gb) * (1024**3))
        if max_bytes > 0:
            stripped, cap_deleted, cap_vacuumed = enforce_observability_db_size_cap(
                obs_path,
                max_bytes=max_bytes,
                min_gateway_days=min(cfg.gateway_requests_days, 3),
                model_json_limit=int(cfg.observability_model_json_limit_bytes),
            )
            result.obs_gateway_stripped = stripped
            result.obs_size_cap_deleted = cap_deleted
            if cap_vacuumed and str(obs_path) not in result.vacuumed:
                result.vacuumed.append(str(obs_path))
            result.obs_rows_deleted += cap_deleted
    except Exception as exc:
        result.errors.append(f"observability: {exc}")
        logger.warning("retention: observability prune failed", exc_info=True)

    try:
        result.task_stream_deleted = prune_task_stream_events(days=cfg.task_stream_days)
    except Exception as exc:
        result.errors.append(f"app_db:task_stream: {exc}")
        logger.warning("retention: task stream prune failed", exc_info=True)
    try:
        result.task_status_deleted = prune_task_status_events(days=cfg.task_status_events_days)
    except Exception as exc:
        result.errors.append(f"app_db:task_status: {exc}")
        logger.warning("retention: task status prune failed", exc_info=True)
    try:
        result.automation_runs_deleted = prune_automation_runs(keep_per_task=cfg.automation_runs_per_task)
    except Exception as exc:
        result.errors.append(f"app_db:automation_runs: {exc}")
        logger.warning("retention: automation runs prune failed", exc_info=True)
    try:
        result.soft_deleted_messages = prune_soft_deleted_session_messages()
    except Exception as exc:
        result.errors.append(f"app_db:soft_deleted_messages: {exc}")
        logger.warning("retention: soft-deleted session messages prune failed", exc_info=True)

    try:
        def _load_checkpoint_context() -> tuple[set[str], set[str], set[str], set[str]]:
            app_conn = get_db()
            protected = _protected_thread_ids(app_conn)
            any_sessions = _all_session_thread_ids(app_conn)
            stale_threads = _stale_deleted_session_threads(app_conn, days=cfg.checkpoint_orphan_days)
            inactive_threads = _inactive_session_threads(app_conn, days=cfg.checkpoint_inactive_session_days)
            return protected, any_sessions, stale_threads, inactive_threads

        protected, any_sessions, stale_threads, inactive_threads = run_db_with_retry(_load_checkpoint_context)
        cp_raw = ""
        try:
            cp_cfg = get_app_config().checkpointer
            if cp_cfg is not None:
                cp_raw = str(cp_cfg.connection_string or "")
        except Exception:
            pass
        cp_path = resolve_checkpoints_config_path(cp_raw or None, base_dir=base_dir)
        if cp_raw in (":memory:",) or str(cp_raw).startswith("file:"):
            pass
        else:
            if not cp_path.is_file():
                cp_path = checkpoints_db_path(base_dir)
            if cp_path.is_file():
                cp_conn = sqlite3.connect(str(cp_path), timeout=60.0)
                try:
                    if not _checkpoints_table_exists(cp_conn):
                        logger.debug("retention: checkpoints db not initialized, skipping checkpoint prune")
                    else:
                        cp_threads = {
                            str(r[0])
                            for r in cp_conn.execute("SELECT DISTINCT thread_id FROM checkpoints").fetchall()
                            if r[0]
                        }
                        never_session = cp_threads - any_sessions - protected
                        purge_whole_thread = (stale_threads | never_session | inactive_threads) - protected
                        (
                            result.checkpoint_threads_purged,
                            cp_rows,
                            result.writes_rows_deleted,
                            hist_cp,
                            _hist_writes,
                        ) = run_checkpoint_db_retention(
                            cp_path,
                            protected=protected,
                            purge_thread_ids=purge_whole_thread,
                            keep_per_thread=cfg.checkpoint_keep_per_thread,
                        )
                        result.checkpoint_rows_deleted = cp_rows
                        result.checkpoint_history_rows_deleted = hist_cp
                        for tid in purge_whole_thread:
                            try:
                                from evoflow.config.paths import get_paths

                                get_paths().delete_thread_dir(tid)
                            except Exception:
                                logger.debug("retention: delete_thread_dir failed %s", tid, exc_info=True)
                finally:
                    cp_conn.close()
    except Exception as exc:
        result.errors.append(f"checkpoints: {exc}")
        logger.warning("retention: checkpoint prune failed", exc_info=True)

    deleted_total = (
        result.logs_removed
        + result.obs_rows_deleted
        + result.task_stream_deleted
        + result.task_status_deleted
        + result.automation_runs_deleted
        + result.soft_deleted_messages
        + result.checkpoint_threads_purged
        + result.checkpoint_rows_deleted
        + result.checkpoint_history_rows_deleted
        + result.writes_rows_deleted
    )
    # VACUUM takes an exclusive lock and can stall chat for minutes on large DBs
    # (observability alone may be multi-GB). Only compact after real deletes unless
    # vacuum_min_deleted_rows=0 (always vacuum when enabled).
    min_deleted = int(getattr(cfg, "vacuum_min_deleted_rows", 1) or 0)
    if cfg.vacuum_sqlite and deleted_total >= min_deleted:
        try:
            app_path = resolve_evolflow_db_path()
            obs_path = observability_db_path(base_dir)
            cp_path = checkpoints_db_path(base_dir)
            result.vacuumed = _vacuum_paths(
                [p for p in (app_path, obs_path, cp_path) if p.is_file()]
            )
        except Exception as exc:
            result.errors.append(f"vacuum: {exc}")
    elif cfg.vacuum_sqlite:
        logger.info(
            "data retention: skip VACUUM (deleted_total=%d < vacuum_min_deleted_rows=%d)",
            deleted_total,
            min_deleted,
        )

    logger.info(
        "data retention: logs=%d obs=%d stream=%d status=%d automation=%d msgs=%d cp_threads=%d cp_rows=%d cp_history=%d writes=%d vacuum=%s errors=%d",
        result.logs_removed,
        result.obs_rows_deleted,
        result.task_stream_deleted,
        result.task_status_deleted,
        result.automation_runs_deleted,
        result.soft_deleted_messages,
        result.checkpoint_threads_purged,
        result.checkpoint_rows_deleted,
        result.checkpoint_history_rows_deleted,
        result.writes_rows_deleted,
        result.vacuumed,
        len(result.errors),
    )
    return result
