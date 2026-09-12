"""Run status and token totals on ``evoflow_chat_sessions`` (sidebar source of truth).

Gateway and agents should prefer ``evoflow.session_execution.lifecycle`` for
``start_session_turn`` / ``end_session_turn`` instead of calling these helpers directly.

DB ``run_status`` uses terminal outcomes (``done``, ``cancelled``, ``fail``, …),
not ``idle``. ``idle`` is legacy read-only and normalized to ``done``.
"""

from __future__ import annotations

import logging
from typing import Any

from evoflow.persistence.db import get_db, run_db_transaction
from evoflow.persistence.session_repositories import find_session_key_by_thread_id
from evoflow.timeutil import utc_now_iso_z

logger = logging.getLogger(__name__)

RUN_STATUS_RUNNING = "running"
RUN_STATUS_PENDING = "pending"
RUN_STATUS_DONE = "done"
RUN_STATUS_SUCCESS = "success"
RUN_STATUS_FAIL = "fail"
RUN_STATUS_ERROR = "error"
RUN_STATUS_CANCELLED = "cancelled"
RUN_STATUS_STOPPED = "stopped"

# Legacy — never written to DB; normalized on read.
RUN_STATUS_IDLE = "idle"

_ACTIVE_RUN_STATUSES = frozenset({RUN_STATUS_RUNNING, RUN_STATUS_PENDING})
_TERMINAL_RUN_STATUSES = frozenset(
    {
        RUN_STATUS_DONE,
        RUN_STATUS_SUCCESS,
        RUN_STATUS_FAIL,
        RUN_STATUS_ERROR,
        RUN_STATUS_CANCELLED,
        RUN_STATUS_STOPPED,
        "completed",
        RUN_STATUS_IDLE,
    }
)


def normalize_run_status(status: str | None) -> str:
    """Map legacy/empty DB values to a terminal outcome for API reads."""
    st = str(status or "").strip().lower()
    if not st or st == RUN_STATUS_IDLE:
        return RUN_STATUS_DONE
    if st in _ACTIVE_RUN_STATUSES:
        return st
    if st == "completed":
        return RUN_STATUS_DONE
    return st


def resolve_terminal_run_status(*, reason: str = "", source: str = "") -> str:
    """Pick a DB terminal status from lifecycle reason/source."""
    r = str(reason or "").strip().lower()
    s = str(source or "").strip().lower()
    blob = f"{r} {s}"
    if r in {"user_stop", "client_disconnect", "client_restart", "client_attach", "cancelled", "stopped", "stop"}:
        return RUN_STATUS_CANCELLED
    if "client_disconnect" in blob or "client_restart" in blob or "client_attach" in blob:
        return RUN_STATUS_CANCELLED
    if "user_stop" in blob:
        return RUN_STATUS_CANCELLED
    if r in {"error", "fail", "failed"} or s in {"error", "fail", "failed"}:
        return RUN_STATUS_FAIL
    if r in {"success"} or s in {"success"}:
        return RUN_STATUS_SUCCESS
    return RUN_STATUS_DONE


def derive_execution_phase(run_status: str | None) -> str:
    """Runtime phase for API: active statuses pass through; else normalized terminal."""
    st = str(run_status or "").strip().lower()
    if st in _ACTIVE_RUN_STATUSES:
        return st
    return normalize_run_status(st)


def _coerce_terminal_status(terminal_status: str | None, *, reason: str = "", source: str = "") -> str:
    st = str(terminal_status or "").strip().lower()
    if not st or st == RUN_STATUS_IDLE or st in _ACTIVE_RUN_STATUSES:
        st = resolve_terminal_run_status(reason=reason, source=source)
    if st == RUN_STATUS_IDLE or st in _ACTIVE_RUN_STATUSES:
        st = RUN_STATUS_DONE
    return st


def _resolve_session_key(*, session_key: str | None = None, thread_id: str | None = None) -> str | None:
    sk = str(session_key or "").strip()
    if sk:
        return sk
    tid = str(thread_id or "").strip()
    if not tid:
        return None
    return find_session_key_by_thread_id(tid)


