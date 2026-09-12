"""Append-only SSE wire-format mirror for chat stream resume."""

from __future__ import annotations

import json
import logging
import os
import time
from typing import Any

from evoflow.persistence.db import get_db, run_db_transaction
from evoflow.persistence.timestamps import iso_z_to_ms, ms_to_iso_z

logger = logging.getLogger(__name__)

STREAM_RESUME_TTL_SECONDS = int(os.getenv("EVOFLOW_STREAM_RESUME_TTL_SECONDS", "300") or "300")
STREAM_RESUME_POST_COMPLETE_TTL_SECONDS = int(
    os.getenv("EVOFLOW_STREAM_RESUME_POST_COMPLETE_TTL_SECONDS", "30") or "30"
)
STREAM_MIRROR_MAX_FRAMES = int(os.getenv("EVOFLOW_STREAM_MIRROR_MAX_FRAMES", "50000") or "50000")
STREAM_MIRROR_MAX_BYTES = int(os.getenv("EVOFLOW_STREAM_MIRROR_MAX_BYTES", "52428800") or "52428800")

_FALSE_ENV = frozenset({"0", "false", "no", "off"})


def stream_mirror_writes_enabled() -> bool:
    """Whether mirror-table inserts are allowed. Default off (history-poll resume)."""
    env = (os.getenv("EVOFLOW_STREAM_MIRROR") or "0").strip().lower()
    return env not in _FALSE_ENV


def _now_ms() -> int:
    return int(time.time() * 1000)


def _expires_after_seconds(seconds: int, *, now_ms: int | None = None) -> str:
    base = int(now_ms if now_ms is not None else _now_ms())
    return ms_to_iso_z(base + max(0, int(seconds)) * 1000)


def clear_mirror(session_key: str, *, conn: Any | None = None) -> None:
    sk = str(session_key or "").strip()
    if not sk:
        return

    def _tx(db: Any) -> None:
        db.execute("DELETE FROM evoflow_chat_stream_mirror WHERE session_key = ?", (sk,))
        db.execute("DELETE FROM evoflow_chat_stream_mirror_meta WHERE session_key = ?", (sk,))

    if conn is not None:
        _tx(conn)
        return
    run_db_transaction(_tx)


def get_mirror_meta(session_key: str, *, conn: Any | None = None) -> dict[str, Any] | None:
    sk = str(session_key or "").strip()
    if not sk:
        return None
    db = conn or get_db()
    row = db.execute(
        """
        SELECT session_key, thread_id, run_id, updated_at, unavailable_json,
               expires_at, frame_count, byte_count, last_persisted_seq
        FROM evoflow_chat_stream_mirror_meta
        WHERE session_key = ?
        """,
        (sk,),
    ).fetchone()
    if row is None:
        return None
    d = dict(row)
    unavailable = None
    raw_unavail = d.get("unavailable_json")
    if raw_unavail:
        try:
            unavailable = json.loads(raw_unavail)
        except json.JSONDecodeError:
            unavailable = None
    updated_at = str(d.get("updated_at") or "").strip()
    expires_at = str(d.get("expires_at") or "").strip() or None
    return {
        "sessionKey": str(d.get("session_key") or "").strip(),
        "threadId": str(d.get("thread_id") or "").strip() or None,
        "runId": str(d.get("run_id") or "").strip() or None,
        "updatedAt": updated_at,
        "updatedAtMs": iso_z_to_ms(updated_at) if updated_at else 0,
        "unavailable": unavailable,
        "expiresAt": expires_at,
        "expiresAtMs": iso_z_to_ms(expires_at) if expires_at else None,
        "frameCount": int(d.get("frame_count") or 0),
        "byteCount": int(d.get("byte_count") or 0),
        "lastPersistedSeq": int(d.get("last_persisted_seq") or 0),
    }


