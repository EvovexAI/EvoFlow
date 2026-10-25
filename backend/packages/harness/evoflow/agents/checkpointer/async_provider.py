"""Async checkpointer factory.

Provides an **async context manager** for long-running async servers that need
proper resource cleanup.

Supported backends: memory, sqlite, postgres.

Usage (e.g. FastAPI lifespan)::

    from evoflow.agents.checkpointer.async_provider import make_checkpointer

    async with make_checkpointer() as checkpointer:
        app.state.checkpointer = checkpointer  # InMemorySaver if not configured

For sync usage see :mod:`evoflow.agents.checkpointer.provider`.
"""

from __future__ import annotations

import contextlib
import logging
import os
from collections.abc import AsyncIterator
from typing import Any

from langgraph.types import Checkpointer

from evoflow.agents.checkpointer.provider import (
    POSTGRES_CONN_REQUIRED,
    POSTGRES_INSTALL,
    SQLITE_INSTALL,
    _resolve_sqlite_conn_str,
)
from evoflow.config.app_config import get_app_config

logger = logging.getLogger(__name__)


def _sqlite_busy_timeout_ms() -> int:
    """How long a SQLite write waits for a competing writer before giving up.

    The **sync** provider sets ``PRAGMA busy_timeout=5000``; the async one used
    by the in-process LangGraph server did not set it at all, so a contended
    write failed fast with ``database is locked`` — which turned an 85-minute
    run into a failed run (see Task 2610241133_c9f4). Defaults to 15s.
    """
    raw = (os.getenv("EVOFLOW_SQLITE_BUSY_TIMEOUT_MS") or "").strip()
    if raw.isdigit():
        return max(1000, int(raw))
    return 15000


async def _apply_sqlite_busy_timeout(saver: Any) -> None:
    """Raise the busy timeout on an open AsyncSqliteSaver connection."""
    timeout_ms = _sqlite_busy_timeout_ms()
    conn = getattr(saver, "conn", None)
    if conn is None:
        return
    try:
        await conn.execute(f"PRAGMA busy_timeout={int(timeout_ms)}")
        logger.info("Checkpointer: sqlite busy_timeout=%dms", timeout_ms)
    except Exception:
        logger.debug("Checkpointer: failed to set sqlite busy_timeout", exc_info=True)


def _wrap_omit_transcript(saver: Checkpointer) -> Checkpointer:
    from evoflow.agents.checkpointer.omit_transcript import (
        OmitTranscriptCheckpointer,
        omit_transcript_on_checkpoint_put_enabled,
    )

    if not omit_transcript_on_checkpoint_put_enabled():
        return saver
    logger.info("Checkpointer: omitting messages/ui_messages on put (DB transcript SSOT)")
    return OmitTranscriptCheckpointer(saver)  # type: ignore[return-value]


# ---------------------------------------------------------------------------
# Async factory
# ---------------------------------------------------------------------------


@contextlib.asynccontextmanager
async def _async_checkpointer(config) -> AsyncIterator[Checkpointer]:
    """Async context manager that constructs and tears down a checkpointer."""
    if config.type == "memory":
        from langgraph.checkpoint.memory import InMemorySaver

        yield _wrap_omit_transcript(InMemorySaver())
        return

    if config.type == "sqlite":
        try:
            from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
        except ImportError as exc:
            raise ImportError(SQLITE_INSTALL) from exc

        import pathlib

        conn_str = _resolve_sqlite_conn_str(config.connection_string or "store.db")
        # Only create parent directories for real filesystem paths
        if conn_str != ":memory:" and not conn_str.startswith("file:"):
            pathlib.Path(conn_str).parent.mkdir(parents=True, exist_ok=True)
        async with AsyncSqliteSaver.from_conn_string(conn_str) as saver:
            await saver.setup()
            await _apply_sqlite_busy_timeout(saver)
            yield _wrap_omit_transcript(saver)
        return

    if config.type == "postgres":
        try:
            from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
        except ImportError as exc:
            raise ImportError(POSTGRES_INSTALL) from exc

        if not config.connection_string:
            raise ValueError(POSTGRES_CONN_REQUIRED)

        async with AsyncPostgresSaver.from_conn_string(config.connection_string) as saver:
            await saver.setup()
            yield _wrap_omit_transcript(saver)
        return

    raise ValueError(f"Unknown checkpointer type: {config.type!r}")


# ---------------------------------------------------------------------------
# Public async context manager
# ---------------------------------------------------------------------------


@contextlib.asynccontextmanager
async def make_checkpointer() -> AsyncIterator[Checkpointer]:
    """Async context manager that yields a checkpointer for the caller's lifetime.
    Resources are opened on enter and closed on exit — no global state::

        async with make_checkpointer() as checkpointer:
            app.state.checkpointer = checkpointer

    Yields an ``InMemorySaver`` when no checkpointer is configured in *config.yaml*.
    """

    config = get_app_config()

    if config.checkpointer is None:
        from langgraph.checkpoint.memory import InMemorySaver

        yield _wrap_omit_transcript(InMemorySaver())
        return

    async with _async_checkpointer(config.checkpointer) as saver:
        yield saver
