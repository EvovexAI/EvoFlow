"""SQLite persistence for tool execution approvals (per chat session)."""

from __future__ import annotations

import json
from datetime import datetime, timedelta
from typing import Any

from evoflow.persistence.db import get_db
from evoflow.persistence.session_repositories import find_session_key_by_thread_id
from evoflow.timeutil import BEIJING_TZ, utc_now_iso_z

STATUS_PENDING = "pending"
STATUS_APPROVED = "approved"
STATUS_DENIED = "denied"
STATUS_EXECUTED = "executed"
STATUS_CANCELLED = "cancelled"


def _dumps(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, default=str)


def _loads(raw: Any) -> Any:
    if raw is None:
        return None
    if isinstance(raw, (dict, list)):
        return raw
    try:
        return json.loads(str(raw))
    except Exception:
        return None


def resolve_session_key_for_thread(thread_id: str) -> tuple[str, str]:
    """Return ``(session_key, thread_id)`` for approval rows (session_key from chat index)."""
    tid = str(thread_id or "").strip()
    if not tid:
        raise ValueError("thread_id required")
    sk = find_session_key_by_thread_id(tid)
    return (sk or tid, tid)


def _row_to_entry(row: dict[str, Any]) -> dict[str, Any]:
    args = _loads(row.get("args_json"))
    return {
        "tool_call_id": str(row.get("tool_call_id") or "").strip(),
        "tool_name": str(row.get("tool_name") or "").strip(),
        "args": dict(args) if isinstance(args, dict) else {},
        "summary": str(row.get("summary") or "").strip(),
        "signature": str(row.get("signature") or "").strip(),
        "status": str(row.get("status") or "").strip(),
        "created_at": str(row.get("created_at") or "").strip(),
        "updated_at": str(row.get("updated_at") or "").strip(),
        "session_key": str(row.get("session_key") or "").strip(),
        "thread_id": str(row.get("thread_id") or "").strip(),
    }


def _parse_grants_blob(raw: Any) -> dict[str, Any]:
    """``signatures_json`` may be legacy list or ``{signatures, tool_names}`` object."""
    data = _loads(raw)
    if isinstance(data, list):
        return {
            "signatures": [str(s) for s in data if str(s).strip()],
            "tool_names": [],
        }
    if isinstance(data, dict):
        sigs = data.get("signatures") if isinstance(data.get("signatures"), list) else []
        names = data.get("tool_names") if isinstance(data.get("tool_names"), list) else []
        return {
            "signatures": [str(s) for s in sigs if str(s).strip()],
            "tool_names": [str(n).strip().lower() for n in names if str(n).strip()],
        }
    return {"signatures": [], "tool_names": []}


def _dump_grants_blob(*, signatures: list[str], tool_names: list[str]) -> str:
    return _dumps(
        {
            "signatures": [str(s) for s in signatures if str(s).strip()],
            "tool_names": sorted({str(n).strip().lower() for n in tool_names if str(n).strip()}),
        }
    )


def load_runtime_signatures(session_key: str) -> dict[str, Any]:
    """Per-session runtime grants (exact signatures + tool names approved this session)."""
    sk = str(session_key or "").strip()
    if not sk:
        return {"signatures": [], "tool_names": []}
    row = (
        get_db()
        .execute(
            "SELECT signatures_json FROM evoflow_tool_approval_grants WHERE session_key = ?",
            (sk,),
        )
        .fetchone()
    )
    if not row:
        return {"signatures": [], "tool_names": []}
    return _parse_grants_blob(row[0])


