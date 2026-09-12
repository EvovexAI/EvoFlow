"""In-memory ACP session registry for supervisor.

V1: process-local registry. Persistence hooks can be added later.
"""

from __future__ import annotations

import threading
import time
import uuid
from dataclasses import asdict

from .acp_models import AcpSessionRecord, AcpSessionStatus

_LOCK = threading.RLock()
_BY_SUPERVISOR_SESSION: dict[str, AcpSessionRecord] = {}
_BY_BINDING_KEY: dict[str, str] = {}


def build_binding_key(
    *,
    provider: str,
    thread_id: str | None,
    task_id: str | None,
    subtask_id: str | None,
) -> str:
    return "|".join(
        [
            str(provider or "").strip().lower(),
            str(thread_id or "").strip(),
            str(task_id or "").strip(),
            str(subtask_id or "").strip(),
        ]
    )


def get_or_create(
    *,
    provider: str,
    thread_id: str | None,
    task_id: str | None,
    subtask_id: str | None,
) -> AcpSessionRecord:
    with _LOCK:
        key = build_binding_key(
            provider=provider,
            thread_id=thread_id,
            task_id=task_id,
            subtask_id=subtask_id,
        )
        sid = _BY_BINDING_KEY.get(key)
        if sid and sid in _BY_SUPERVISOR_SESSION:
            rec = _BY_SUPERVISOR_SESSION[sid]
            rec.touch()
            return rec

        sid = f"acp-{uuid.uuid4().hex[:16]}"
        rec = AcpSessionRecord(
            supervisor_session_id=sid,
            provider=str(provider or "").strip().lower(),
            thread_id=str(thread_id or "").strip() or None,
            task_id=str(task_id or "").strip() or None,
            subtask_id=str(subtask_id or "").strip() or None,
        )
        _BY_SUPERVISOR_SESSION[sid] = rec
        _BY_BINDING_KEY[key] = sid
        return rec


def require_existing(supervisor_session_id: str) -> AcpSessionRecord | None:
    with _LOCK:
        rec = _BY_SUPERVISOR_SESSION.get(str(supervisor_session_id or "").strip())
        if rec:
            rec.touch()
        return rec


def update_status(
    supervisor_session_id: str,
    *,
    status: AcpSessionStatus | str | None = None,
    acp_session_id: str | None = None,
    error: str | None = None,
    chunk_seen: bool = False,
    completed: bool = False,
) -> AcpSessionRecord | None:
    with _LOCK:
        rec = _BY_SUPERVISOR_SESSION.get(str(supervisor_session_id or "").strip())
        if not rec:
            return None
        if status is not None:
            rec.status = AcpSessionStatus(str(status))
        if acp_session_id:
            rec.acp_session_id = acp_session_id
        if error is not None:
            rec.last_error = error
        if chunk_seen:
            from .acp_models import _utc_now

            rec.last_chunk_at = _utc_now()
            rec.status = AcpSessionStatus.STREAMING
        if completed:
            from .acp_models import _utc_now

            rec.last_completed_at = _utc_now()
            rec.status = AcpSessionStatus.COMPLETED
            rec.turn_index += 1
        rec.touch()
        return rec


def close(supervisor_session_id: str) -> AcpSessionRecord | None:
    with _LOCK:
        rec = _BY_SUPERVISOR_SESSION.get(str(supervisor_session_id or "").strip())
        if not rec:
            return None
        rec.status = AcpSessionStatus.CLOSED
        rec.touch()
        return rec


def list_by_task(task_id: str) -> list[dict]:
    tid = str(task_id or "").strip()
    with _LOCK:
        return [asdict(r) for r in _BY_SUPERVISOR_SESSION.values() if str(r.task_id or "") == tid]


def find_reusable_for_task(
    *,
    provider: str,
    thread_id: str | None,
    task_id: str | None,
) -> AcpSessionRecord | None:
    """Find an active session to reuse for the same task/provider/thread."""
    p = str(provider or "").strip().lower()
    t = str(thread_id or "").strip()
    tid = str(task_id or "").strip()
    if not p or not tid:
        return None
    with _LOCK:
        for rec in _BY_SUPERVISOR_SESSION.values():
            if str(rec.provider or "").strip().lower() != p:
                continue
            if str(rec.task_id or "").strip() != tid:
                continue
            if str(rec.thread_id or "").strip() != t:
                continue
            if rec.status == AcpSessionStatus.CLOSED:
                continue
            rec.touch()
            return rec
    return None


