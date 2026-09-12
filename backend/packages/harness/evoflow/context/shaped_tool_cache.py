"""Per-thread cache of shaped / summarized tool outputs for history aging."""

from __future__ import annotations

import threading
from collections import OrderedDict

_lock = threading.Lock()
_by_thread: dict[str, OrderedDict[str, str]] = {}
_MAX_PER_THREAD = 256


def remember_shaped(thread_id: str, tool_call_id: str, shaped: str) -> None:
    tid = str(thread_id or "").strip()
    cid = str(tool_call_id or "").strip()
    text = (shaped or "").strip()
    if not tid or not cid or not text:
        return
    with _lock:
        od = _by_thread.setdefault(tid, OrderedDict())
        od[cid] = text
        od.move_to_end(cid)
        while len(od) > _MAX_PER_THREAD:
            od.popitem(last=False)


def get_shaped(thread_id: str, tool_call_id: str) -> str | None:
    tid = str(thread_id or "").strip()
    cid = str(tool_call_id or "").strip()
    if not tid or not cid:
        return None
    with _lock:
        od = _by_thread.get(tid)
        if not od:
            return None
        return od.get(cid)


def clear_thread(thread_id: str) -> None:
    tid = str(thread_id or "").strip()
    if not tid:
        return
    with _lock:
        _by_thread.pop(tid, None)
