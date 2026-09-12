"""Pending inject queue for mid-turn user message steering (runtime-aligned).

runtime keeps ``TurnState.pending_input`` **in memory only**. EvoFlow mirrors that:
steers live in a process-local queue keyed by ``session_key`` until the next
``before_model`` drain writes them into ``evoflow_chat_messages``.

No SQLite table is used for unconsumed steers — refresh / process restart
drops them (same as runtime). Interrupt restore pops the in-memory queue back
to the composer.
"""

from __future__ import annotations

import itertools
import logging
import threading
from typing import Any

from evoflow.persistence.chat_message_content import loads_payload, pack_payload
from evoflow.persistence.timestamps import now_iso_z

logger = logging.getLogger(__name__)

_LOCK = threading.RLock()
# session_key -> list of pending item dicts (oldest first)
_PENDING: dict[str, list[dict[str, Any]]] = {}
# session_key -> last consumed info (camelCase)
_LAST_CONSUMED: dict[str, dict[str, Any]] = {}
_ID_SEQ = itertools.count(1)


def _payload_text(payload: Any) -> str:
    if not isinstance(payload, dict):
        return ""
    c = payload.get("content")
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        parts: list[str] = []
        for p in c:
            if isinstance(p, dict) and p.get("type") == "text":
                parts.append(str(p.get("text") or ""))
            elif isinstance(p, str):
                parts.append(p)
        return "".join(parts)
    return ""


def _normalize_payload(
    *,
    role: str,
    content: Any,
    content_json: str | dict[str, Any] | None,
) -> dict[str, Any]:
    if isinstance(content_json, dict):
        payload = dict(content_json)
    elif isinstance(content_json, str) and content_json:
        try:
            payload = loads_payload(content_json)
        except Exception:
            payload = pack_payload(role=role, content=content or "")
    else:
        payload = pack_payload(role=role, content=content or "")
    if not payload.get("content") and content:
        payload = pack_payload(role=role, content=content)
    return payload


def clear_pending_inject_store_for_tests() -> None:
    """Test helper: wipe process-local queues."""
    with _LOCK:
        _PENDING.clear()
        _LAST_CONSUMED.clear()


def enqueue_pending_inject(
    session_key: str,
    *,
    message_id: str,
    content: Any = None,
    content_json: str | dict[str, Any] | None = None,
    role: str = "user",
    tool_name: str | None = None,
    run_id: str | None = None,
    thread_id: str | None = None,
) -> dict[str, Any] | None:
    """Push a steer into the in-memory queue (runtime ``pending_input.extend``).

    Returns the enqueued item, or ``None`` if already queued
    (dedupe by ``session_key + message_id``).
    """
    sk = str(session_key or "").strip()
    mid = str(message_id or "").strip()
    if not sk or not mid:
        return None

    role_norm = str(role or "user").strip().lower() or "user"
    payload = _normalize_payload(role=role_norm, content=content, content_json=content_json)
    created = now_iso_z()

    with _LOCK:
        q = _PENDING.setdefault(sk, [])
        if any(str(it.get("message_id") or "") == mid for it in q):
            return None
        item = {
            "id": next(_ID_SEQ),
            "session_key": sk,
            "message_id": mid,
            "role": role_norm,
            "content_json": payload,
            "text": _payload_text(payload),
            "tool_name": tool_name,
            "run_id": run_id,
            "thread_id": thread_id,
            "created_at": created,
        }
        q.append(item)
        return dict(item)


def consume_pending_injects(
    session_key: str,
    *,
    consumed_by_run_id: str | None = None,
) -> list[dict[str, Any]]:
    """Atomically drain all pending steers for ``session_key`` (oldest first).

    Caller writes them into ``evoflow_chat_messages``. Clears the in-memory
    queue (runtime drain of ``pending_input``).
    """
    sk = str(session_key or "").strip()
    if not sk:
        return []

    consumed_at = now_iso_z()
    run_id = str(consumed_by_run_id or "").strip() or None

    with _LOCK:
        q = _PENDING.pop(sk, [])
        if not q:
            return []
        out: list[dict[str, Any]] = []
        last_mid = ""
        for it in q:
            row = dict(it)
            row["consumed_at"] = consumed_at
            row["consumed_by_run_id"] = run_id
            if "text" not in row:
                row["text"] = _payload_text(row.get("content_json"))
            out.append(row)
            last_mid = str(row.get("message_id") or "") or last_mid
        if last_mid:
            _LAST_CONSUMED[sk] = {
                "messageId": last_mid,
                "consumedAt": consumed_at,
                "consumedByRunId": run_id,
            }
        return out


def list_unconsumed_pending_injects(session_key: str) -> list[dict[str, Any]]:
    """Peek pending steers without consuming (composer preview / status)."""
    sk = str(session_key or "").strip()
    if not sk:
        return []
    with _LOCK:
        return [dict(it) for it in _PENDING.get(sk, [])]


def pop_unconsumed_pending_injects(session_key: str) -> list[dict[str, Any]]:
    """Clear pending without writing transcript (runtime interrupt restore)."""
    sk = str(session_key or "").strip()
    if not sk:
        return []
    with _LOCK:
        items = [dict(it) for it in _PENDING.pop(sk, [])]
        return items


def count_unconsumed_pending_injects(session_key: str) -> int:
    sk = str(session_key or "").strip()
    if not sk:
        return 0
    with _LOCK:
        return len(_PENDING.get(sk, []))


def pending_inject_last_consumed_info(session_key: str) -> dict[str, Any] | None:
    """Most recently consumed steer ack (process-local; lost on restart)."""
    sk = str(session_key or "").strip()
    if not sk:
        return None
    with _LOCK:
        info = _LAST_CONSUMED.get(sk)
        return dict(info) if info else None
