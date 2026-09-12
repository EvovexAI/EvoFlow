"""Sync checkpointer factory.

Provides a **sync singleton** and a **sync context manager** for LangGraph
graph compilation and CLI tools.

Supported backends: memory, sqlite, postgres.

Usage::

    from evoflow.agents.checkpointer.provider import get_checkpointer, checkpointer_context

    # Singleton — reused across calls, closed on process exit
    cp = get_checkpointer()

    # One-shot — fresh connection, closed on block exit
    with checkpointer_context() as cp:
        graph.invoke(input, config={"configurable": {"thread_id": "1"}})
"""

from __future__ import annotations

import contextlib
import logging
import sqlite3
import threading
from collections.abc import Iterator

from langgraph.types import Checkpointer

from evoflow.config.app_config import get_app_config
from evoflow.config.checkpointer_config import CheckpointerConfig
from evoflow.config.data_paths import resolve_checkpoints_config_path
from evoflow.persistence.data_layout import ensure_data_layout

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Error message constants — imported by aio.provider too
# ---------------------------------------------------------------------------

SQLITE_INSTALL = "langgraph-checkpoint-sqlite is required for the SQLite checkpointer. Install it with: uv add langgraph-checkpoint-sqlite"
POSTGRES_INSTALL = "langgraph-checkpoint-postgres is required for the PostgreSQL checkpointer. Install it with: uv add langgraph-checkpoint-postgres psycopg[binary] psycopg-pool"
POSTGRES_CONN_REQUIRED = "checkpointer.connection_string is required for the postgres backend"


def _wrap_omit_transcript(saver: Checkpointer) -> Checkpointer:
    from evoflow.agents.checkpointer.omit_transcript import (
        OmitTranscriptCheckpointer,
        omit_transcript_on_checkpoint_put_enabled,
    )

    if not omit_transcript_on_checkpoint_put_enabled():
        return saver
    return OmitTranscriptCheckpointer(saver)  # type: ignore[return-value]


# ---------------------------------------------------------------------------
# Sync factory
# ---------------------------------------------------------------------------


def _resolve_sqlite_conn_str(raw: str) -> str:
    """Return a SQLite connection string ready for use with ``SqliteSaver``.

    SQLite special strings (``":memory:"`` and ``file:`` URIs) are returned
    unchanged.  Relative paths resolve under ``EVOFLOW_HOME`` / ``~/.evoflow``
    without loading :func:`get_app_config` (avoids multi-second cold path).
    """

    if raw == ":memory:" or raw.startswith("file:"):
        return raw
    from evoflow.config.data_paths import resolve_data_base_dir

    base = resolve_data_base_dir()
    ensure_data_layout(base)
    return str(resolve_checkpoints_config_path(raw, base_dir=base))


def _create_sqlite_saver(config: CheckpointerConfig) -> Checkpointer:
    """Open a long-lived SQLite connection (not ``SqliteSaver.from_conn_string``'s ``closing``)."""
    try:
        from langgraph.checkpoint.sqlite import SqliteSaver
    except ImportError as exc:
        raise ImportError(SQLITE_INSTALL) from exc

    conn_str = _resolve_sqlite_conn_str(config.connection_string or "checkpoints.db")
    conn = sqlite3.connect(conn_str, check_same_thread=False)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    saver = SqliteSaver(conn)
    saver.setup()
    logger.info("Checkpointer: using SqliteSaver (%s)", conn_str)
    return saver


def _close_sqlite_saver(saver: Checkpointer) -> None:
    inner = getattr(saver, "_inner", saver)
    conn = getattr(inner, "conn", None) or getattr(saver, "conn", None)
    if conn is not None:
        try:
            conn.close()
        except Exception:
            logger.debug("checkpointer sqlite conn close failed", exc_info=True)


def _checkpointer_connection_alive(cp: Checkpointer) -> bool:
    inner = getattr(cp, "_inner", cp)
    conn = getattr(inner, "conn", None) or getattr(cp, "conn", None)
    if conn is None:
        return True
    try:
        conn.execute("SELECT 1")
        return True
    except Exception:
        return False


_init_lock = threading.Lock()


