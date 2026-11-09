"""Session child-work registry + one-shot inject receipts.

Tracks running child work under a chat session (subagent / collab / duty /
warm bash) and durable inject receipts so the same completion/steer is not
re-injected into model context.

Deadlock rules (must keep):
- Never call these APIs while holding warm-bash ``_SESSIONS_LOCK``,
  subagent ``_background_tasks_lock``, pending-inject ``_LOCK``, or
  collab ``main_task_mutation_lock`` / ``ProjectStorage._lock``.
- Capture ids under those locks, release, then write SQLite here.
- All public helpers are best-effort and never raise to callers.
"""

from __future__ import annotations

import json
import logging
import uuid
from typing import Any

from evoflow.persistence.db import get_db, run_db_transaction
from evoflow.persistence.timestamps import now_iso_z

logger = logging.getLogger(__name__)

KIND_SUBAGENT = "subagent"
KIND_COLLAB_SUBTASK = "collab_subtask"
KIND_WORKFLOW = "workflow"
KIND_DUTY = "duty"
KIND_WARM_BASH = "warm_bash"

_ACTIVE_STATUSES = frozenset({"pending", "running"})
_TERMINAL_STATUSES = frozenset(
    {"completed", "failed", "timed_out", "cancelled", "dropped", "superseded", "skipped", "busy"}
)

SOURCE_PENDING_INJECT = "pending_inject"
SOURCE_CHILD_WORK_COMPLETE = "child_work_complete"


def _dumps(obj: Any) -> str:
    return json.dumps(obj if obj is not None else {}, ensure_ascii=False, separators=(",", ":"))


def _loads(raw: str | None) -> dict[str, Any]:
    if not raw:
        return {}
    try:
        out = json.loads(raw)
    except Exception:
        return {}
    return out if isinstance(out, dict) else {}


def _work_id(kind: str, ref_id: str) -> str:
    k = str(kind or "").strip() or "unknown"
    r = str(ref_id or "").strip() or uuid.uuid4().hex[:16]
    return f"{k}:{r}"[:240]


def _row_to_work(row: Any) -> dict[str, Any] | None:
    if row is None:
        return None
    keys = row.keys() if hasattr(row, "keys") else []
    if not keys:
        return None
    d = {str(k): row[k] for k in keys}
    d["extra"] = _loads(str(d.pop("extra_json", None) or ""))
    return d


def _row_to_receipt(row: Any) -> dict[str, Any] | None:
    if row is None:
        return None
    keys = row.keys() if hasattr(row, "keys") else []
    if not keys:
        return None
    d = {str(k): row[k] for k in keys}
    d["detail"] = _loads(str(d.pop("detail_json", None) or ""))
    return d


def resolve_session_key(
    *,
    session_key: str | None = None,
    thread_id: str | None = None,
    parent_thread_id: str | None = None,
) -> str:
    """Resolve product session_key without holding foreign locks."""
    sk = str(session_key or "").strip()
    if sk:
        return sk
    try:
        from evoflow.persistence.session_repositories import find_session_key_by_thread_id
    except Exception:
        return ""
    for tid in (parent_thread_id, thread_id):
        t = str(tid or "").strip()
        if not t:
            continue
        try:
            found = find_session_key_by_thread_id(t)
        except Exception:
            found = None
        if found:
            return str(found).strip()
    return ""


