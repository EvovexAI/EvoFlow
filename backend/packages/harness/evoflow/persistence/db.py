"""Shared SQLite access for ``evoflow.db`` (WAL, schema init).

Uses one process-wide connection (``check_same_thread=False``) and an
``RLock`` on every statement so FastAPI / ``asyncio.to_thread`` workers
never open concurrent writers on separate connections (the usual cause of
``database is locked`` here).

Multi-statement batches (loop + single ``commit``) must run inside
``db_connection_lock()`` or ``run_db_with_retry`` / ``run_db_transaction``.
"""

from __future__ import annotations

import logging
import os
import queue as _queue
import sqlite3
import threading
import time
from collections.abc import Callable
from contextlib import contextmanager as _contextmanager
from pathlib import Path
from typing import Any, TypeVar

from evoflow.config.data_paths import DEFAULT_APP_DB_REL, resolve_app_db_config_path
from evoflow.persistence.data_layout import ensure_data_layout
from evoflow.persistence.schema import ensure_app_schema

logger = logging.getLogger(__name__)

_lock = threading.RLock()
_txn_local = threading.local()
_cached_default_path: Path | None = None
_shared_conn: sqlite3.Connection | None = None
_shared_conn_path: Path | None = None
_shared_wrapper: Any = None

_DEFAULT_BUSY_TIMEOUT_MS = max(1000, int(os.getenv("EVOFLOW_SQLITE_BUSY_TIMEOUT_MS", "10000") or "10000"))
_DEFAULT_CONNECT_TIMEOUT_S = max(1.0, float(os.getenv("EVOFLOW_SQLITE_CONNECT_TIMEOUT_S", "5") or "5"))
_DEFAULT_MAX_ATTEMPTS = max(1, int(os.getenv("EVOFLOW_SQLITE_MAX_ATTEMPTS", "8") or "8"))

T = TypeVar("T")


class _LockedConnection:
    """Proxy that serializes all access to the shared SQLite connection."""

    __slots__ = ("_conn",)

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn

    @property
    def row_factory(self) -> Any:
        with _lock:
            return self._conn.row_factory

    @row_factory.setter
    def row_factory(self, value: Any) -> None:
        with _lock:
            self._conn.row_factory = value

    def execute(self, sql: str, parameters: Any = (), /) -> sqlite3.Cursor:
        with _lock:
            return self._conn.execute(sql, parameters)

    def executemany(self, sql: str, parameters: Any) -> sqlite3.Cursor:
        with _lock:
            return self._conn.executemany(sql, parameters)

    def executescript(self, sql_script: str) -> sqlite3.Cursor:
        with _lock:
            return self._conn.executescript(sql_script)

    def commit(self) -> None:
        with _lock:
            self._conn.commit()

    def rollback(self) -> None:
        with _lock:
            self._conn.rollback()

    @property
    def in_transaction(self) -> bool:
        with _lock:
            return bool(self._conn.in_transaction)

    def close(self) -> None:
        with _lock:
            self._conn.close()


def _configure_sqlite_connection(conn: sqlite3.Connection) -> None:
    conn.execute(f"PRAGMA busy_timeout={_DEFAULT_BUSY_TIMEOUT_MS}")
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA temp_store=MEMORY")
    conn.execute("PRAGMA cache_size=-64000")
    # Memory-map the DB file for faster reads (especially on Windows where
    # file I/O is slower). 256MB cap — small DBs benefit fully, large DBs
    # still get partial mapping. Ignored silently if the OS rejects it.
    try:
        conn.execute("PRAGMA mmap_size=268435456")
    except Exception:
        pass
    # Load the sqlite-vec extension so the ``vec0`` virtual table (knowledge
    # base vector store) is available on the shared connection. Best-effort:
    # if the extension is unavailable the core app still works; only KB vector
    # features will raise at use time.
    _load_sqlite_vec_extension(conn)


