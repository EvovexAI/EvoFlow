"""H3-B-1: per-session projection writer registry.

A single ``ConversationProjectionWriter`` is shared across all subscribers for
a given ``session_id`` so that row ids, seq numbers, and pending frames stay
coherent regardless of how many transports consume them.

H3-B-2 will write to writers acquired from this registry alongside the existing
H1 demo orchestrator (which keeps its own writer instance for back-compat).
"""

from __future__ import annotations

from threading import RLock
from typing import Any

from .projection import ConversationProjectionWriter

_REGISTRY: dict[str, ConversationProjectionWriter] = {}
_LOCK = RLock()


def get_or_create_writer(
    session_id: str,
    *,
    log_epoch: str = "0",
) -> ConversationProjectionWriter:
    """Return the writer for ``session_id``; create if missing.

    Idempotent across callers (H1 demo orchestrator, H3-B-2 translator, future
    transport layers). Per-session writers are kept in-process; restart drops
    them — that is fine for H3-B scope (history replay relies on
    ``live-run`` snapshot from chat_sessions.py, see H3-B doc risk table).
    """
    sid = str(session_id or "").strip()
    if not sid:
        raise ValueError("session_id required")
    with _LOCK:
        w = _REGISTRY.get(sid)
        if w is None:
            w = ConversationProjectionWriter(sid, log_epoch=log_epoch)
            _REGISTRY[sid] = w
        return w


def drop_writer(session_id: str) -> bool:
    """Test / shutdown helper: drop writer for ``session_id``."""
    sid = str(session_id or "").strip()
    with _LOCK:
        return _REGISTRY.pop(sid, None) is not None


def list_sessions() -> list[str]:
    """Diagnostic: list active session_ids."""
    with _LOCK:
        return list(_REGISTRY.keys())


__all__: list[str] = [
    "get_or_create_writer",
    "drop_writer",
    "list_sessions",
    # Re-exported for convenience
    "ConversationProjectionWriter",
]