@contextlib.contextmanager
def _sync_checkpointer_cm(config: CheckpointerConfig) -> Iterator[Checkpointer]:
    """Context manager that creates and tears down a sync checkpointer.

    Returns a configured ``Checkpointer`` instance. Resource cleanup for any
    underlying connections or pools is handled by higher-level helpers in
    this module (such as the singleton factory or context manager); this
    function does not return a separate cleanup callback.
    """
    if config.type == "memory":
        from langgraph.checkpoint.memory import InMemorySaver

        logger.info("Checkpointer: using InMemorySaver (in-process, not persistent)")
        yield _wrap_omit_transcript(InMemorySaver())
        return

    if config.type == "sqlite":
        saver = _create_sqlite_saver(config)
        try:
            yield _wrap_omit_transcript(saver)
        finally:
            _close_sqlite_saver(saver)
        return

    if config.type == "postgres":
        try:
            from langgraph.checkpoint.postgres import PostgresSaver
        except ImportError as exc:
            raise ImportError(POSTGRES_INSTALL) from exc

        if not config.connection_string:
            raise ValueError(POSTGRES_CONN_REQUIRED)

        with PostgresSaver.from_conn_string(config.connection_string) as saver:
            saver.setup()
            logger.info("Checkpointer: using PostgresSaver")
            yield _wrap_omit_transcript(saver)
        return

    raise ValueError(f"Unknown checkpointer type: {config.type!r}")


# ---------------------------------------------------------------------------
# Sync singleton
# ---------------------------------------------------------------------------

_checkpointer: Checkpointer | None = None
_checkpointer_ctx = None  # open context manager keeping the connection alive


def get_checkpointer() -> Checkpointer:
    """Return the global sync checkpointer singleton, creating it on first call.

    Returns an ``InMemorySaver`` when no checkpointer is configured in *config.yaml*.

    Raises:
        ImportError: If the required package for the configured backend is not installed.
        ValueError: If ``connection_string`` is missing for a backend that requires it.
    """
    global _checkpointer, _checkpointer_ctx

    with _init_lock:
        if _checkpointer is not None and _checkpointer_connection_alive(_checkpointer):
            return _checkpointer
        if _checkpointer is not None:
            logger.warning("Checkpointer singleton had a closed connection; recreating")
            reset_checkpointer()

        # Ensure app config is loaded before checking checkpointer config
        from evoflow.config.app_config import _app_config
        from evoflow.config.checkpointer_config import get_checkpointer_config

        config = get_checkpointer_config()

        if config is None and _app_config is None:
            try:
                get_app_config()
            except FileNotFoundError:
                pass
            config = get_checkpointer_config()
        if config is None:
            from langgraph.checkpoint.memory import InMemorySaver

            logger.info("Checkpointer: using InMemorySaver (in-process, not persistent)")
            _checkpointer = _wrap_omit_transcript(InMemorySaver())
            return _checkpointer

        if config.type == "sqlite":
            _checkpointer = _wrap_omit_transcript(_create_sqlite_saver(config))
            _checkpointer_ctx = None
            return _checkpointer

        _checkpointer_ctx = _sync_checkpointer_cm(config)
        _checkpointer = _checkpointer_ctx.__enter__()
        return _checkpointer


def reset_checkpointer() -> None:
    """Reset the sync singleton, forcing recreation on the next call.

    Closes any open backend connections and clears the cached instance.
    Useful in tests or after a configuration change.
    """
    global _checkpointer, _checkpointer_ctx
    with _init_lock:
        if _checkpointer is not None:
            _close_sqlite_saver(_checkpointer)
        if _checkpointer_ctx is not None:
            try:
                _checkpointer_ctx.__exit__(None, None, None)
            except Exception:
                logger.warning("Error during checkpointer cleanup", exc_info=True)
            _checkpointer_ctx = None
        _checkpointer = None


# ---------------------------------------------------------------------------
# Sync context manager
# ---------------------------------------------------------------------------


@contextlib.contextmanager
def checkpointer_context() -> Iterator[Checkpointer]:
    """Sync context manager that yields a checkpointer and cleans up on exit.

    Unlike :func:`get_checkpointer`, this does **not** cache the instance —
    each ``with`` block creates and destroys its own connection.  Use it in
    CLI scripts or tests where you want deterministic cleanup::

        with checkpointer_context() as cp:
            graph.invoke(input, config={"configurable": {"thread_id": "1"}})

    Yields an ``InMemorySaver`` when no checkpointer is configured in *config.yaml*.
    """

    config = get_app_config()
    if config.checkpointer is None:
        from langgraph.checkpoint.memory import InMemorySaver

        yield _wrap_omit_transcript(InMemorySaver())
        return

    with _sync_checkpointer_cm(config.checkpointer) as saver:
        yield saver