def _load_sqlite_vec_extension(conn: sqlite3.Connection) -> None:
    """Best-effort load of the ``sqlite-vec`` extension into ``conn``.

    Uses ``sqlite_vec.loadable_path()`` (the pip ``sqlite-vec`` package ships a
    prebuilt loadable for the current platform). Silently logs and continues on
    failure so schema migration / app boot never hard-blocks on a missing
    optional extension. The KB vector store surfaces a clear error when it is
    actually used without the extension.
    """
    try:
        import sqlite_vec

        conn.enable_load_extension(True)
        conn.load_extension(sqlite_vec.loadable_path())
    except Exception as exc:  # noqa: BLE001 - optional, must never block boot
        logger.warning("sqlite-vec extension not loaded: %s", exc)


def _base_dir_for_db() -> Path:
    from evoflow.config.data_paths import resolve_data_base_dir

    return resolve_data_base_dir()


def _resolve_sqlite_file_path(raw: str) -> Path:
    """Resolve a sqlite file path without loading ``AppConfig`` when possible."""
    name = str(raw or "").strip() or DEFAULT_APP_DB_REL
    base = _base_dir_for_db()
    p = Path(name)
    if p.is_absolute():
        return p.resolve()
    ensure_data_layout(base)
    return resolve_app_db_config_path(name, base_dir=base)


def _default_db_path_under_base() -> Path:
    base = _base_dir_for_db()
    ensure_data_layout(base)
    return resolve_app_db_config_path(DEFAULT_APP_DB_REL, base_dir=base)


def resolve_evolflow_db_path(*, storage_sqlite_path: str | None = None) -> Path:
    """Resolve application DB path (``storage.sqlite_path`` or ``evoflow.db``)."""
    global _cached_default_path

    env_db = str(os.getenv("EVOFLOW_DB_PATH") or "").strip()
    if env_db:
        path = Path(env_db).expanduser().resolve()
        _cached_default_path = path
        return path

    if storage_sqlite_path is not None:
        return _resolve_sqlite_file_path(storage_sqlite_path)

    if _cached_default_path is not None:
        return _cached_default_path

    # Avoid re-entering AppConfig while it is loading (``get_db`` during ``from_file``).
    try:
        from evoflow.config.app_config import _app_config_loading

        if _app_config_loading:
            path = _default_db_path_under_base()
            _cached_default_path = path
            return path
    except Exception:
        pass

    # Tests and explicit ``EVOFLOW_HOME`` should not open the host config.yaml DB.
    if os.getenv("EVOFLOW_HOME"):
        path = _default_db_path_under_base()
        _cached_default_path = path
        return path

    try:
        from evoflow.config.app_config import get_app_config

        cfg = get_app_config()
        raw = ""
        storage = getattr(cfg, "storage", None)
        if storage is not None:
            raw = str(getattr(storage, "sqlite_path", "") or "").strip()
        if not raw:
            raw = "evoflow.db"
        path = _resolve_sqlite_file_path(raw)
    except Exception:
        path = _default_db_path_under_base()
    _cached_default_path = path
    return path


def db_connection_lock() -> threading.RLock:
    """Hold for multi-step transactions that must not interleave on the shared connection."""
    return _lock


def _is_sqlite_busy_error(exc: BaseException) -> bool:
    msg = str(exc).lower()
    return "locked" in msg or "busy" in msg


def _txn_depth() -> int:
    return int(getattr(_txn_local, "depth", 0) or 0)


def _set_txn_depth(depth: int) -> None:
    _txn_local.depth = max(0, int(depth))


def _raw_connection() -> sqlite3.Connection | None:
    return _shared_conn


