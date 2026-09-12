"""SQLite CRUD for ``evoflow_session_notifications``.

Soft-delete model: ``clear`` sets ``cleared=1`` instead of DELETE, so the
fingerprint row is retained and the UNIQUE constraint prevents re-insertion
of the same goal-closure report after a clear + restart.

Multi-user: rows stamped with ``created_by``; list/mark/clear filter by principal.
"""

from __future__ import annotations

import time
from typing import Any

from evoflow.persistence.db import get_db
from evoflow.timeutil import utc_now_iso_z

MAX_NOTIFICATIONS = 200
MAX_TOTAL_ROWS = 500  # including cleared rows (dedup retention)


def _fingerprint(session_key: str, body: str) -> str:
    """Dedup key: ``session_key:body[:120]``."""
    return f"{session_key}:{body[:120]}"


def _has_created_by_col() -> bool:
    cols = {
        str(r[1])
        for r in get_db().execute("PRAGMA table_info(evoflow_session_notifications)").fetchall()
    }
    return "created_by" in cols


def _row_to_dict(row: Any) -> dict[str, Any]:
    return {
        "id": str(row["id"] or ""),
        "sessionKey": str(row["session_key"] or ""),
        "sessionTitle": str(row["session_title"] or ""),
        "kind": str(row["kind"] or "goal_closure"),
        "title": str(row["title"] or ""),
        "outcome": str(row["outcome"] or ""),
        "body": str(row["body"] or ""),
        "ts": int(row["ts_ms"] or 0),
        "read": bool(row["read"]),
    }


def list_session_notifications(
    limit: int = MAX_NOTIFICATIONS,
    *,
    created_by: str | None = None,
    is_admin: bool = False,
) -> list[dict[str, Any]]:
    """Return visible (cleared=0) notifications newest-first."""
    cap = max(1, min(int(limit or MAX_NOTIFICATIONS), MAX_NOTIFICATIONS))
    db = get_db()
    if is_admin or not created_by or not _has_created_by_col():
        rows = db.execute(
            """SELECT id, session_key, session_title, kind, title, outcome,
                      body, ts_ms, read
               FROM evoflow_session_notifications
               WHERE cleared = 0
               ORDER BY ts_ms DESC
               LIMIT ?""",
            (cap,),
        ).fetchall()
    else:
        # Own rows only; empty created_by = admin-only (fail closed).
        rows = db.execute(
            """SELECT id, session_key, session_title, kind, title, outcome,
                      body, ts_ms, read
               FROM evoflow_session_notifications
               WHERE cleared = 0 AND created_by = ?
               ORDER BY ts_ms DESC
               LIMIT ?""",
            (created_by, cap),
        ).fetchall()
    return [_row_to_dict(r) for r in rows]


def get_unread_count(*, created_by: str | None = None, is_admin: bool = False) -> int:
    db = get_db()
    if is_admin or not created_by or not _has_created_by_col():
        row = db.execute(
            "SELECT COUNT(*) FROM evoflow_session_notifications WHERE cleared = 0 AND read = 0"
        ).fetchone()
    else:
        row = db.execute(
            """SELECT COUNT(*) FROM evoflow_session_notifications
               WHERE cleared = 0 AND read = 0 AND created_by = ?""",
            (created_by,),
        ).fetchone()
    return int(row[0]) if row else 0