def update_last_persisted_seq(
    session_key: str,
    *,
    run_id: str | None = None,
    conn: Any | None = None,
) -> None:
    """Record the latest mirror frame seq whose content is persisted to chat messages.

    Called after ``append_messages_batch`` writes to ``evoflow_chat_messages`` so
    that ``stream_resume_events`` can skip already-persisted frames and only
    replay the incremental tail.
    """
    sk = str(session_key or "").strip()
    if not sk:
        return

    def _tx(db: Any) -> None:
        rid = str(run_id or "").strip()
        if not rid:
            meta = get_mirror_meta(sk, conn=db)
            if not meta:
                return
            rid = str(meta.get("runId") or "").strip()
        if not rid:
            return
        row = db.execute(
            "SELECT COALESCE(MAX(seq), 0) FROM evoflow_chat_stream_mirror "
            "WHERE session_key = ? AND run_id = ?",
            (sk, rid),
        ).fetchone()
        max_seq = int(row[0] or 0)
        db.execute(
            """
            UPDATE evoflow_chat_stream_mirror_meta
            SET last_persisted_seq = ?
            WHERE session_key = ?
            """,
            (max_seq, sk),
        )

    if conn is not None:
        _tx(conn)
        return
    run_db_transaction(_tx)


def set_mirror_unavailable(
    session_key: str,
    reason: str,
    *,
    thread_id: str | None = None,
    run_id: str | None = None,
    conn: Any | None = None,
) -> None:
    sk = str(session_key or "").strip()
    if not sk:
        return
    now_ms = _now_ms()
    now_iso = ms_to_iso_z(now_ms)
    expires_at = _expires_after_seconds(STREAM_RESUME_TTL_SECONDS, now_ms=now_ms)
    payload = json.dumps({"reason": str(reason or "mirrorUnavailable")}, ensure_ascii=False)

    def _tx(db: Any) -> None:
        existing = get_mirror_meta(sk, conn=db)
        tid = str(thread_id or (existing or {}).get("threadId") or "").strip() or "unknown"
        rid = str(run_id or (existing or {}).get("runId") or "").strip() or "unknown"
        db.execute(
            """
            INSERT INTO evoflow_chat_stream_mirror_meta (
                session_key, thread_id, run_id, updated_at, unavailable_json,
                expires_at, frame_count, byte_count, last_persisted_seq
            ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0)
            ON CONFLICT(session_key) DO UPDATE SET
                unavailable_json = excluded.unavailable_json,
                updated_at = excluded.updated_at,
                expires_at = excluded.expires_at
            """,
            (sk, tid, rid, now_iso, payload, expires_at),
        )

    if conn is not None:
        _tx(conn)
        return
    run_db_transaction(_tx)


def touch_mirror_meta(
    session_key: str,
    *,
    thread_id: str,
    run_id: str,
    conn: Any | None = None,
) -> None:
    sk = str(session_key or "").strip()
    tid = str(thread_id or "").strip()
    rid = str(run_id or "").strip()
    if not sk or not tid or not rid:
        return
    now_ms = _now_ms()
    now_iso = ms_to_iso_z(now_ms)
    expires_at = _expires_after_seconds(STREAM_RESUME_TTL_SECONDS, now_ms=now_ms)

    def _tx(db: Any) -> None:
        db.execute(
            """
            INSERT INTO evoflow_chat_stream_mirror_meta (
                session_key, thread_id, run_id, updated_at, unavailable_json,
                expires_at, frame_count, byte_count, last_persisted_seq
            ) VALUES (?, ?, ?, ?, NULL, ?, 0, 0, 0)
            ON CONFLICT(session_key) DO UPDATE SET
                thread_id = excluded.thread_id,
                run_id = excluded.run_id,
                updated_at = excluded.updated_at,
                expires_at = excluded.expires_at,
                unavailable_json = NULL
            """,
            (sk, tid, rid, now_iso, expires_at),
        )

    if conn is not None:
        _tx(conn)
        return
    run_db_transaction(_tx)