# ── Stream buffering (for detached ACP runs) ──────────────────────────
# Rationale:
# - ACP client callbacks often run outside LangGraph runtime, so they cannot call get_stream_writer().
# - We buffer chunks here, then flush them from a LangGraph tool turn (monitor_execution_step),
#   where get_stream_writer() is available to emit `event: custom` task_running messages.

_MAX_BUFFER_ITEMS = 5000


def append_stream_chunk(
    supervisor_session_id: str,
    *,
    subtask_id: str | None,
    chunk: str,
) -> int | None:
    """Append a streamed text chunk to the in-memory buffer.

    Returns the new monotonically increasing seq number, or None if session not found.
    """
    sid = str(supervisor_session_id or "").strip()
    if not sid:
        return None
    text = str(chunk or "")
    if not text:
        return None
    with _LOCK:
        rec = _BY_SUPERVISOR_SESSION.get(sid)
        if not rec:
            return None
        meta = rec.meta or {}
        seq = int(meta.get("stream_seq") or 0) + 1
        meta["stream_seq"] = seq
        buf = meta.get("stream_buffer")
        if not isinstance(buf, list):
            buf = []
        buf.append(
            {
                "seq": seq,
                "ts": time.time(),
                "subtask_id": str(subtask_id or "").strip() or None,
                "chunk": text,
            }
        )
        if len(buf) > _MAX_BUFFER_ITEMS:
            buf = buf[-_MAX_BUFFER_ITEMS:]
        meta["stream_buffer"] = buf
        rec.meta = meta
        rec.touch()
        return seq


def drain_stream_chunks(
    supervisor_session_id: str,
    *,
    after_seq: int = 0,
) -> tuple[int, list[dict]]:
    """Drain buffered chunks with seq > after_seq.

    Returns: (latest_seq, items_sorted_by_seq)
    """
    sid = str(supervisor_session_id or "").strip()
    if not sid:
        return after_seq, []
    with _LOCK:
        rec = _BY_SUPERVISOR_SESSION.get(sid)
        if not rec:
            return after_seq, []
        meta = rec.meta or {}
        latest = int(meta.get("stream_seq") or 0)
        buf = meta.get("stream_buffer")
        if not isinstance(buf, list) or not buf:
            return latest, []
        items = [x for x in buf if int(x.get("seq") or 0) > int(after_seq or 0)]
        items.sort(key=lambda x: int(x.get("seq") or 0))
        return latest, items


def list_active_sessions_for_task(task_id: str) -> list[str]:
    """Return supervisor_session_id list for the given task (non-closed)."""
    tid = str(task_id or "").strip()
    if not tid:
        return []
    with _LOCK:
        out: list[str] = []
        for sid, rec in _BY_SUPERVISOR_SESSION.items():
            if str(rec.task_id or "").strip() != tid:
                continue
            if rec.status == AcpSessionStatus.CLOSED:
                continue
            out.append(sid)
        return out


def set_final_result(
    supervisor_session_id: str,
    *,
    result: str,
) -> bool:
    """Store final result text for a completed send turn."""
    sid = str(supervisor_session_id or "").strip()
    if not sid:
        return False
    with _LOCK:
        rec = _BY_SUPERVISOR_SESSION.get(sid)
        if not rec:
            return False
        meta = rec.meta or {}
        meta["final_result"] = str(result or "")
        rec.meta = meta
        rec.touch()
        return True


def get_final_result(supervisor_session_id: str) -> str | None:
    sid = str(supervisor_session_id or "").strip()
    if not sid:
        return None
    with _LOCK:
        rec = _BY_SUPERVISOR_SESSION.get(sid)
        if not rec:
            return None
        meta = rec.meta or {}
        v = meta.get("final_result")
        if isinstance(v, str) and v != "":
            return v
        return None