def save_runtime_signatures(
    session_key: str,
    thread_id: str,
    signatures: list[str],
    *,
    tool_names: list[str] | None = None,
) -> None:
    sk = str(session_key or "").strip()
    tid = str(thread_id or "").strip()
    if not sk:
        return
    prev = load_runtime_signatures(sk)
    sigs = [str(s) for s in signatures if str(s).strip()]
    names = [str(n).strip().lower() for n in tool_names if str(n).strip()] if tool_names is not None else list(prev.get("tool_names") or [])
    get_db().execute(
        """
        INSERT INTO evoflow_tool_approval_grants (session_key, thread_id, grant_all, signatures_json, updated_at)
        VALUES (?, ?, 0, ?, ?)
        ON CONFLICT(session_key) DO UPDATE SET
            thread_id = COALESCE(excluded.thread_id, evoflow_tool_approval_grants.thread_id),
            signatures_json = excluded.signatures_json,
            updated_at = excluded.updated_at
        """,
        (sk, tid or None, _dump_grants_blob(signatures=sigs, tool_names=names), utc_now_iso_z()),
    )
    get_db().commit()


def load_grants(session_key: str) -> dict[str, Any]:
    """Backward-compatible alias (policy is on ``evoflow_chat_sessions``)."""
    return load_runtime_signatures(session_key)


def save_grants(session_key: str, thread_id: str, grants: dict[str, Any]) -> None:
    sigs = grants.get("signatures") if isinstance(grants.get("signatures"), list) else []
    names = grants.get("tool_names") if isinstance(grants.get("tool_names"), list) else None
    save_runtime_signatures(session_key, thread_id, sigs, tool_names=names)


def upsert_pending(
    *,
    session_key: str,
    thread_id: str,
    tool_call_id: str,
    tool_name: str,
    args: dict[str, Any],
    summary: str,
    signature: str,
) -> None:
    sk = str(session_key or "").strip()
    tid = str(thread_id or "").strip()
    tc_id = str(tool_call_id or "").strip()
    if not sk or not tid or not tc_id:
        raise ValueError("session_key, thread_id, tool_call_id required")
    existing = get_approval_row(sk, tc_id)
    if existing and str(existing.get("status") or "") in (STATUS_EXECUTED, STATUS_DENIED, STATUS_APPROVED):
        return
    now = utc_now_iso_z()
    get_db().execute(
        """
        INSERT INTO evoflow_tool_approvals (
            session_key, thread_id, tool_call_id, tool_name, args_json, summary, signature,
            status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_key, tool_call_id) DO UPDATE SET
            thread_id = excluded.thread_id,
            tool_name = excluded.tool_name,
            args_json = excluded.args_json,
            summary = excluded.summary,
            signature = excluded.signature,
            status = excluded.status,
            updated_at = excluded.updated_at
        """,
        (
            sk,
            tid,
            tc_id,
            str(tool_name or "").strip(),
            _dumps(dict(args or {})),
            str(summary or "").strip(),
            str(signature or "").strip(),
            STATUS_PENDING,
            now,
            now,
        ),
    )
    get_db().commit()


def list_pending_for_thread(thread_id: str) -> list[dict[str, Any]]:
    tid = str(thread_id or "").strip()
    if not tid:
        return []
    rows = (
        get_db()
        .execute(
            """
        SELECT session_key, thread_id, tool_call_id, tool_name, args_json, summary, signature,
               status, created_at, updated_at
        FROM evoflow_tool_approvals
        WHERE thread_id = ? AND status = ?
        ORDER BY created_at ASC
        """,
            (tid, STATUS_PENDING),
        )
        .fetchall()
    )
    return [_row_to_entry(dict(r)) for r in rows]


def thread_has_pending_approvals(thread_id: str) -> bool:
    """Cheap existence probe (indexed LIMIT 1) for stream defer / hot paths."""
    tid = str(thread_id or "").strip()
    if not tid:
        return False
    row = get_db().execute(
        """
        SELECT 1 FROM evoflow_tool_approvals
        WHERE thread_id = ? AND status = ?
        LIMIT 1
        """,
        (tid, STATUS_PENDING),
    ).fetchone()
    return row is not None