def mark_session_run_started(
    *,
    session_key: str | None = None,
    thread_id: str | None = None,
    run_id: str | None = None,
    status: str = RUN_STATUS_RUNNING,
    conn: Any = None,
) -> bool:
    sk = _resolve_session_key(session_key=session_key, thread_id=thread_id)
    if not sk:
        return False
    st = str(status or RUN_STATUS_RUNNING).strip().lower()
    if st not in _ACTIVE_RUN_STATUSES:
        st = RUN_STATUS_RUNNING
    rid = str(run_id or "").strip() or None
    now = utc_now_iso_z()
    existing_rid = peek_current_run_id(session_key=sk, thread_id=thread_id)
    same_run_rebind = bool(rid and existing_rid and rid == existing_rid)

    def _write(db: Any) -> None:
        # Do not touch updated_at: run lifecycle is not chat activity. Startup
        # reconcile clears many running rows with the same clock and would
        # otherwise make every session show the same sidebar update time.
        # Same-run rebind must keep current_turn_started_at (written once per turn).
        if same_run_rebind:
            db.execute(
                """
                UPDATE evoflow_chat_sessions
                SET run_status = ?, current_run_id = ?,
                    current_turn_ended_at = NULL
                WHERE session_key = ? AND is_deleted = 0
                """,
                (st, rid, sk),
            )
        else:
            db.execute(
                """
                UPDATE evoflow_chat_sessions
                SET run_status = ?, current_run_id = ?,
                    current_turn_started_at = ?, current_turn_ended_at = NULL
                WHERE session_key = ? AND is_deleted = 0
                """,
                (st, rid, now, sk),
            )

    if conn is not None:
        _write(conn)
    else:
        run_db_transaction(_write)
    if same_run_rebind:
        return True
    if conn is not None:
        return True
    try:
        from evoflow.persistence.stream_mirror_repositories import clear_mirror

        clear_mirror(sk)
    except Exception:
        logger.debug("clear stream mirror on run start failed session_key=%s", sk, exc_info=True)
    return True


def patch_session_current_run_id(
    *,
    session_key: str | None = None,
    thread_id: str | None = None,
    run_id: str,
) -> bool:
    """Adopt LangGraph run id on an active session without clearing stream mirror."""
    sk = _resolve_session_key(session_key=session_key, thread_id=thread_id)
    rid = str(run_id or "").strip()
    if not sk or not rid:
        return False
    existing = peek_current_run_id(session_key=sk, thread_id=thread_id)
    if existing == rid:
        return True

    tid = str(thread_id or "").strip() or None
    if not tid:
        try:
            from evoflow.persistence.session_repositories import get_session_row_for_ui

            row = get_session_row_for_ui(sk) or {}
            tid = str(row.get("thread_id") or row.get("threadId") or "").strip() or None
        except Exception:
            tid = None

    def _write(db: Any) -> None:
        db.execute(
            """
            UPDATE evoflow_chat_sessions
            SET run_status = ?, current_run_id = ?
            WHERE session_key = ? AND is_deleted = 0
            """,
            (RUN_STATUS_RUNNING, rid, sk),
        )

    run_db_transaction(_write)
    if tid:
        try:
            from evoflow.persistence.stream_mirror_repositories import touch_mirror_meta

            touch_mirror_meta(sk, thread_id=tid, run_id=rid)
        except Exception:
            logger.debug("touch mirror meta on run id patch failed session=%s", sk, exc_info=True)
    return True


def peek_current_run_id(
    *,
    session_key: str | None = None,
    thread_id: str | None = None,
) -> str | None:
    """Read ``current_run_id`` before ``mark_session_run_ended`` clears it."""
    sk = _resolve_session_key(session_key=session_key, thread_id=thread_id)
    if not sk:
        return None
    row = (
        get_db()
        .execute(
            "SELECT current_run_id FROM evoflow_chat_sessions WHERE session_key = ? AND is_deleted = 0",
            (sk,),
        )
        .fetchone()
    )
    if not row:
        return None
    rid = str(row[0] or "").strip()
    return rid or None


def mark_session_run_ended(
    *,
    session_key: str | None = None,
    thread_id: str | None = None,
    terminal_status: str | None = None,
    reason: str = "",
    source: str = "",
    conn: Any = None,
) -> bool:
    sk = _resolve_session_key(session_key=session_key, thread_id=thread_id)
    if not sk:
        logger.warning(
            "mark_session_run_ended: cannot resolve session_key "
            "session_key=%s thread_id=%s — DB run_status NOT updated",
            session_key,
            thread_id,
        )
        return False
    st = _coerce_terminal_status(terminal_status, reason=reason, source=source)
    now = utc_now_iso_z()

    def _write(db: Any) -> None:
        # Keep last-activity updated_at intact (see mark_session_run_started).
        db.execute(
            """
            UPDATE evoflow_chat_sessions
            SET run_status = ?, current_run_id = NULL,
                current_turn_ended_at = ?
            WHERE session_key = ? AND is_deleted = 0
            """,
            (st, now, sk),
        )

    if conn is not None:
        _write(conn)
    else:
        run_db_transaction(_write)
    return True


