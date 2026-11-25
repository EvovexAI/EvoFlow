"""Retention helpers for EvoFlow SQLite databases and logs."""

from __future__ import annotations

import logging
import os
import sqlite3
from collections.abc import Callable
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
    row = conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='checkpoints' LIMIT 1").fetchone()
    return row is not None


_ACTIVE_SUBTASK_STATUSES = ("pending", "executing", "paused", "running", "in_progress")


@dataclass
class RetentionRunResult:
    logs_removed: int = 0
    obs_rows_deleted: int = 0
    obs_gateway_stripped: int = 0
    obs_size_cap_deleted: int = 0
    usage_events_deleted: int = 0
    usage_meta_stripped: int = 0
    v4_event_log_deleted: int = 0
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
    """Prune all ``{prefix}-YYYY-MM-DD.log`` under the real product logs root."""
    from evoflow.runtime.log_policy import prune_all_daily_logs

    return prune_all_daily_logs(log_dir, days=days)


def prune_usage_events(*, days: int) -> int:
    """Delete ``evoflow_usage_events`` older than *days* (high-volume ledger)."""
    keep_days = max(1, int(days))
    # Date-only prefix compares cleanly for both ``...Z`` and ``...+08:00`` ISO rows.
    cutoff_day = (datetime.now(UTC) - timedelta(days=keep_days)).strftime("%Y-%m-%d")
    try:
        path = resolve_evolflow_db_path()
        if not path.is_file():
            return 0
        conn = sqlite3.connect(str(path), timeout=120.0)
        try:
            cur = conn.execute(
                "DELETE FROM evoflow_usage_events WHERE occurred_at < ?",
                (cutoff_day,),
            )
            conn.commit()
            return int(cur.rowcount or 0)
        finally:
            conn.close()
    except Exception:
        logger.debug("usage_events prune failed days=%s", keep_days, exc_info=True)
        return 0


def strip_usage_events_heavy_meta(*, json_limit: int) -> int:
    """Replace oversized ``meta_json`` with ``{}`` (column is NOT NULL; keeps ledger totals)."""
    limit = max(1024, int(json_limit))
    try:
        path = resolve_evolflow_db_path()
        if not path.is_file():
            return 0
        conn = sqlite3.connect(str(path), timeout=120.0)
        try:
            cur = conn.execute(
                """
                UPDATE evoflow_usage_events
                SET meta_json = '{}'
                WHERE length(meta_json) > ?
                """,
                (limit,),
            )
            conn.commit()
            return int(cur.rowcount or 0)
        finally:
            conn.close()
    except Exception:
        logger.debug("usage_events meta strip failed", exc_info=True)
        return 0


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


def _delete_oldest_rows(
    conn: sqlite3.Connection,
    table: str,
    *,
    batch: int,
    time_col: str = "occurred_at",
    older_than: str | None = None,
) -> int:
    """Delete the oldest ``batch`` rows; ``older_than`` makes that a hard floor.

    【self-evolution-bot · 2026-11-19 · 第68轮 · 模型:deepseek-v4.1-flash-1017】
    ``older_than`` 新增：体积上限压缩时必须能给"保留天数"留一条硬底线，
    否则 2GB 上限会把 7 天接口历史削成 13 小时（11-19 实测：235,970 行全在同一天）。

    时间比较用 ``julianday()`` 而不是字符串排序：``occurred_at`` 存的是
    ``+08:00`` 偏移，而 ``_cutoff_iso`` 产出 ``Z`` 后缀，同一天内直接比字符串会错 8 小时。
    """
    if older_than:
        cur = conn.execute(
            f"""
            DELETE FROM {table}
            WHERE rowid IN (
                SELECT rowid FROM {table}
                WHERE julianday({time_col}) < julianday(?)
                ORDER BY {time_col} ASC
                LIMIT ?
            )
            """,
            (older_than, max(1, int(batch))),
        )
    else:
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