def upsert_child_work(
    *,
    session_key: str,
    kind: str,
    ref_id: str,
    status: str = "running",
    thread_id: str | None = None,
    parent_thread_id: str | None = None,
    title: str = "",
    extra: dict[str, Any] | None = None,
    conn: Any | None = None,
) -> dict[str, Any] | None:
    sk = str(session_key or "").strip()
    k = str(kind or "").strip()
    rid = str(ref_id or "").strip()
    if not sk or not k or not rid:
        return None
    wid = _work_id(k, rid)
    st = str(status or "running").strip().lower() or "running"
    now = now_iso_z()
    tid = str(thread_id or "").strip()
    ptid = str(parent_thread_id or "").strip()
    title_s = str(title or "").strip()[:500]
    ended = now if st in _TERMINAL_STATUSES else None

    def _tx(db: Any) -> dict[str, Any] | None:
        existing = db.execute(
            """
            SELECT work_id, started_at, ended_at, extra_json
            FROM evoflow_session_child_works
            WHERE session_key = ? AND kind = ? AND ref_id = ?
            LIMIT 1
            """,
            (sk, k, rid),
        ).fetchone()
        if existing is not None:
            prev_extra = _loads(str(existing["extra_json"] or ""))
            merged = dict(prev_extra)
            if extra:
                merged.update(extra)
            started = str(existing["started_at"] or now)
            prev_ended = existing["ended_at"]
            ended_at = ended if ended is not None else prev_ended
            db.execute(
                """
                UPDATE evoflow_session_child_works
                SET status = ?, thread_id = CASE WHEN ? != '' THEN ? ELSE thread_id END,
                    parent_thread_id = CASE WHEN ? != '' THEN ? ELSE parent_thread_id END,
                    title = CASE WHEN ? != '' THEN ? ELSE title END,
                    extra_json = ?, updated_at = ?, ended_at = ?
                WHERE work_id = ?
                """,
                (
                    st,
                    tid,
                    tid,
                    ptid,
                    ptid,
                    title_s,
                    title_s,
                    _dumps(merged),
                    now,
                    ended_at,
                    str(existing["work_id"]),
                ),
            )
            row = db.execute(
                "SELECT * FROM evoflow_session_child_works WHERE work_id = ?",
                (str(existing["work_id"]),),
            ).fetchone()
            return _row_to_work(row)
        db.execute(
            """
            INSERT INTO evoflow_session_child_works (
                work_id, session_key, thread_id, parent_thread_id, kind, ref_id,
                status, title, extra_json, started_at, updated_at, ended_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                wid,
                sk,
                tid,
                ptid,
                k,
                rid,
                st,
                title_s,
                _dumps(extra or {}),
                now,
                now,
                ended,
            ),
        )
        row = db.execute(
            "SELECT * FROM evoflow_session_child_works WHERE work_id = ?",
            (wid,),
        ).fetchone()
        return _row_to_work(row)

    if conn is not None:
        return _tx(conn)
    return run_db_transaction(_tx)


def complete_child_work(
    *,
    session_key: str | None = None,
    kind: str,
    ref_id: str,
    status: str = "completed",
    thread_id: str | None = None,
    parent_thread_id: str | None = None,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    st = str(status or "completed").strip().lower() or "completed"
    if st not in _TERMINAL_STATUSES:
        st = "completed"
    sk = resolve_session_key(
        session_key=session_key,
        thread_id=thread_id,
        parent_thread_id=parent_thread_id,
    )
    if not sk:
        # Fall back: update by kind+ref across sessions (rare orphan rows).
        return _complete_by_ref(kind=kind, ref_id=ref_id, status=st, extra=extra)
    return upsert_child_work(
        session_key=sk,
        kind=kind,
        ref_id=ref_id,
        status=st,
        thread_id=thread_id,
        parent_thread_id=parent_thread_id,
        extra=extra,
    )


def _complete_by_ref(
    *,
    kind: str,
    ref_id: str,
    status: str,
    extra: dict[str, Any] | None,
) -> dict[str, Any] | None:
    k = str(kind or "").strip()
    rid = str(ref_id or "").strip()
    if not k or not rid:
        return None
    now = now_iso_z()

    def _tx(db: Any) -> dict[str, Any] | None:
        row = db.execute(
            """
            SELECT work_id, extra_json FROM evoflow_session_child_works
            WHERE kind = ? AND ref_id = ?
            ORDER BY updated_at DESC LIMIT 1
            """,
            (k, rid),
        ).fetchone()
        if row is None:
            return None
        merged = _loads(str(row["extra_json"] or ""))
        if extra:
            merged.update(extra)
        db.execute(
            """
            UPDATE evoflow_session_child_works
            SET status = ?, extra_json = ?, updated_at = ?, ended_at = ?
            WHERE work_id = ?
            """,
            (status, _dumps(merged), now, now, str(row["work_id"])),
        )
        out = db.execute(
            "SELECT * FROM evoflow_session_child_works WHERE work_id = ?",
            (str(row["work_id"]),),
        ).fetchone()
        return _row_to_work(out)

    return run_db_transaction(_tx)


def list_child_works(
    session_key: str,
    *,
    active_only: bool = False,
    limit: int = 50,
) -> list[dict[str, Any]]:
    sk = str(session_key or "").strip()
    if not sk:
        return []
    lim = max(1, min(int(limit or 50), 200))
    db = get_db()
    if active_only:
        rows = db.execute(
            f"""
            SELECT * FROM evoflow_session_child_works
            WHERE session_key = ? AND status IN ({",".join("?" * len(_ACTIVE_STATUSES))})
            ORDER BY updated_at DESC
            LIMIT ?
            """,
            (sk, *_ACTIVE_STATUSES, lim),
        ).fetchall()
    else:
        rows = db.execute(
            """
            SELECT * FROM evoflow_session_child_works
            WHERE session_key = ?
            ORDER BY updated_at DESC
            LIMIT ?
            """,
            (sk, lim),
        ).fetchall()
    out: list[dict[str, Any]] = []
    for row in rows or []:
        item = _row_to_work(row)
        if item:
            out.append(item)
    return out


def list_uninjected_completed_child_works(
    session_key: str,
    *,
    limit: int = 10,
) -> list[dict[str, Any]]:
    """Completed child works that have no inject receipt yet."""
    sk = str(session_key or "").strip()
    if not sk:
        return []
    lim = max(1, min(int(limit or 10), 50))
    db = get_db()
    rows = db.execute(
        """
        SELECT w.*
        FROM evoflow_session_child_works w
        LEFT JOIN evoflow_session_inject_receipts r
          ON r.session_key = w.session_key
         AND r.source_kind = ?
         AND r.source_ref = w.work_id
        WHERE w.session_key = ?
          AND w.status IN ('completed', 'failed', 'timed_out', 'cancelled')
          AND r.receipt_id IS NULL
        ORDER BY w.ended_at DESC, w.updated_at DESC
        LIMIT ?
        """,
        (SOURCE_CHILD_WORK_COMPLETE, sk, lim),
    ).fetchall()
    out: list[dict[str, Any]] = []
    for row in rows or []:
        item = _row_to_work(row)
        if item:
            out.append(item)
    return out


def has_inject_receipt(
    session_key: str,
    source_kind: str,
    source_ref: str,
) -> bool:
    sk = str(session_key or "").strip()
    kind = str(source_kind or "").strip()
    ref = str(source_ref or "").strip()
    if not sk or not kind or not ref:
        return False
    row = get_db().execute(
        """
        SELECT 1 FROM evoflow_session_inject_receipts
        WHERE session_key = ? AND source_kind = ? AND source_ref = ?
        LIMIT 1
        """,
        (sk, kind, ref),
    ).fetchone()
    return row is not None


def try_claim_inject(
    session_key: str,
    source_kind: str,
    source_ref: str,
    *,
    consumed_by_run_id: str | None = None,
    detail: dict[str, Any] | None = None,
) -> bool:
    """Atomically claim a one-shot inject. True = caller should inject now."""
    sk = str(session_key or "").strip()
    kind = str(source_kind or "").strip()
    ref = str(source_ref or "").strip()
    if not sk or not kind or not ref:
        return False
    now = now_iso_z()
    receipt_id = f"inj_{uuid.uuid4().hex[:20]}"
    run_id = str(consumed_by_run_id or "").strip()

    def _tx(db: Any) -> bool:
        existing = db.execute(
            """
            SELECT receipt_id FROM evoflow_session_inject_receipts
            WHERE session_key = ? AND source_kind = ? AND source_ref = ?
            LIMIT 1
            """,
            (sk, kind, ref),
        ).fetchone()
        if existing is not None:
            return False
        try:
            db.execute(
                """
                INSERT INTO evoflow_session_inject_receipts (
                    receipt_id, session_key, source_kind, source_ref,
                    injected_at, consumed_by_run_id, detail_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (receipt_id, sk, kind, ref, now, run_id, _dumps(detail or {})),
            )
        except Exception:
            # Unique race: another writer claimed first.
            return False
        return True

    return bool(run_db_transaction(_tx))


def record_inject_receipt(
    session_key: str,
    source_kind: str,
    source_ref: str,
    *,
    consumed_by_run_id: str | None = None,
    detail: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    """Record that an inject already happened (idempotent)."""
    sk = str(session_key or "").strip()
    kind = str(source_kind or "").strip()
    ref = str(source_ref or "").strip()
    if not sk or not kind or not ref:
        return None
    now = now_iso_z()
    receipt_id = f"inj_{uuid.uuid4().hex[:20]}"
    run_id = str(consumed_by_run_id or "").strip()

    def _tx(db: Any) -> dict[str, Any] | None:
        existing = db.execute(
            """
            SELECT * FROM evoflow_session_inject_receipts
            WHERE session_key = ? AND source_kind = ? AND source_ref = ?
            LIMIT 1
            """,
            (sk, kind, ref),
        ).fetchone()
        if existing is not None:
            return _row_to_receipt(existing)
        db.execute(
            """
            INSERT INTO evoflow_session_inject_receipts (
                receipt_id, session_key, source_kind, source_ref,
                injected_at, consumed_by_run_id, detail_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (receipt_id, sk, kind, ref, now, run_id, _dumps(detail or {})),
        )
        row = db.execute(
            "SELECT * FROM evoflow_session_inject_receipts WHERE receipt_id = ?",
            (receipt_id,),
        ).fetchone()
        return _row_to_receipt(row)

    return run_db_transaction(_tx)


# --- best-effort wrappers (wire sites) ---------------------------------


def safe_register_child_work(**kwargs: Any) -> dict[str, Any] | None:
    try:
        sk = resolve_session_key(
            session_key=kwargs.get("session_key"),
            thread_id=kwargs.get("thread_id"),
            parent_thread_id=kwargs.get("parent_thread_id"),
        )
        if not sk:
            return None
        kwargs = dict(kwargs)
        kwargs["session_key"] = sk
        return upsert_child_work(**kwargs)
    except Exception:
        logger.debug("session_runtime: register child work failed", exc_info=True)
        return None


def safe_complete_child_work(**kwargs: Any) -> dict[str, Any] | None:
    try:
        return complete_child_work(**kwargs)
    except Exception:
        logger.debug("session_runtime: complete child work failed", exc_info=True)
        return None


def safe_record_inject_receipt(**kwargs: Any) -> dict[str, Any] | None:
    try:
        return record_inject_receipt(**kwargs)
    except Exception:
        logger.debug("session_runtime: record inject receipt failed", exc_info=True)
        return None


def safe_try_claim_inject(*args: Any, **kwargs: Any) -> bool:
    try:
        return try_claim_inject(*args, **kwargs)
    except Exception:
        logger.debug("session_runtime: try_claim_inject failed", exc_info=True)
        return False


def delete_inject_receipt(
    session_key: str,
    source_kind: str,
    source_ref: str,
) -> bool:
    """Release a claim so a failed delivery can retry (hydration / next push)."""
    sk = str(session_key or "").strip()
    kind = str(source_kind or "").strip()
    ref = str(source_ref or "").strip()
    if not sk or not kind or not ref:
        return False

    def _tx(db: Any) -> bool:
        cur = db.execute(
            """
            DELETE FROM evoflow_session_inject_receipts
            WHERE session_key = ? AND source_kind = ? AND source_ref = ?
            """,
            (sk, kind, ref),
        )
        return int(cur.rowcount or 0) > 0

    return bool(run_db_transaction(_tx))


def safe_delete_inject_receipt(*args: Any, **kwargs: Any) -> bool:
    try:
        return delete_inject_receipt(*args, **kwargs)
    except Exception:
        logger.debug("session_runtime: delete_inject_receipt failed", exc_info=True)
        return False


def child_works_for_execution_state(session_key: str) -> list[dict[str, Any]]:
    """Compact list for ``execution/state`` (active + recent terminal)."""
    sk = str(session_key or "").strip()
    if not sk:
        return []
    try:
        active = list_child_works(sk, active_only=True, limit=30)
        recent = list_child_works(sk, active_only=False, limit=20)
    except Exception:
        logger.debug("session_runtime: list child works failed", exc_info=True)
        return []
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for item in active + recent:
        wid = str(item.get("work_id") or "")
        if not wid or wid in seen:
            continue
        seen.add(wid)
        extra = item.get("extra") if isinstance(item.get("extra"), dict) else {}
        out.append(
            {
                "workId": wid,
                "kind": item.get("kind"),
                "refId": item.get("ref_id"),
                "status": item.get("status"),
                "title": item.get("title") or "",
                "threadId": item.get("thread_id") or "",
                "parentThreadId": item.get("parent_thread_id") or "",
                "startedAt": item.get("started_at"),
                "updatedAt": item.get("updated_at"),
                "endedAt": item.get("ended_at"),
                "extra": extra,
            }
        )
        if len(out) >= 40:
            break
    return out
