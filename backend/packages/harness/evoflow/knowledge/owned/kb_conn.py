"""Per-KB SQLite connection routing.

The central ``owned.sqlite`` (see :mod:`evoflow.knowledge.owned.db`) keeps only
what is not owned by a single knowledge base: the ``kb_bases`` registry, the job
queue, the activity log, and agent memory.

Everything else — documents, chunks, embeddings, FTS, assets, wiki, KB-scoped
knowledge graph — lives in ``<kb_dir>/.evoflow/kb/index.db`` and is reached
through :func:`db_for_kb`.

Connections are cached per resolved DB path with an LRU cap so that a machine
with many KBs does not hold one file descriptor per base forever.
"""

from __future__ import annotations

import logging
import sqlite3
import threading
from collections import OrderedDict
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from evoflow.knowledge.owned import store_paths
from evoflow.knowledge.owned.schema import ensure_kb_schema

logger = logging.getLogger(__name__)

# Idle KBs should not pin file descriptors; 16 covers typical working sets.
_MAX_CACHED_CONNS = 16

_lock = threading.RLock()
_conns: OrderedDict[str, sqlite3.Connection] = OrderedDict()
_schema_applied: set[str] = set()


def _connect(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path), check_same_thread=False, timeout=30.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=5000")
    return conn


def _evict_if_needed() -> None:
    """Close least-recently-used connections beyond the cache cap."""
    while len(_conns) > _MAX_CACHED_CONNS:
        _path, conn = _conns.popitem(last=False)
        try:
            conn.close()
        except Exception:
            logger.debug("kb conn close failed for %s", _path, exc_info=True)


def _ensure_conn(db_path: Path) -> sqlite3.Connection:
    key = str(db_path)
    conn = _conns.get(key)
    if conn is None:
        conn = _connect(db_path)
        _conns[key] = conn
    else:
        _conns.move_to_end(key)
    if key not in _schema_applied:
        ensure_kb_schema(conn)
        _schema_applied.add(key)
    _evict_if_needed()
    return conn


@contextmanager
def db_for_dir(kb_dir: str | Path) -> Iterator[sqlite3.Connection]:
    """Yield a connection to ``<kb_dir>/.evoflow/kb/index.db`` (schema ensured)."""
    store_paths.ensure_kb_layout(kb_dir)
    db_path = store_paths.index_db_path(kb_dir)
    with _lock:
        conn = _ensure_conn(db_path)
        try:
            yield conn
            if conn.in_transaction:
                conn.commit()
        except Exception:
            try:
                if conn.in_transaction:
                    conn.rollback()
            except Exception:
                pass
            raise


def db_for_kb(kb_id: str) -> Iterator[sqlite3.Connection]:
    """Context manager yielding the connection for *kb_id*'s own index DB.

    Resolves ``storage_dir`` from the central registry so callers never need to
    know where a KB physically lives.
    """
    return db_for_dir(kb_dir_for_kb(kb_id))


def kb_dir_for_kb(kb_id: str) -> Path:
    """Resolve a KB's directory using the central registry (cached lookup)."""
    kid = str(kb_id or "").strip()
    if not kid:
        raise ValueError("kb_id is required")
    storage_dir = _lookup_storage_dir(kid)
    return store_paths.resolve_kb_dir(kid, storage_dir=storage_dir)


def _lookup_storage_dir(kb_id: str) -> str | None:
    """Read ``kb_bases.storage_dir`` from the central DB (tolerates old schemas)."""
    try:
        from evoflow.knowledge.owned.db import db as central_db

        with central_db() as conn:
            cols = {str(r[1]) for r in conn.execute("PRAGMA table_info(kb_bases)").fetchall()}
            if "storage_dir" not in cols:
                return None
            row = conn.execute(
                "SELECT storage_dir FROM kb_bases WHERE id=?",
                (kb_id,),
            ).fetchone()
        if not row:
            return None
        return str(row[0] or "").strip() or None
    except Exception:
        logger.debug("storage_dir lookup failed for kb=%s", kb_id, exc_info=True)
        return None


def close_all() -> None:
    """Close every cached KB connection (shutdown / tests)."""
    with _lock:
        for conn in _conns.values():
            try:
                conn.close()
            except Exception:
                pass
        _conns.clear()
        _schema_applied.clear()


def reset_for_tests() -> None:
    close_all()
