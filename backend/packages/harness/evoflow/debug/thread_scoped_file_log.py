"""Legacy per-thread debug log paths (read-only fallback for agent-trace UI).

Structured trace rows are persisted in SQLite observability; file append helpers are
retained as no-ops for backward compatibility with older call sites.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from evoflow.debug.trace_sink import debug_log_root

_SAFE_THREAD_DIR = re.compile(r"^[a-zA-Z0-9._-]+$")


def normalize_thread_dir_segment(raw_thread_id: str | None) -> str:
    """Directory name under ``threads/``; safe on disk."""
    s = (raw_thread_id or "").strip()
    if not s or s == "unknown" or not _SAFE_THREAD_DIR.fullmatch(s):
        return "_no_thread"
    return s


def thread_log_paths(raw_thread_id: str | None, filename: str) -> list[Path]:
    """Legacy path list for reading old files under ``logs/debug/threads/<segment>/``."""
    seg = normalize_thread_dir_segment(raw_thread_id)
    p = debug_log_root() / "logs" / "debug" / "threads" / seg / filename
    return [p]


def jsonl_row_with_thread_id(raw_thread_id: str | None, body: dict[str, Any]) -> dict[str, Any]:
    """Return ``body`` plus forced top-level ``thread_id`` (real uuid when valid, else segment)."""
    seg = normalize_thread_dir_segment(raw_thread_id)
    raw = (raw_thread_id or "").strip()
    tid_field = raw if raw and raw != "unknown" and _SAFE_THREAD_DIR.fullmatch(raw) else seg
    row = dict(body)
    row["thread_id"] = tid_field
    return row


def append_jsonl_thread_scoped(raw_thread_id: str | None, filename: str, body: dict[str, Any]) -> None:
    """No-op: observability SQLite is the write path."""
    return


def append_text_block_thread_scoped(raw_thread_id: str | None, filename: str, text: str) -> None:
    """No-op: observability SQLite is the write path."""
    return