def get_approval_row(session_key: str, tool_call_id: str) -> dict[str, Any] | None:
    sk = str(session_key or "").strip()
    tc_id = str(tool_call_id or "").strip()
    if not sk or not tc_id:
        return None
    row = (
        get_db()
        .execute(
            """
            SELECT session_key, thread_id, tool_call_id, tool_name, args_json, summary, signature,
                   status, created_at, updated_at
            FROM evoflow_tool_approvals
            WHERE session_key = ? AND tool_call_id = ?
            """,
            (sk, tc_id),
        )
        .fetchone()
    )
    return _row_to_entry(dict(row)) if row else None


def set_approval_status(session_key: str, tool_call_id: str, status: str) -> bool:
    sk = str(session_key or "").strip()
    tc_id = str(tool_call_id or "").strip()
    if not sk or not tc_id:
        return False
    cur = get_db().execute(
        """
        UPDATE evoflow_tool_approvals
        SET status = ?, updated_at = ?
        WHERE session_key = ? AND tool_call_id = ?
        """,
        (str(status or "").strip(), utc_now_iso_z(), sk, tc_id),
    )
    get_db().commit()
    return int(cur.rowcount or 0) > 0


def list_denied_for_thread(thread_id: str) -> list[dict[str, Any]]:
    """Denied rows for this thread (newest batches typically still STATUS_DENIED)."""
    tid = str(thread_id or "").strip()
    if not tid:
        return []
    rows = (
        get_db()
        .execute(
            """
            SELECT session_key, thread_id, tool_call_id, tool_name, args_json, summary, signature,
                   status, created_at, updated_at
            FROM evoflow_tool_approvals
            WHERE thread_id = ? AND status = ?
            ORDER BY created_at ASC
            """,
            (tid, STATUS_DENIED),
        )
        .fetchall()
    )
    return [_row_to_entry(dict(r)) for r in rows]


def list_approved_for_replay(thread_id: str, tool_call_ids: list[str] | None = None) -> list[dict[str, Any]]:
    tid = str(thread_id or "").strip()
    if not tid:
        return []
    want = [str(x).strip() for x in (tool_call_ids or []) if str(x).strip()]
    if want:
        placeholders = ",".join("?" * len(want))
        rows = (
            get_db()
            .execute(
                f"""
            SELECT session_key, thread_id, tool_call_id, tool_name, args_json, summary, signature,
                   status, created_at, updated_at
            FROM evoflow_tool_approvals
            WHERE thread_id = ? AND status = ? AND tool_call_id IN ({placeholders})
            ORDER BY created_at ASC
            """,
                (tid, STATUS_APPROVED, *want),
            )
            .fetchall()
        )
    else:
        rows = (
            get_db()
            .execute(
                """
            SELECT session_key, thread_id, tool_call_id, tool_name, args_json, summary, signature,
                   status, created_at, updated_at
            FROM evoflow_tool_approvals
            WHERE thread_id = ? AND status = ?
            ORDER BY created_at ASC
            """,
                (tid, STATUS_APPROVED),
            )
            .fetchall()
        )
    return [_row_to_entry(dict(r)) for r in rows]


def mark_replay_consumed(session_key: str, tool_call_ids: list[str]) -> None:
    sk = str(session_key or "").strip()
    ids = [str(x).strip() for x in tool_call_ids if str(x).strip()]
    if not sk or not ids:
        return
    placeholders = ",".join("?" * len(ids))
    get_db().execute(
        f"""
        UPDATE evoflow_tool_approvals
        SET status = ?, updated_at = ?
        WHERE session_key = ? AND tool_call_id IN ({placeholders}) AND status = ?
        """,
        (STATUS_EXECUTED, utc_now_iso_z(), sk, *ids, STATUS_APPROVED),
    )
    get_db().commit()


def cancel_pending_and_approved_for_thread(thread_id: str) -> int:
    tid = str(thread_id or "").strip()
    if not tid:
        return 0
    cur = get_db().execute(
        """
        UPDATE evoflow_tool_approvals
        SET status = ?, updated_at = ?
        WHERE thread_id = ? AND status IN (?, ?)
        """,
        (STATUS_CANCELLED, utc_now_iso_z(), tid, STATUS_PENDING, STATUS_APPROVED),
    )
    get_db().commit()
    return int(cur.rowcount or 0)