def push_session_notification(
    *,
    session_key: str,
    session_title: str = "",
    kind: str = "goal_closure",
    title: str = "通知",
    outcome: str = "",
    body: str = "",
    ts_ms: int | None = None,
    notification_id: str = "",
    created_by: str | None = None,
) -> bool:
    """Insert a notification. Returns ``True`` if a new row was created."""
    sk = str(session_key or "").strip()
    if not sk:
        return False
    b = str(body or "").strip()
    fp = _fingerprint(sk, b)
    ts = int(ts_ms) if ts_ms and ts_ms > 0 else int(time.time() * 1000)
    nid = str(notification_id or "").strip() or f"ntf-{ts}-{hex(ts)[-6:]}"
    k = str(kind or "goal_closure").strip() or "goal_closure"
    t = str(title or "通知").strip() or "通知"
    o = str(outcome or "").strip() or "（未知）"
    st = str(session_title or "").strip()
    now = utc_now_iso_z()
    creator = str(created_by or "").strip() or None

    db = get_db()

    existing = db.execute(
        "SELECT id, body, cleared FROM evoflow_session_notifications WHERE fingerprint = ?",
        (fp,),
    ).fetchone()
    if existing:
        if int(existing["cleared"] or 0) == 0:
            existing_body = str(existing["body"] or "")
            if len(b) > len(existing_body) + 24:
                db.execute(
                    """UPDATE evoflow_session_notifications
                       SET body = ?, outcome = ?, title = ?, session_title = ?
                       WHERE fingerprint = ?""",
                    (b, o, t, st, fp),
                )
                db.commit()
        return False

    if _has_created_by_col():
        db.execute(
            """INSERT INTO evoflow_session_notifications
                 (id, session_key, session_title, kind, title, outcome, body,
                  ts_ms, read, cleared, fingerprint, created_at, created_by)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)
               ON CONFLICT(fingerprint) DO NOTHING""",
            (nid, sk, st, k, t, o, b, ts, fp, now, creator),
        )
    else:
        db.execute(
            """INSERT INTO evoflow_session_notifications
                 (id, session_key, session_title, kind, title, outcome, body,
                  ts_ms, read, cleared, fingerprint, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
               ON CONFLICT(fingerprint) DO NOTHING""",
            (nid, sk, st, k, t, o, b, ts, fp, now),
        )
    db.commit()

    db.execute(
        """DELETE FROM evoflow_session_notifications
           WHERE id NOT IN (
               SELECT id FROM evoflow_session_notifications
               ORDER BY ts_ms DESC
               LIMIT ?
           )""",
        (MAX_TOTAL_ROWS,),
    )
    db.commit()
    return True


def mark_session_notification_read(
    notification_id: str,
    *,
    created_by: str | None = None,
    is_admin: bool = False,
) -> bool:
    nid = str(notification_id or "").strip()
    if not nid:
        return False
    db = get_db()
    if is_admin or not created_by or not _has_created_by_col():
        cur = db.execute(
            "UPDATE evoflow_session_notifications SET read = 1 WHERE id = ? AND read = 0 AND cleared = 0",
            (nid,),
        )
    else:
        cur = db.execute(
            """UPDATE evoflow_session_notifications SET read = 1
               WHERE id = ? AND read = 0 AND cleared = 0 AND created_by = ?""",
            (nid, created_by),
        )
    db.commit()
    return cur.rowcount > 0


def mark_all_session_notifications_read(
    *,
    created_by: str | None = None,
    is_admin: bool = False,
) -> int:
    db = get_db()
    if is_admin or not created_by or not _has_created_by_col():
        cur = db.execute(
            "UPDATE evoflow_session_notifications SET read = 1 WHERE read = 0 AND cleared = 0"
        )
    else:
        cur = db.execute(
            """UPDATE evoflow_session_notifications SET read = 1
               WHERE read = 0 AND cleared = 0 AND created_by = ?""",
            (created_by,),
        )
    db.commit()
    return cur.rowcount


def clear_all_session_notifications(
    *,
    created_by: str | None = None,
    is_admin: bool = False,
) -> int:
    """Soft-delete visible notifications (sets cleared=1, retains fingerprints)."""
    db = get_db()
    if is_admin or not created_by or not _has_created_by_col():
        cur = db.execute(
            "UPDATE evoflow_session_notifications SET cleared = 1 WHERE cleared = 0"
        )
    else:
        cur = db.execute(
            """UPDATE evoflow_session_notifications SET cleared = 1
               WHERE cleared = 0 AND created_by = ?""",
            (created_by,),
        )
    db.commit()
    return cur.rowcount


def clear_session_notifications(
    session_key: str,
    *,
    created_by: str | None = None,
    is_admin: bool = False,
) -> int:
    """Soft-delete all visible notifications for a session."""
    sk = str(session_key or "").strip()
    if not sk:
        return 0
    db = get_db()
    if is_admin or not created_by or not _has_created_by_col():
        cur = db.execute(
            "UPDATE evoflow_session_notifications SET cleared = 1 WHERE session_key = ? AND cleared = 0",
            (sk,),
        )
    else:
        cur = db.execute(
            """UPDATE evoflow_session_notifications SET cleared = 1
               WHERE session_key = ? AND cleared = 0 AND created_by = ?""",
            (sk, created_by),
        )
    db.commit()
    return cur.rowcount


def has_fingerprint(session_key: str, body: str) -> bool:
    """Check whether a fingerprint already exists (for pre-push dedup checks)."""
    sk = str(session_key or "").strip()
    if not sk:
        return False
    fp = _fingerprint(sk, str(body or "").strip())
    row = get_db().execute(
        "SELECT 1 FROM evoflow_session_notifications WHERE fingerprint = ?",
        (fp,),
    ).fetchone()
    return row is not None
