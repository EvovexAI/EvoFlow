"""DB connection helpers for owned.sqlite."""

from __future__ import annotations

import sqlite3
import threading
from collections.abc import Iterator
from contextlib import contextmanager

from evoflow.knowledge.owned.paths import owned_db_path
from evoflow.knowledge.owned.schema import SCHEMA_VERSION, ensure_schema

_lock = threading.RLock()
_conn: sqlite3.Connection | None = None
_schema_version_applied: str | None = None


def _connect() -> sqlite3.Connection:
    path = owned_db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path), check_same_thread=False, timeout=30.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=5000")
    return conn


def _ensure_conn() -> sqlite3.Connection:
    """Process-wide connection; schema DDL runs once per SCHEMA_VERSION."""
    global _conn, _schema_version_applied
    if _conn is None:
        _conn = _connect()
    if _schema_version_applied != SCHEMA_VERSION:
        ensure_schema(_conn)
        _schema_version_applied = SCHEMA_VERSION
    return _conn


@contextmanager
def db() -> Iterator[sqlite3.Connection]:
    """Shared owned.sqlite connection (serialized via lock).

    Idle claim polls used to open + ``ensure_schema`` (full DDL) + ``commit`` +
    close every 0.75s. That is the dominant idle disk IO source for Gateway.
    """
    with _lock:
        conn = _ensure_conn()
        try:
            yield conn
            # Skip empty commits (pure SELECT / no-op) — avoids WAL write storms.
            if conn.in_transaction:
                conn.commit()
        except Exception:
            try:
                if conn.in_transaction:
                    conn.rollback()
            except Exception:
                pass
            raise


def reset_db_state_for_tests() -> None:
    """Test helper: close shared connection and force schema re-init on next use."""
    global _conn, _schema_version_applied
    with _lock:
        if _conn is not None:
            try:
                _conn.close()
            except Exception:
                pass
            _conn = None
        _schema_version_applied = None