def add_session_token_usage(
    session_key: str,
    *,
    input_tokens: int = 0,
    output_tokens: int = 0,
    total_tokens: int | None = None,
    cache_read_tokens: int = 0,
    cache_creation_tokens: int = 0,
    cache_miss_tokens: int = 0,
    conn: Any = None,
) -> None:
    sk = str(session_key or "").strip()
    if not sk:
        return
    inp = max(0, int(input_tokens or 0))
    out = max(0, int(output_tokens or 0))
    tot = max(0, int(total_tokens if total_tokens is not None else 0))
    if tot <= 0 and (inp or out):
        tot = inp + out
    cread = max(0, int(cache_read_tokens or 0))
    ccreate = max(0, int(cache_creation_tokens or 0))
    cmiss = max(0, int(cache_miss_tokens or 0))
    if inp <= 0 and out <= 0 and tot <= 0 and cread <= 0 and ccreate <= 0 and cmiss <= 0:
        return

    def _write(db: Any) -> None:
        db.execute(
            """
            UPDATE evoflow_chat_sessions
            SET
                input_tokens = COALESCE(input_tokens, 0) + ?,
                output_tokens = COALESCE(output_tokens, 0) + ?,
                total_tokens = COALESCE(total_tokens, 0) + ?,
                cache_read_tokens = COALESCE(cache_read_tokens, 0) + ?,
                cache_creation_tokens = COALESCE(cache_creation_tokens, 0) + ?,
                cache_miss_tokens = COALESCE(cache_miss_tokens, 0) + ?,
                updated_at = ?
            WHERE session_key = ? AND is_deleted = 0
            """,
            (inp, out, tot, cread, ccreate, cmiss, utc_now_iso_z(), sk),
        )

    if conn is not None:
        _write(conn)
        return
    run_db_transaction(_write)


def list_all_active_sessions(*, limit: int = 500) -> list[dict[str, Any]]:
    """All sessions marked running/pending in SQLite (for startup reconciliation)."""
    lim = max(1, min(int(limit or 500), 2000))
    rows = (
        get_db()
        .execute(
            """
        SELECT session_key, thread_id, current_run_id, run_status
        FROM evoflow_chat_sessions
        WHERE is_deleted = 0
          AND run_status IN ('running', 'pending')
        ORDER BY updated_at DESC
        LIMIT ?
        """,
            (lim,),
        )
        .fetchall()
    )
    out: list[dict[str, Any]] = []
    for row in rows:
        sk = str(row[0] or "").strip()
        if not sk:
            continue
        tid = str(row[1] or "").strip() or None
        rid = str(row[2] or "").strip() or None
        st = str(row[3] or RUN_STATUS_RUNNING).strip().lower() or RUN_STATUS_RUNNING
        out.append(
            {
                "session_key": sk,
                "thread_id": tid,
                "run_id": rid,
                "status": st,
            }
        )
    return out


def list_active_sessions_for_keys(session_keys: list[str]) -> list[dict[str, Any]]:
    """Rows for ``GET /langgraph/active-sessions`` from SQLite (no LangGraph scan)."""
    keys = [str(k).strip() for k in session_keys if str(k).strip()]
    if not keys:
        return []
    placeholders = ",".join("?" * len(keys))
    rows = (
        get_db()
        .execute(
            f"""
        SELECT session_key, thread_id, current_run_id, run_status
        FROM evoflow_chat_sessions
        WHERE is_deleted = 0
          AND session_key IN ({placeholders})
          AND run_status IN ('running', 'pending')
        """,
            keys,
        )
        .fetchall()
    )
    out: list[dict[str, Any]] = []
    for row in rows:
        sk = str(row[0] or "").strip()
        tid = str(row[1] or "").strip() or None
        rid = str(row[2] or "").strip() or None
        st = str(row[3] or RUN_STATUS_RUNNING).strip().lower() or RUN_STATUS_RUNNING
        out.append(
            {
                "session_key": sk,
                "thread_id": tid,
                "run_id": rid,
                "status": st,
                "source": "evoflow_chat_sessions",
            }
        )
    return out


def is_run_status_active(status: str | None) -> bool:
    return str(status or "").strip().lower() in _ACTIVE_RUN_STATUSES


# 用户显式停止后的终态 — reconcile 不得 idle→running heal（LangGraph 取消有延迟时）
_USER_STOP_TERMINAL_STATUSES = frozenset(
    {
        RUN_STATUS_CANCELLED,
        RUN_STATUS_STOPPED,
        "canceled",
        "aborted",
    }
)


def is_user_stop_terminal_status(status: str | None) -> bool:
    """True when DB reflects an explicit user/client stop — do not heal back to running."""
    return str(status or "").strip().lower() in _USER_STOP_TERMINAL_STATUSES