def cancel_pending_outside_ids(thread_id: str, keep_tool_call_ids: list[str] | None = None) -> int:
    """Cancel PENDING rows for this thread that are not in the current interrupt batch.

    Prevents previous failed/abandoned approval turns from blocking ``await_next``
    / ``replay_ids`` and from polluting SSE after a later resume.
    """
    tid = str(thread_id or "").strip()
    if not tid:
        return 0
    keep = [str(x).strip() for x in (keep_tool_call_ids or []) if str(x).strip()]
    if keep:
        placeholders = ",".join("?" * len(keep))
        cur = get_db().execute(
            f"""
            UPDATE evoflow_tool_approvals
            SET status = ?, updated_at = ?
            WHERE thread_id = ? AND status = ? AND tool_call_id NOT IN ({placeholders})
            """,
            (STATUS_CANCELLED, utc_now_iso_z(), tid, STATUS_PENDING, *keep),
        )
    else:
        cur = get_db().execute(
            """
            UPDATE evoflow_tool_approvals
            SET status = ?, updated_at = ?
            WHERE thread_id = ? AND status = ?
            """,
            (STATUS_CANCELLED, utc_now_iso_z(), tid, STATUS_PENDING),
        )
    get_db().commit()
    return int(cur.rowcount or 0)


def delete_approvals_for_session(session_key: str) -> None:
    sk = str(session_key or "").strip()
    if not sk:
        return
    conn = get_db()
    conn.execute("DELETE FROM evoflow_tool_approvals WHERE session_key = ?", (sk,))
    conn.execute("DELETE FROM evoflow_tool_approval_grants WHERE session_key = ?", (sk,))
    conn.commit()


def delete_approvals_for_thread(thread_id: str) -> None:
    tid = str(thread_id or "").strip()
    if not tid:
        return
    sk = find_session_key_by_thread_id(tid)
    conn = get_db()
    conn.execute("DELETE FROM evoflow_tool_approvals WHERE thread_id = ?", (tid,))
    if sk:
        conn.execute("DELETE FROM evoflow_tool_approval_grants WHERE session_key = ?", (sk,))
    conn.commit()


def expire_stale_pending(thread_id: str, *, max_age_seconds: int = 3600) -> int:
    """Expire pending approvals older than ``max_age_seconds``.

    Returns the number of rows expired (STATUS_PENDING → STATUS_CANCELLED).
    Default 1-hour timeout prevents sessions from hanging indefinitely
    when a user forgets to approve.
    """
    tid = str(thread_id or "").strip()
    if not tid:
        return 0
    cutoff_iso = (
        datetime.now(BEIJING_TZ) - timedelta(seconds=int(max_age_seconds))
    ).isoformat(timespec="microseconds")
    cur = get_db().execute(
        """
        UPDATE evoflow_tool_approvals
        SET status = ?, updated_at = ?
        WHERE thread_id = ? AND status = ? AND created_at < ?
        """,
        (STATUS_CANCELLED, utc_now_iso_z(), tid, STATUS_PENDING, cutoff_iso),
    )
    get_db().commit()
    return int(cur.rowcount or 0)


def write_audit_log(
    *,
    session_key: str,
    thread_id: str,
    tool_call_id: str,
    tool_name: str,
    args: dict[str, Any],
    action: str,
    user_source: str = "ui",
) -> None:
    """Write an audit record for an approval decision (approve / deny / grant_all)."""
    sk = str(session_key or "").strip()
    tid = str(thread_id or "").strip()
    if not sk or not tid:
        return
    get_db().execute(
        """
        INSERT INTO evoflow_tool_approval_audit
            (session_key, thread_id, tool_call_id, tool_name, args_json, action, user_source, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            sk,
            tid,
            str(tool_call_id or "").strip(),
            str(tool_name or "").strip(),
            _dumps(dict(args or {})),
            str(action or "").strip(),
            str(user_source or "").strip(),
            utc_now_iso_z(),
        ),
    )
    get_db().commit()