def _vacuum_max_bytes() -> int:
    """Max SQLite file size allowed for in-process VACUUM (0 = unlimited).

    Multi-GB VACUUM holds an exclusive lock for minutes and stalls every Gateway
    REST that touches the DB (2026-11-19 15:03: proactive/approvals 86s while
    evoflow.db / observability.db were vacuumed). Override with
    ``EVOFLOW_VACUUM_MAX_BYTES`` (bytes).
    """
    raw = (os.getenv("EVOFLOW_VACUUM_MAX_BYTES") or "").strip()
    if raw:
        try:
            return max(0, int(raw))
        except ValueError:
            pass
    return 256 * 1024 * 1024


def _skip_vacuum_due_to_size(path: Path) -> bool:
    """True when *path* is too large for safe in-process VACUUM."""
    max_b = _vacuum_max_bytes()
    if max_b <= 0:
        return False
    try:
        size = path.stat().st_size
    except OSError:
        return False
    if size <= max_b:
        return False
    logger.warning(
        "skip in-process VACUUM for %s (size=%.2f GB > limit %.2f GB); "
        "set EVOFLOW_VACUUM_MAX_BYTES=0 to force, or compact offline",
        path,
        size / (1024**3),
        max_b / (1024**3),
    )
    return True


def _observability_freelist_bytes(obs_path: Path) -> int:
    """Bytes held in SQLite freelist (deleted but not yet reclaimed by VACUUM)."""
    if not obs_path.is_file():
        return 0
    try:
        conn = sqlite3.connect(f"file:{obs_path.as_posix()}?mode=ro", uri=True, timeout=30.0)
        try:
            page_size = int(conn.execute("PRAGMA page_size").fetchone()[0] or 0)
            freelist = int(conn.execute("PRAGMA freelist_count").fetchone()[0] or 0)
            return max(0, page_size * freelist)
        finally:
            conn.close()
    except Exception:
        logger.debug("observability freelist probe failed", exc_info=True)
        return 0


def _replace_sqlite_file(src: Path, dest: Path, *, attempts: int = 12) -> None:
    """Replace *dest* with *src* (Windows-safe retries when antivirus/handles lag)."""
    import time

    last_exc: OSError | None = None
    for i in range(max(1, attempts)):
        try:
            os.replace(str(src), str(dest))
            return
        except OSError as exc:
            last_exc = exc
            # WinError 32 / 5: file still mapped; brief backoff + re-quiesce store.
            try:
                from evoflow.observability.recorder import reset_observability_store

                reset_observability_store()
            except Exception:
                pass
            time.sleep(min(2.0, 0.15 * (i + 1)))
    assert last_exc is not None
    raise last_exc


