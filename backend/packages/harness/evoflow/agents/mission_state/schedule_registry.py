"""Per-thread mission analysis schedule markers (coalesce reads within a user turn)."""

from __future__ import annotations

import threading

_lock = threading.Lock()
_scheduled_turn: dict[str, str] = {}


def mark_turn_scheduled(thread_id: str, turn_key: str) -> None:
    tid = str(thread_id or "").strip()
    key = str(turn_key or "").strip()
    if not tid or not key:
        return
    with _lock:
        _scheduled_turn[tid] = key


def clear_turn_scheduled(thread_id: str) -> None:
    tid = str(thread_id or "").strip()
    if not tid:
        return
    with _lock:
        _scheduled_turn.pop(tid, None)


def scheduled_turn_key(thread_id: str) -> str:
    tid = str(thread_id or "").strip()
    with _lock:
        return _scheduled_turn.get(tid, "")


def is_turn_scheduled(thread_id: str) -> bool:
    tid = str(thread_id or "").strip()
    with _lock:
        return tid in _scheduled_turn