def run_db_transaction[T](
    fn: Callable[[Any], T],
    *,
    max_attempts: int | None = None,
) -> T:
    """Commit a write batch; nested calls use SAVEPOINT instead of a second BEGIN."""
    attempts = _DEFAULT_MAX_ATTEMPTS if max_attempts is None else max_attempts

    def _do() -> T:
        db = get_db()
        depth = _txn_depth()
        if depth <= 0:
            if db.in_transaction:
                logger.warning("sqlite: rolling back orphaned transaction before BEGIN IMMEDIATE")
                db.rollback()
            try:
                db.execute("BEGIN IMMEDIATE")
                _set_txn_depth(1)
                out = fn(db)
                db.commit()
                return out
            except Exception:
                try:
                    db.rollback()
                except Exception:
                    logger.debug("sqlite rollback failed", exc_info=True)
                raise
            finally:
                _set_txn_depth(0)
        sp = f"evoflow_sp_{depth}"
        db.execute(f"SAVEPOINT {sp}")
        _set_txn_depth(depth + 1)
        try:
            out = fn(db)
            db.execute(f"RELEASE SAVEPOINT {sp}")
            return out
        except Exception:
            try:
                db.execute(f"ROLLBACK TO SAVEPOINT {sp}")
                db.execute(f"RELEASE SAVEPOINT {sp}")
            except Exception:
                try:
                    db.rollback()
                except Exception:
                    logger.debug("sqlite savepoint rollback failed", exc_info=True)
            raise
        finally:
            _set_txn_depth(depth)

    return run_db_with_retry(_do, max_attempts=attempts)


def _check_windows_stale_lock(path: Path) -> None:
    """Detect stale ``-wal``/``-shm`` files that block a new process on Windows.

    On Windows, if a previous EvoFlow process crashed or was killed, the
    ``-wal``/``-shm`` sidecar files may remain locked by the OS. A new process
    trying to open the same database gets a generic ``OperationalError`` (e.g.
    "unable to open database file"). This function inspects the sidecar files
    and raises a more actionable error so the user knows to stop the stale
    process or remove the lock.

    Non-Windows platforms are skipped (POSIX uses advisory byte-range locks
    that are released on process exit).
    """
    if os.name != "nt":
        return
    wal_path = Path(str(path) + "-wal")
    shm_path = Path(str(path) + "-shm")
    stale: list[str] = []
    for sidecar in (wal_path, shm_path):
        if sidecar.is_file():
            # Try to open the sidecar exclusively; if it fails, another process holds it.
            try:
                with open(sidecar, "a"):
                    pass
            except (PermissionError, OSError) as exc:
                stale.append(f"{sidecar.name} (locked: {exc})")
    if stale:
        hint = (
            "A previous EvoFlow process may still be running and holding a lock "
            "on the SQLite sidecar files. Please stop any lingering evoflow/gateway "
            "processes (e.g. via Task Manager) and restart. If no process is "
            "running, manually delete the stale -wal/-shm files listed above."
        )
        raise sqlite3.OperationalError(
            f"SQLite sidecar files are locked by another process: {', '.join(stale)}. {hint}"
        )


def _restrict_db_file_permissions(path: Path) -> None:
    """Restrict DB file to owner-only access (chmod 600 on POSIX).

    On Windows, SQLite files inherit NTFS ACLs from the parent directory.
    The ``~/.evoflow`` directory is created with default user permissions,
    which already limits access to the current user. No explicit action needed.
    """
    if os.name == "nt":
        return
    try:
        os.chmod(str(path), 0o600)
        # Also restrict WAL/SHM sidecar files if they exist
        for suffix in ("-wal", "-shm"):
            sidecar = Path(str(path) + suffix)
            if sidecar.exists():
                os.chmod(str(sidecar), 0o600)
    except OSError:
        logger.debug("Failed to restrict DB file permissions for %s", path, exc_info=True)