def shrink_mirror_ttl(session_key: str, *, conn: Any | None = None) -> None:
    sk = str(session_key or "").strip()
    if not sk:
        return
    now_ms = _now_ms()
    now_iso = ms_to_iso_z(now_ms)
    expires_at = _expires_after_seconds(STREAM_RESUME_POST_COMPLETE_TTL_SECONDS, now_ms=now_ms)

    def _tx(db: Any) -> None:
        db.execute(
            """
            UPDATE evoflow_chat_stream_mirror_meta
            SET expires_at = ?, updated_at = ?
            WHERE session_key = ?
            """,
            (expires_at, now_iso, sk),
        )

    if conn is not None:
        _tx(conn)
        return
    run_db_transaction(_tx)


def append_mirror_frame(
    session_key: str,
    *,
    thread_id: str,
    run_id: str,
    raw_frame: str,
    is_terminal: bool = False,
    conn: Any | None = None,
) -> int | None:
    """Append one SSE frame; returns seq or None if skipped (disabled / unavailable / limits)."""
    if not stream_mirror_writes_enabled():
        return None
    sk = str(session_key or "").strip()
    tid = str(thread_id or "").strip()
    rid = str(run_id or "").strip()
    frame = str(raw_frame or "")
    if not sk or not tid or not rid or not frame.strip():
        return None

    frame_bytes = len(frame.encode("utf-8"))
    now_ms = _now_ms()
    now_iso = ms_to_iso_z(now_ms)
    expires_at = _expires_after_seconds(STREAM_RESUME_TTL_SECONDS, now_ms=now_ms)
    terminal = 1 if is_terminal else 0

    def _tx(db: Any) -> int | None:
        meta = get_mirror_meta(sk, conn=db)
        if meta and meta.get("unavailable"):
            return None
        frame_count = int(meta.get("frameCount") or 0) if meta else 0
        byte_count = int(meta.get("byteCount") or 0) if meta else 0
        if frame_count >= STREAM_MIRROR_MAX_FRAMES or byte_count + frame_bytes > STREAM_MIRROR_MAX_BYTES:
            set_mirror_unavailable(sk, "mirrorLimitExceeded", thread_id=tid, run_id=rid, conn=db)
            return None

        if meta and str(meta.get("runId") or "") != rid:
            db.execute("DELETE FROM evoflow_chat_stream_mirror WHERE session_key = ?", (sk,))
            frame_count = 0
            byte_count = 0
            # Reset last_persisted_seq — old run's frames are gone.
            db.execute(
                "UPDATE evoflow_chat_stream_mirror_meta SET last_persisted_seq = 0 "
                "WHERE session_key = ?",
                (sk,),
            )

        row = db.execute(
            "SELECT COALESCE(MAX(seq), 0) FROM evoflow_chat_stream_mirror WHERE session_key = ? AND run_id = ?",
            (sk, rid),
        ).fetchone()
        next_seq = int(row[0] or 0) + 1

        db.execute(
            """
            INSERT INTO evoflow_chat_stream_mirror (
                session_key, thread_id, run_id, seq, raw_frame, is_terminal, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (sk, tid, rid, next_seq, frame, terminal, now_iso),
        )
        db.execute(
            """
            INSERT INTO evoflow_chat_stream_mirror_meta (
                session_key, thread_id, run_id, updated_at, unavailable_json,
                expires_at, frame_count, byte_count, last_persisted_seq
            ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)
            ON CONFLICT(session_key) DO UPDATE SET
                thread_id = excluded.thread_id,
                run_id = excluded.run_id,
                updated_at = excluded.updated_at,
                expires_at = excluded.expires_at,
                unavailable_json = NULL,
                frame_count = excluded.frame_count,
                byte_count = excluded.byte_count,
                last_persisted_seq = excluded.last_persisted_seq
            """,
            (sk, tid, rid, now_iso, expires_at, frame_count + 1, byte_count + frame_bytes, next_seq),
        )
        return next_seq

    try:
        if conn is not None:
            result = _tx(conn)
        else:
            result = run_db_transaction(_tx)
        return result
    except Exception as e:
        logger.warning("stream mirror INSERT failed session=%s run=%s error=%s", sk, rid, e)
        raise


def read_mirror_frames(
    session_key: str,
    run_id: str,
    *,
    after_seq: int = 0,
    limit: int = 200,
    conn: Any | None = None,
) -> list[dict[str, Any]]:
    sk = str(session_key or "").strip()
    rid = str(run_id or "").strip()
    if not sk or not rid:
        return []
    lim = max(1, min(int(limit or 200), 500))
    after = max(0, int(after_seq or 0))
    db = conn or get_db()
    rows = db.execute(
        """
        SELECT seq, raw_frame, is_terminal, created_at
        FROM evoflow_chat_stream_mirror
        WHERE session_key = ? AND run_id = ? AND seq > ?
        ORDER BY seq ASC
        LIMIT ?
        """,
        (sk, rid, after, lim),
    ).fetchall()
    out: list[dict[str, Any]] = []
    for row in rows:
        d = dict(row)
        created_at = str(d.get("created_at") or "").strip()
        out.append(
            {
                "seq": int(d.get("seq") or 0),
                "rawFrame": str(d.get("raw_frame") or ""),
                "isTerminal": bool(int(d.get("is_terminal") or 0)),
                "createdAt": created_at,
                "createdAtMs": iso_z_to_ms(created_at) if created_at else 0,
            }
        )
    return out


def mirror_max_seq(session_key: str, run_id: str, *, conn: Any | None = None) -> int:
    """Return highest persisted seq for a run (0 when empty)."""
    sk = str(session_key or "").strip()
    rid = str(run_id or "").strip()
    if not sk or not rid:
        return 0
    db = conn or get_db()
    row = db.execute(
        "SELECT COALESCE(MAX(seq), 0) FROM evoflow_chat_stream_mirror WHERE session_key = ? AND run_id = ?",
        (sk, rid),
    ).fetchone()
    return int(row[0] or 0) if row else 0


def mirror_is_expired(session_key: str, *, now_ms: int | None = None) -> bool:
    meta = get_mirror_meta(session_key)
    if not meta:
        return True
    expires_ms = meta.get("expiresAtMs")
    if not expires_ms:
        return False
    return int(expires_ms) < int(now_ms or _now_ms())


def sweep_expired_idle_mirrors(
    *,
    now_ms: int | None = None,
    limit: int = 500,
    conn: Any | None = None,
) -> dict[str, int]:
    """Delete expired mirror rows for idle/deleted/missing sessions (startup hygiene)."""
    now = int(now_ms or _now_ms())
    now_iso = ms_to_iso_z(now)
    lim = max(1, min(int(limit or 500), 2000))

    def _tx(db: Any) -> dict[str, int]:
        rows = db.execute(
            """
            SELECT m.session_key
            FROM evoflow_chat_stream_mirror_meta m
            LEFT JOIN evoflow_chat_sessions s ON s.session_key = m.session_key
            WHERE m.expires_at IS NOT NULL
              AND m.expires_at < ?
              AND (
                s.session_key IS NULL
                OR s.is_deleted != 0
                OR COALESCE(s.run_status, 'done') NOT IN ('running', 'pending')
              )
            LIMIT ?
            """,
            (now_iso, lim),
        ).fetchall()
        keys = [str(row[0] or "").strip() for row in rows]
        keys = [k for k in keys if k]
        if not keys:
            return {"scanned": 0, "cleared": 0}
        placeholders = ",".join("?" * len(keys))
        db.execute(
            f"DELETE FROM evoflow_chat_stream_mirror WHERE session_key IN ({placeholders})",
            keys,
        )
        db.execute(
            f"DELETE FROM evoflow_chat_stream_mirror_meta WHERE session_key IN ({placeholders})",
            keys,
        )
        return {"scanned": len(keys), "cleared": len(keys)}

    if conn is not None:
        return _tx(conn)
    return run_db_transaction(_tx)