def _vacuum_observability_rebuild(obs_path: Path) -> bool:
    """Rebuild observability.db via ``VACUUM INTO`` (compact file, drop WAL).

    This is the supported compact path for **multi-GB** obs DBs. Do **not** gate on
    ``EVOFLOW_VACUUM_MAX_BYTES`` — that guard is only for in-place ``VACUUM``
    (2026-11-23 non-dev: ~1GB freelist unreclaimed because rebuild wrongly skipped
    when the file was already over the in-process VACUUM size limit).

    Holds the in-process store quiesce lock for the whole swap so writers cannot
    reopen mid-rename (2026-11-24: VACUUM INTO ok then WinError 32 on replace).
    """
    if not obs_path.is_file():
        return False
    before = _observability_db_bytes(obs_path)
    freelist_b = _observability_freelist_bytes(obs_path)
    rebuilt = obs_path.with_suffix(".db.rebuild")
    backup = obs_path.with_suffix(".db.bak")
    try:
        from evoflow.observability.recorder import observability_store_quiesced
    except Exception:
        observability_store_quiesced = None  # type: ignore[assignment]
        logger.debug("observability store quiesce import failed", exc_info=True)

    def _do_rebuild() -> bool:
        if rebuilt.exists():
            rebuilt.unlink()
        logger.info(
            "observability VACUUM INTO rebuild starting size=%.2f GB freelist=%.2f GB path=%s",
            before / (1024**3),
            freelist_b / (1024**3),
            obs_path,
        )
        conn = sqlite3.connect(str(obs_path), timeout=300.0)
        try:
            conn.execute("PRAGMA busy_timeout=300000")
            # Forward slashes work on Windows for SQLite path args.
            conn.execute(f"VACUUM INTO '{rebuilt.as_posix()}'")
        finally:
            conn.close()
        if not rebuilt.is_file() or rebuilt.stat().st_size <= 0:
            return False
        if backup.exists():
            try:
                backup.unlink()
            except OSError:
                pass
        # Move live → bak, then rebuilt → live (retries for WinError 32).
        _replace_sqlite_file(obs_path, backup)
        try:
            _replace_sqlite_file(rebuilt, obs_path)
        except OSError:
            # Roll back if we cannot install the compacted file.
            try:
                _replace_sqlite_file(backup, obs_path)
            except OSError:
                pass
            raise
        for suffix in ("-wal", "-shm"):
            side = Path(f"{obs_path}{suffix}")
            if side.is_file():
                try:
                    side.unlink()
                except OSError:
                    pass
        if backup.is_file():
            try:
                backup.unlink()
            except OSError:
                pass
        after = _observability_db_bytes(obs_path)
        logger.info(
            "observability VACUUM INTO rebuild done %.2f GB -> %.2f GB",
            before / (1024**3),
            after / (1024**3),
        )
        return True

    try:
        if observability_store_quiesced is not None:
            with observability_store_quiesced():
                return _do_rebuild()
        return _do_rebuild()
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
    min_model_days: int = 3,
    vacuum_path_guard: Callable[[], bool] | None = None,
) -> tuple[int, int, bool]:
    """Shrink observability.db when it exceeds *max_bytes*. Returns (stripped, deleted, vacuumed).

    【self-evolution-bot · 2026-11-19 · 第68轮 · 模型:deepseek-v4.1-flash-1017】
    ``min_gateway_days`` / ``min_model_days`` 从"保留参数（空实现）"变成**真硬底线**。

    缺陷（现网实证 2026-11-19）：配置里 ``gateway_requests_days=7``，实际
    ``evoflow_obs_gateway_requests`` 只剩当天 13 小时（235,970 行全在 11-19）。
    根因是本函数按 ``target_ratio`` 等比删最旧行、且**先删网关请求再删模型 JSON**，
    2GB 上限打满时把「最能说明接口问题的表」删成 0，却保住了 912MB 的模型请求体。

    修复口径：
    ① 先剥大字段（模型 request/response JSON）——这是体积大头，不丢耗时数字；
    ② 删行只在「超过底线天数」的行里删，绝不碰底线内的数据；
    ③ 若守住底线后仍超上限，**明确 warning 报超出多少**，由人决定调高
       ``observability_max_size_gb`` 或缩短保留天数，而不是静默削掉近期历史；
    ④ 回收磁盘必须走 ``VACUUM INTO``（多 GB 也允许）；忙时由 ``vacuum_path_guard`` 让路。
    """
    if not obs_path.is_file() or max_bytes <= 0:
        return (0, 0, False)
    before = _observability_db_bytes(obs_path)
    freelist_before = _observability_freelist_bytes(obs_path)
    # Also reclaim when freelist bloat alone is huge (DELETE already ran; file still fat).
    freelist_reclaim_min = 256 * 1024 * 1024
    needs_compact = before > max_bytes or freelist_before >= freelist_reclaim_min
    if not needs_compact:
        return (0, 0, False)

    stripped = 0
    deleted = 0
    vacuumed = False
    conn = sqlite3.connect(str(obs_path), timeout=120.0)
    try:
        logger.warning(
            "observability.db size %.2f GB (freelist %.2f GB) exceeds cap %.2f GB or freelist reclaim; compacting",
            before / (1024**3),
            freelist_before / (1024**3),
            max_bytes / (1024**3),
        )
        stripped = strip_gateway_request_heavy_columns(conn)
        model_stripped = strip_model_invocation_heavy_columns(conn, json_limit=model_json_limit)
        stripped += model_stripped
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        conn.commit()

        if before > max_bytes:
            gw_count_row = conn.execute(f"SELECT COUNT(*) FROM {ObservabilityTable.GATEWAY_REQUESTS}").fetchone()
            gw_count = int(gw_count_row[0] or 0) if gw_count_row else 0
            # SQLite file size barely drops until VACUUM — estimate rows to delete from ratio.
            target_ratio = max(0.05, min(1.0, max_bytes / before))
            keep_gateway = max(1, int(gw_count * target_ratio * 0.85))
            if gw_count > 10_000:
                keep_gateway = max(5_000, keep_gateway)
            keep_gateway = min(gw_count, keep_gateway)
            to_delete = max(0, gw_count - keep_gateway)
            # 硬底线：底线天数内的行一条都不许删（2026-11-19 实测 7 天被削成 13 小时）。
            gw_floor = _cutoff_iso(max(1, int(min_gateway_days))) if min_gateway_days > 0 else None
            batch = 50_000
            while to_delete > 0:
                n = _delete_oldest_rows(
                    conn,
                    ObservabilityTable.GATEWAY_REQUESTS,
                    batch=min(batch, to_delete),
                    older_than=gw_floor,
                )
                if n <= 0:
                    break
                deleted += n
                to_delete -= n

            if before > max_bytes * 1.2:
                model_count_row = conn.execute(f"SELECT COUNT(*) FROM {ObservabilityTable.MODEL_INVOCATIONS}").fetchone()
                model_count = int(model_count_row[0] or 0) if model_count_row else 0
                keep_model = max(1_000, int(model_count * target_ratio * 0.85))
                if model_count > 5_000:
                    keep_model = max(2_000, keep_model)
                keep_model = min(model_count, keep_model)
                model_to_delete = max(0, model_count - keep_model)
                model_floor = _cutoff_iso(max(1, int(min_model_days))) if min_model_days > 0 else None
                while model_to_delete > 0:
                    n = _delete_oldest_rows(
                        conn,
                        ObservabilityTable.MODEL_INVOCATIONS,
                        batch=min(batch, model_to_delete),
                        time_col="requested_at",
                        older_than=model_floor,
                    )
                    if n <= 0:
                        break
                    deleted += n
                    model_to_delete -= n

            if before > max_bytes * 1.5:
                trace_count_row = conn.execute(f"SELECT COUNT(*) FROM {ObservabilityTable.TRACE_EVENTS}").fetchone()
                trace_count = int(trace_count_row[0] or 0) if trace_count_row else 0
                keep_trace = max(10_000, int(trace_count * target_ratio * 0.85))
                trace_to_delete = max(0, trace_count - keep_trace)
                trace_floor = _cutoff_iso(max(1, int(min_gateway_days))) if min_gateway_days > 0 else None
                while trace_to_delete > 0:
                    n = _delete_oldest_rows(
                        conn,
                        ObservabilityTable.TRACE_EVENTS,
                        batch=min(batch, trace_to_delete),
                        older_than=trace_floor,
                    )
                    if n <= 0:
                        break
                    deleted += n
                    trace_to_delete -= n

        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        conn.commit()
    finally:
        conn.close()

    # Disk reclaim: VACUUM INTO works for multi-GB; skip only when chat/REST is busy.
    should_rebuild = stripped > 0 or deleted > 0 or before > max_bytes or freelist_before >= freelist_reclaim_min
    if should_rebuild:
        if vacuum_path_guard is not None and not vacuum_path_guard():
            logger.info(
                "observability size-cap: skip VACUUM INTO (busy guard); will retry while over cap"
            )
        else:
            vacuumed = _vacuum_observability_rebuild(obs_path)
            if not vacuumed and not _skip_vacuum_due_to_size(obs_path):
                try:
                    conn = sqlite3.connect(str(obs_path), timeout=300.0)
                    conn.execute("PRAGMA busy_timeout=300000")
                    conn.execute("VACUUM")
                    conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
                    conn.close()
                    vacuumed = True
                except Exception as exc:
                    logger.warning("observability size-cap VACUUM failed: %s", exc)

    after = _observability_db_bytes(obs_path)
    logger.info(
        "observability size cap: stripped=%d deleted=%d vacuum=%s size %.2f GB -> %.2f GB",
        stripped,
        deleted,
        vacuumed,
        before / (1024**3),
        after / (1024**3),
    )
    # 【self-evolution-bot · 2026-11-19 · 第68轮】守住底线仍超上限 → 必须**明确报出来**。
    # 旧行为是默默把近期历史削到 0 行，运维看面板只看到"统计没了"，查不到原因。
    if after > max_bytes:
        logger.warning(
            "observability.db still %.2f GB over cap %.2f GB after compaction; "
            "recent history preserved by floor (gateway>=%dd, model>=%dd). "
            "Raise data_retention.observability_max_size_gb or lower retention days — "
            "NOT silently dropping recent rows.",
            after / (1024**3),
            max_bytes / (1024**3),
            int(min_gateway_days),
            int(min_model_days),
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
        if not conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='evoflow_task_events'").fetchone():
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
        if not conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='evoflow_task_events'").fetchone():
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
            # 逐线程提交，收缩 checkpoints.db 写锁窗口：LG 运行时进程每 superstep
            # 都要 put（busy_timeout 5s），长事务会让活跃 run 报 database is locked。
            # 单线程的 checkpoints+writes 删除自洽，分批提交不破坏一致性。
            if not own_conn:
                conn.commit()
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
    conn.execute("PRAGMA busy_timeout=10000")
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
            # 逐线程提交：LG 运行时进程每个 superstep 都会 put（busy_timeout 只有 5s），
            # 单一长写事务覆盖整轮 purge 会让活跃 run 直接 OperationalError 失败。
            conn.commit()
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


def apply_pending_sqlite_rebuild(db_path: Path) -> bool:
    """Install ``{db}.rebuild`` over *db_path* when a prior VACUUM INTO could not rename.

    Call before opening the live DB (Gateway startup). Returns True when swapped.
    """
    rebuilt = db_path.with_suffix(db_path.suffix + ".rebuild")
    if not rebuilt.is_file() or rebuilt.stat().st_size <= 0:
        return False
    if db_path.is_file() and rebuilt.stat().st_size >= db_path.stat().st_size:
        # Rebuild not smaller — likely stale; drop it.
        try:
            rebuilt.unlink()
        except OSError:
            pass
        return False
    backup = db_path.with_suffix(db_path.suffix + ".bak")
    try:
        if backup.exists():
            backup.unlink()
        if db_path.is_file():
            _replace_sqlite_file(db_path, backup)
        _replace_sqlite_file(rebuilt, db_path)
        for suffix in ("-wal", "-shm"):
            side = Path(f"{db_path}{suffix}")
            if side.is_file():
                try:
                    side.unlink()
                except OSError:
                    pass
        if backup.is_file():
            try:
                backup.unlink()
            except OSError:
                pass
        logger.info(
            "applied pending sqlite rebuild %s -> %s (%.2f GB)",
            rebuilt.name,
            db_path.name,
            db_path.stat().st_size / (1024**3),
        )
        return True
    except Exception as exc:
        logger.warning("apply pending sqlite rebuild failed for %s: %s", db_path, exc)
        # Roll back live file if we moved it aside.
        if backup.is_file() and not db_path.is_file():
            try:
                _replace_sqlite_file(backup, db_path)
            except OSError:
                pass
        return False


def _vacuum_sqlite_rebuild_file(db_path: Path, *, label: str) -> bool:
    """``VACUUM INTO`` + replace for any SQLite file too large for in-place VACUUM."""
    if not db_path.is_file():
        return False
    before = db_path.stat().st_size
    rebuilt = db_path.with_suffix(db_path.suffix + ".rebuild")
    backup = db_path.with_suffix(db_path.suffix + ".bak")
    try:
        if rebuilt.exists():
            rebuilt.unlink()
        logger.info(
            "%s VACUUM INTO rebuild starting size=%.2f GB path=%s",
            label,
            before / (1024**3),
            db_path,
        )
        conn = sqlite3.connect(str(db_path), timeout=300.0)
        try:
            conn.execute("PRAGMA busy_timeout=300000")
            conn.execute(f"VACUUM INTO '{rebuilt.as_posix()}'")
        finally:
            conn.close()
        if not rebuilt.is_file() or rebuilt.stat().st_size <= 0:
            return False
        if backup.exists():
            try:
                backup.unlink()
            except OSError:
                pass
        try:
            _replace_sqlite_file(db_path, backup)
            try:
                _replace_sqlite_file(rebuilt, db_path)
            except OSError:
                try:
                    _replace_sqlite_file(backup, db_path)
                except OSError:
                    pass
                raise
        except OSError as exc:
            # Keep .rebuild for apply_pending_sqlite_rebuild on next free window /
            # Gateway cold start (WinError 32 while panel respawns sidecar).
            logger.warning(
                "%s VACUUM INTO wrote %s (%.2f GB) but replace failed (%s); "
                "leaving rebuild for pending apply",
                label,
                rebuilt.name,
                rebuilt.stat().st_size / (1024**3),
                exc,
            )
            return False
        for suffix in ("-wal", "-shm"):
            side = Path(f"{db_path}{suffix}")
            if side.is_file():
                try:
                    side.unlink()
                except OSError:
                    pass
        if backup.is_file():
            try:
                backup.unlink()
            except OSError:
                pass
        after = db_path.stat().st_size if db_path.is_file() else 0
        logger.info(
            "%s VACUUM INTO rebuild done %.2f GB -> %.2f GB",
            label,
            before / (1024**3),
            after / (1024**3),
        )
        return True
    except Exception as exc:
        logger.warning("%s VACUUM INTO rebuild failed: %s", label, exc)
        # Only delete rebuild when VACUUM INTO itself failed mid-way / empty.
        if rebuilt.is_file() and (not db_path.is_file() or rebuilt.stat().st_size >= before):
            try:
                rebuilt.unlink()
            except OSError:
                pass
        return False


def _vacuum_paths(paths: list[Path]) -> list[str]:
    done: list[str] = []
    for p in paths:
        if not p.is_file():
            continue
        if _skip_vacuum_due_to_size(p):
            # Multi-GB DBs: reclaim via VACUUM INTO (in-place VACUUM is gated).
            if "observability" in p.name.lower():
                ok = _vacuum_observability_rebuild(p)
            else:
                try:
                    from evoflow.persistence.db import reset_db_for_tests, resolve_evolflow_db_path

                    if p.resolve() == resolve_evolflow_db_path().resolve():
                        reset_db_for_tests()
                except Exception:
                    logger.debug("app db quiesce before rebuild failed", exc_info=True)
                ok = _vacuum_sqlite_rebuild_file(p, label=p.name)
            if ok:
                done.append(str(p))
            continue
        try:
            conn = sqlite3.connect(str(p), timeout=120.0)
            conn.execute("VACUUM")
            conn.close()
            done.append(str(p))
        except Exception as exc:
            logger.warning("VACUUM failed for %s: %s", p, exc)
    return done


def _maybe_vacuum_sqlite(
    *,
    cfg: DataRetentionConfig,
    base_dir: Path,
    deleted_total: int,
    vacuum_path_guard: Callable[[], bool] | None = None,
) -> list[str]:
    """VACUUM 收尾决策（独占锁库，大库上会堵死所有 DB 访问，见 runner 的 guard）。

    返回 vacuumed 路径列表。三种跳过：未启用 / 删除量不足 min_deleted / guard
    探测到系统繁忙（调用方让路，本轮不补——下轮 retention 再来）。
    """
    min_deleted = int(getattr(cfg, "vacuum_min_deleted_rows", 1) or 0)
    if not cfg.vacuum_sqlite or deleted_total < min_deleted:
        if cfg.vacuum_sqlite:
            logger.info(
                "data retention: skip VACUUM (deleted_total=%d < vacuum_min_deleted_rows=%d)",
                deleted_total,
                min_deleted,
            )
        return []
    if vacuum_path_guard is not None and not vacuum_path_guard():
        logger.info("data retention: skip VACUUM (vacuum_path_guard busy)")
        return []
    app_path = resolve_evolflow_db_path()
    obs_path = observability_db_path(base_dir)
    cp_path = checkpoints_db_path(base_dir)
    return _vacuum_paths([p for p in (app_path, obs_path, cp_path) if p.is_file()])


def run_data_retention(
    cfg: DataRetentionConfig,
    *,
    base_dir: Path,
    logs_dir: Path | None = None,
    vacuum_path_guard: Callable[[], bool] | None = None,
) -> RetentionRunResult:
    """Execute one retention pass (safe to call periodically).

    ``vacuum_path_guard``：返回 False 则本轮跳过 VACUUM（调用方探测系统繁忙时
    让路——VACUUM 独占锁库，大库上会把 authz/live_run_snapshot 等所有 DB 访问
    堵到它结束，事件循环连带卡死；见 2026-11-15 01:10 hang dump）。
    """
    from evoflow.config.app_config import get_app_config
    from evoflow.config.data_paths import resolve_observability_db_config_path

    result = RetentionRunResult()
    try:
        log_path = logs_dir
        if log_path is None:
            # Prefer EVOFLOW_LOGS_DIR (desktop SSOT); fall back to data_paths layout.
            from evoflow.runtime.log_policy import resolve_product_logs_dir

            log_path = resolve_product_logs_dir()
        result.logs_removed = prune_gateway_logs(log_path, days=cfg.logs_days)
        try:
            debug_removed = prune_gateway_logs(log_path / "debug", days=min(3, int(cfg.logs_days)))
            result.logs_removed += debug_removed
        except Exception:
            pass
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
                vacuum_path_guard=vacuum_path_guard,
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
        result.usage_meta_stripped = strip_usage_events_heavy_meta(
            json_limit=int(cfg.usage_meta_json_limit_bytes),
        )
        result.usage_events_deleted = prune_usage_events(days=int(cfg.usage_events_days))
    except Exception as exc:
        result.errors.append(f"app_db:usage_events: {exc}")
        logger.warning("retention: usage_events prune failed", exc_info=True)
    try:
        from evoflow.persistence.v4_event_log_repositories import prune_v4_event_log

        result.v4_event_log_deleted = int(prune_v4_event_log(int(cfg.v4_event_log_days)) or 0)
    except Exception as exc:
        result.errors.append(f"app_db:v4_event_log: {exc}")
        logger.warning("retention: v4_event_log prune failed", exc_info=True)
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
            # 4 次全表扫描改走只读池：原实现持**写锁**跑扫描，retention 期间把全部
            # 写路径挡 0.1-1s（WAL 下读不阻塞写，读池即可）。
            from evoflow.persistence.db import run_db_read

            def _read(conn):
                protected = _protected_thread_ids(conn)
                any_sessions = _all_session_thread_ids(conn)
                stale_threads = _stale_deleted_session_threads(conn, days=cfg.checkpoint_orphan_days)
                inactive_threads = _inactive_session_threads(conn, days=cfg.checkpoint_inactive_session_days)
                return protected, any_sessions, stale_threads, inactive_threads

            return run_db_read(_read)

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
                        cp_threads = {str(r[0]) for r in cp_conn.execute("SELECT DISTINCT thread_id FROM checkpoints").fetchall() if r[0]}
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
        + result.usage_events_deleted
        + result.usage_meta_stripped
        + result.v4_event_log_deleted
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
    # (observability alone may be multi-GB). Skip conditions (enabled / min-deleted /
    # busy guard) live in _maybe_vacuum_sqlite.
    try:
        result.vacuumed = _maybe_vacuum_sqlite(
            cfg=cfg,
            base_dir=base_dir,
            deleted_total=deleted_total,
            vacuum_path_guard=vacuum_path_guard,
        )
    except Exception as exc:
        result.errors.append(f"vacuum: {exc}")

    logger.info(
        "data retention: logs=%d obs=%d usage=%d usage_meta=%d v4log=%d stream=%d status=%d automation=%d msgs=%d cp_threads=%d cp_rows=%d cp_history=%d writes=%d vacuum=%s errors=%d",
        result.logs_removed,
        result.obs_rows_deleted,
        result.usage_events_deleted,
        result.usage_meta_stripped,
        result.v4_event_log_deleted,
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