def _open_shared_connection(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        conn = sqlite3.connect(str(path), check_same_thread=False, timeout=_DEFAULT_CONNECT_TIMEOUT_S)
    except sqlite3.OperationalError:
        # On Windows, a stale -wal/-shm lock produces a generic "unable to open"
        # error. Probe for sidecar locks and raise a clearer message.
        _check_windows_stale_lock(path)
        raise
    conn.row_factory = sqlite3.Row
    _configure_sqlite_connection(conn)
    ensure_app_schema(conn)
    _restrict_db_file_permissions(path)
    return conn


def run_db_with_retry[T](fn: Callable[[], T], *, max_attempts: int | None = None) -> T:
    """Run a DB closure with process lock + sqlite busy retry."""
    attempts = _DEFAULT_MAX_ATTEMPTS if max_attempts is None else max_attempts
    last: BaseException | None = None
    for attempt in range(max(1, int(attempts))):
        try:
            with db_connection_lock():
                return fn()
        except sqlite3.OperationalError as e:
            last = e
            if not _is_sqlite_busy_error(e) or attempt >= attempts - 1:
                raise
            delay = min(0.05 * (2**attempt), 2.5)
            logger.debug(
                "sqlite busy/locked (attempt %s/%s), retry in %.2fs: %s",
                attempt + 1,
                attempts,
                delay,
                e,
            )
            time.sleep(delay)
    if last:
        raise last
    raise RuntimeError("run_db_with_retry failed without exception")


_READ_POOL_SIZE = max(2, int(os.getenv("EVOFLOW_SQLITE_READ_POOL_SIZE", "4") or "4"))
_read_pool: _queue.Queue[sqlite3.Connection] | None = None
_read_pool_lock = threading.Lock()


def _create_read_connection(path: Path) -> sqlite3.Connection:
    """只读连接：mode=ro，独立于写连接，WAL 下读不阻塞写。"""
    uri = f"file:{path}?mode=ro"
    conn = sqlite3.connect(uri, uri=True, check_same_thread=False, timeout=5.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA query_only=1")  # 硬性只读
    return conn


def _get_read_pool(path: Path) -> _queue.Queue[sqlite3.Connection]:
    global _read_pool
    with _read_pool_lock:
        if _read_pool is None:
            pool: _queue.Queue[sqlite3.Connection] = _queue.Queue(maxsize=_READ_POOL_SIZE)
            for _ in range(_READ_POOL_SIZE):
                pool.put(_create_read_connection(path))
            _read_pool = pool
        return _read_pool


@_contextmanager
def get_read_connection():
    """获取一个只读连接（从池中借出，用完归还）。

    WAL 模式下读操作不会阻塞写连接上的事务，也不被写事务阻塞。

    用法::

        with get_read_connection() as db:
            rows = db.execute("SELECT ...").fetchall()
    """
    path = resolve_evolflow_db_path()
    pool = _get_read_pool(path)
    conn = pool.get()  # 阻塞等待空闲连接
    try:
        yield conn
    finally:
        pool.put(conn)  # 归还


def run_db_read[T](fn: Callable[[sqlite3.Connection], T]) -> T:
    """执行只读查询，使用独立读连接池，不竞争写锁。

    WAL 模式下读操作不会被写事务阻塞。如果偶发 busy（WAL checkpoint），
    简单重试一次即可。
    """
    with get_read_connection() as db:
        try:
            return fn(db)
        except sqlite3.OperationalError as e:
            if _is_sqlite_busy_error(e):
                time.sleep(0.05)
                return fn(db)
            raise


def shutdown_read_pool() -> None:
    """关闭只读连接池（进程退出时调用）。"""
    global _read_pool
    with _read_pool_lock:
        if _read_pool is None:
            return
        while not _read_pool.empty():
            try:
                conn = _read_pool.get_nowait()
                conn.close()
            except Exception:
                pass
        _read_pool = None


def get_db(*, storage_sqlite_path: str | None = None) -> _LockedConnection:
    """Shared locked connection; safe under FastAPI thread pool + background tasks."""
    global _shared_conn, _shared_conn_path, _shared_wrapper
    path = resolve_evolflow_db_path(storage_sqlite_path=storage_sqlite_path)
    with _lock:
        if _shared_conn is not None and _shared_conn_path == path and _shared_wrapper is not None:
            return _shared_wrapper
        if _shared_conn is not None:
            try:
                _shared_conn.close()
            except Exception:
                logger.debug("close previous shared evoflow db failed", exc_info=True)
        _shared_conn = _open_shared_connection(path)
        _shared_conn_path = path
        _shared_wrapper = _LockedConnection(_shared_conn)
        return _shared_wrapper


def reset_db_for_tests() -> None:
    """Close shared connection (tests only)."""
    global _cached_default_path, _shared_conn, _shared_conn_path, _shared_wrapper
    with _lock:
        if _shared_conn is not None:
            try:
                _shared_conn.close()
            except Exception:
                pass
        _shared_conn = None
        _shared_conn_path = None
        _shared_wrapper = None
        _cached_default_path = None
        _set_txn_depth(0)
    try:
        from evoflow.persistence.session_repositories import invalidate_session_select_cache

        invalidate_session_select_cache()
    except Exception:
        pass


def app_schema_version(conn: Any | None = None) -> int:
    c = conn or get_db()
    row = c.execute("PRAGMA user_version").fetchone()
    return int(row[0]) if row else 0


def set_app_schema_version(version: int, conn: Any | None = None) -> None:
    c = conn or get_db()
    c.execute(f"PRAGMA user_version = {int(version)}")
    c.commit()


# ---------------------------------------------------------------------------
# Startup preflight: integrity_check + WAL checkpoint repair
# ---------------------------------------------------------------------------

def _startup_preflight_mode() -> str:
    """``fast`` (default): quick_check on boot; ``full``: legacy blocking check; ``skip``: none."""
    raw = (os.getenv("EVOFLOW_STARTUP_DB_PREFLIGHT") or "fast").strip().lower()
    if raw in ("full", "legacy", "1", "true", "yes", "on"):
        return "full"
    if raw in ("skip", "0", "false", "no", "off", "none"):
        return "skip"
    return "fast"


def _integrity_check(conn: sqlite3.Connection) -> str:
    """Return ``'ok'`` if the database passes integrity check, else the error text."""
    rows = conn.execute("PRAGMA integrity_check").fetchall()
    if not rows:
        return "no result"
    first = str(rows[0][0] if not isinstance(rows[0], sqlite3.Row) else rows[0][0])
    if first == "ok":
        return "ok"
    # integrity_check can return multiple rows; join them for logging.
    parts = [str(r[0]) for r in rows]
    return "; ".join(parts)


def _quick_check(conn: sqlite3.Connection) -> str:
    """O(N) structural check — suitable for startup (SQLite docs recommend vs full integrity_check)."""
    rows = conn.execute("PRAGMA quick_check").fetchall()
    if not rows:
        return "no result"
    first = str(rows[0][0] if not isinstance(rows[0], sqlite3.Row) else rows[0][0])
    if first == "ok":
        return "ok"
    parts = [str(r[0]) for r in rows]
    return "; ".join(parts)


def _wal_checkpoint_truncate(conn: sqlite3.Connection) -> tuple[int, int, int]:
    """Run ``PRAGMA wal_checkpoint(TRUNCATE)`` and return ``(busy, log, checkpointed)``."""
    row = conn.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
    if row is None:
        return (-1, -1, -1)
    return (int(row[0]), int(row[1]), int(row[2]))


def _wal_checkpoint_passive(conn: sqlite3.Connection) -> tuple[int, int, int]:
    """Non-blocking WAL checkpoint — safe during startup hot path."""
    row = conn.execute("PRAGMA wal_checkpoint(PASSIVE)").fetchone()
    if row is None:
        return (-1, -1, -1)
    return (int(row[0]), int(row[1]), int(row[2]))


def _db_size_mb(path: Path) -> float:
    try:
        return path.stat().st_size / (1024 * 1024)
    except OSError:
        return 0.0


def _skip_observability_startup_preflight() -> bool:
    raw = (os.getenv("EVOFLOW_STARTUP_SKIP_OBS_PREFLIGHT") or "1").strip().lower()
    return raw not in ("0", "false", "no", "off")


def preflight_database_startup(path: Path, *, label: str = "") -> bool:
    """Fast boot path: ``quick_check`` + passive WAL checkpoint (never blocks on multi-GB integrity_check).

    Full ``integrity_check`` + TRUNCATE repair runs in background via
    :func:`schedule_deferred_full_preflight` after ``ready to serve``.
    """
    tag = label or path.name
    mode = _startup_preflight_mode()
    if mode == "skip":
        logger.debug("preflight startup: %s skipped (EVOFLOW_STARTUP_DB_PREFLIGHT=skip)", tag)
        return True
    if _skip_observability_startup_preflight() and (
        "observability" in tag.lower() or "observability" in str(path).lower()
    ):
        logger.info(
            "preflight startup: %s skipped (telemetry DB; full check deferred post-ready)",
            tag,
        )
        return True
    if mode == "full":
        return preflight_database(path, label=label)

    if not path.is_file():
        logger.debug("preflight startup: %s skipped (file does not exist)", tag)
        return True

    size_mb = _db_size_mb(path)
    conn: sqlite3.Connection | None = None
    try:
        conn = sqlite3.connect(str(path), timeout=10.0)
        conn.execute("PRAGMA busy_timeout=3000")
        try:
            conn.execute("PRAGMA journal_mode=WAL")
        except sqlite3.OperationalError:
            pass

        result = _quick_check(conn)
        if result != "ok":
            logger.warning(
                "preflight startup: %s quick_check FAILED: %s (full check scheduled in background)",
                tag,
                result[:500],
            )
            return False

        try:
            busy, log_frames, ckpt_frames = _wal_checkpoint_passive(conn)
            logger.info(
                "preflight startup: %s quick_check=ok size=%.1fMB wal_checkpoint(PASSIVE) busy=%s log=%s ckpt=%s",
                tag,
                size_mb,
                busy,
                log_frames,
                ckpt_frames,
            )
        except sqlite3.OperationalError as exc:
            logger.debug("preflight startup: %s passive WAL checkpoint failed: %s", tag, exc)
            logger.info("preflight startup: %s quick_check=ok size=%.1fMB", tag, size_mb)
        return True
    except Exception as exc:
        logger.error("preflight startup: %s unexpected error: %s", tag, exc, exc_info=True)
        return False
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass


def preflight_database(path: Path, *, label: str = "") -> bool:
    """Run a lightweight integrity check + WAL checkpoint repair on a database file.

    Called at startup (after schema init) for each of the 3 SQLite databases.
    If ``integrity_check`` is not ``ok``:
      - log a warning with the error text
      - attempt ``PRAGMA wal_checkpoint(TRUNCATE)`` to flush/repair WAL state
      - re-check; if still not ok, log an error but do NOT raise (degraded run)

    Returns ``True`` if the database is healthy, ``False`` if degraded.
    """
    tag = label or path.name
    if not path.is_file():
        logger.debug("preflight: %s skipped (file does not exist)", tag)
        return True

    conn: sqlite3.Connection | None = None
    try:
        conn = sqlite3.connect(str(path), timeout=30.0)
        conn.execute("PRAGMA busy_timeout=5000")
        # Ensure WAL mode so wal_checkpoint is meaningful.
        try:
            conn.execute("PRAGMA journal_mode=WAL")
        except sqlite3.OperationalError:
            pass

        result = _integrity_check(conn)
        if result == "ok":
            # Even when healthy, run a TRUNCATE checkpoint to reclaim WAL space
            # accumulated from a previous run that never checkpointed.
            try:
                _wal_checkpoint_truncate(conn)
            except sqlite3.OperationalError as exc:
                logger.debug("preflight: %s WAL checkpoint (healthy) failed: %s", tag, exc)
            logger.info("preflight: %s integrity_check=ok", tag)
            return True

        # Integrity check failed — log warning and attempt WAL checkpoint repair.
        logger.warning("preflight: %s integrity_check FAILED: %s", tag, result[:500])
        try:
            busy, log_frames, ckpt_frames = _wal_checkpoint_truncate(conn)
            logger.info(
                "preflight: %s attempted wal_checkpoint(TRUNCATE): busy=%s log=%s checkpointed=%s",
                tag, busy, log_frames, ckpt_frames,
            )
        except sqlite3.OperationalError as exc:
            logger.warning("preflight: %s wal_checkpoint(TRUNCATE) failed: %s", tag, exc)

        # Re-check after repair attempt.
        result2 = _integrity_check(conn)
        if result2 == "ok":
            logger.info("preflight: %s integrity_check=ok AFTER wal_checkpoint repair", tag)
            return True

        # Still broken — log error but do not raise (degraded run).
        logger.error(
            "preflight: %s integrity_check STILL FAILED after repair: %s — "
            "running in degraded mode; database may be corrupt",
            tag, result2[:500],
        )
        return False
    except Exception as exc:
        logger.error("preflight: %s unexpected error: %s — degraded mode", tag, exc, exc_info=True)
        return False
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass


def run_deferred_full_preflight(*, base_dir: Path | None = None) -> dict[str, bool]:
    """Background full ``integrity_check`` + TRUNCATE WAL (post ``ready to serve``)."""
    from evoflow.config.data_paths import (
        checkpoints_db_path,
        observability_db_path,
        resolve_data_base_dir,
    )

    base = base_dir or resolve_data_base_dir()
    paths: list[tuple[str, Path]] = []
    try:
        paths.append(("evoflow.db", resolve_evolflow_db_path()))
    except Exception:
        pass
    try:
        from evoflow.debug.trace_sink import observability_enabled as _obs_on

        if _obs_on():
            paths.append(("observability.db", observability_db_path(base)))
    except Exception:
        pass
    try:
        paths.append(("checkpoints.db", checkpoints_db_path(base)))
    except Exception:
        pass

    results: dict[str, bool] = {}
    for label, db_path in paths:
        try:
            ok = preflight_database(db_path, label=label)
            results[label] = ok
        except Exception:
            logger.exception("deferred full preflight failed: %s", label)
            results[label] = False
    return results


def checkpoint_all_databases() -> dict[str, dict[str, int]]:
    """Run ``PRAGMA wal_checkpoint(TRUNCATE)`` on all 3 SQLite databases.

    Called periodically (~hourly) by the data retention scheduler to prevent
    WAL files from growing unbounded. Returns a summary dict per database.
    """
    from evoflow.config.data_paths import (
        checkpoints_db_path,
        observability_db_path,
        resolve_data_base_dir,
    )

    base = resolve_data_base_dir()
    paths: dict[str, Path] = {}
    try:
        paths["evoflow"] = resolve_evolflow_db_path()
    except Exception:
        pass
    try:
        paths["observability"] = observability_db_path(base)
    except Exception:
        pass
    try:
        paths["checkpoints"] = checkpoints_db_path(base)
    except Exception:
        pass

    summary: dict[str, dict[str, int]] = {}
    for label, path in paths.items():
        if not path.is_file():
            continue
        conn: sqlite3.Connection | None = None
        try:
            conn = sqlite3.connect(str(path), timeout=30.0)
            conn.execute("PRAGMA busy_timeout=5000")
            busy, log_frames, ckpt_frames = _wal_checkpoint_truncate(conn)
            summary[label] = {"busy": busy, "log": log_frames, "checkpointed": ckpt_frames}
            logger.debug(
                "wal_checkpoint %s: busy=%s log=%s checkpointed=%s",
                label, busy, log_frames, ckpt_frames,
            )
        except Exception as exc:
            summary[label] = {"busy": -1, "log": -1, "checkpointed": -1, "error": 1}
            logger.warning("wal_checkpoint %s failed: %s", label, exc)
        finally:
            if conn is not None:
                try:
                    conn.close()
                except Exception:
                    pass
    return summary
