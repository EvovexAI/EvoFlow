from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any

from evoflow.persistence import repositories as repo


@dataclass
class RetryItem:
    thread_id: str
    mode: str
    turn_id: str
    messages: list[Any]
    attempts: int
    next_run_ts_ms: int
    last_error: str = ""
    model_name: str | None = None


def _item_from_rec(rec: dict[str, Any]) -> RetryItem | None:
    thread_id = str(rec.get("thread_id") or "").strip()
    if not thread_id:
        return None
    try:
        nrt_i = int(rec.get("next_run_ts_ms"))
    except Exception:
        return None
    return RetryItem(
        thread_id=thread_id,
        mode=str(rec.get("mode") or "incremental"),
        turn_id=str(rec.get("turn_id") or ""),
        messages=rec.get("messages") if isinstance(rec.get("messages"), list) else [],
        attempts=int(rec.get("attempts") or 0),
        next_run_ts_ms=nrt_i,
        last_error=str(rec.get("last_error") or ""),
        model_name=str(rec.get("model_name") or "").strip() or None,
    )


def append_retry(item: RetryItem) -> None:
    rec = {
        "thread_id": item.thread_id,
        "mode": item.mode,
        "turn_id": item.turn_id,
        "attempts": item.attempts,
        "next_run_ts_ms": item.next_run_ts_ms,
        "last_error": item.last_error,
        "messages": item.messages,
        "model_name": item.model_name,
        "ts_ms": int(time.time() * 1000),
    }
    repo.append_mission_retry(item.thread_id, rec, item.next_run_ts_ms)


def load_due_items(now_ts_ms: int) -> list[RetryItem]:
    out: list[RetryItem] = []
    for rec in repo.load_due_mission_retries(now_ts_ms):
        item = _item_from_rec(rec)
        if item is not None:
            out.append(item)
    out.sort(key=lambda x: x.next_run_ts_ms)
    return out


def pop_due_items(now_ts_ms: int, *, limit: int = 10) -> list[RetryItem]:
    out: list[RetryItem] = []
    for rec in repo.pop_due_mission_retries(now_ts_ms, limit=limit):
        item = _item_from_rec(rec)
        if item is not None:
            out.append(item)
    out.sort(key=lambda x: x.next_run_ts_ms)
    return out


def prune_retry_files(max_bytes: int = 3_000_000) -> None:
    del max_bytes
    repo.prune_mission_retries(max_rows=5000)
