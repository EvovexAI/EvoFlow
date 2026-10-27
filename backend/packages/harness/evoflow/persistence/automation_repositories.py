"""Scheduled automations (cron / once) in ``evoflow_automations``."""

from __future__ import annotations

import logging
import time
from datetime import datetime
from typing import Any

from evoflow.persistence.db import get_db, run_db_transaction
from evoflow.persistence.row_mappers import (
    automation_doc_to_row,
    automation_row_to_doc,
    automation_run_doc_to_row,
    automation_run_row_to_doc,
)
from evoflow.timeutil import utc_now_iso_z

logger = logging.getLogger(__name__)


def _row_dict(row: Any) -> dict[str, Any]:
    return {k: row[k] for k in row.keys()}


_AUTOMATION_COLS = """
    task_id, name, prompt, schedule, rrule, scheduled_at, status, schedule_type,
    workspace, valid_from, valid_until, max_duration_minutes,
    feishu_push_enabled, langgraph_run, langgraph_thread_mode, langgraph_thread_id,
    langgraph_timeout_seconds, once_fired, created_at, last_run, last_status, run_count,
    extra_json, updated_at
"""


def list_automations() -> list[tuple[str, dict[str, Any]]]:
    rows = get_db().execute(f"SELECT {_AUTOMATION_COLS.strip()} FROM evoflow_automations ORDER BY task_id").fetchall()
    return [(str(r["task_id"]), automation_row_to_doc(_row_dict(r))) for r in rows]


def load_automation(task_id: str) -> dict[str, Any] | None:
    row = (
        get_db()
        .execute(
            f"SELECT {_AUTOMATION_COLS.strip()} FROM evoflow_automations WHERE task_id = ?",
            (task_id.strip(),),
        )
        .fetchone()
    )
    if not row:
        return None
    return automation_row_to_doc(_row_dict(row))


def save_automation(task_id: str, document: dict[str, Any]) -> None:
    r = automation_doc_to_row(task_id, document)
    now = utc_now_iso_z()
    get_db().execute(
        f"""
        INSERT INTO evoflow_automations ({_AUTOMATION_COLS.strip()})
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(task_id) DO UPDATE SET
            name = excluded.name,
            prompt = excluded.prompt,
            schedule = excluded.schedule,
            rrule = excluded.rrule,
            scheduled_at = excluded.scheduled_at,
            status = excluded.status,
            schedule_type = excluded.schedule_type,
            workspace = excluded.workspace,
            valid_from = excluded.valid_from,
            valid_until = excluded.valid_until,
            max_duration_minutes = excluded.max_duration_minutes,
            feishu_push_enabled = excluded.feishu_push_enabled,
            langgraph_run = excluded.langgraph_run,
            langgraph_thread_mode = excluded.langgraph_thread_mode,
            langgraph_thread_id = excluded.langgraph_thread_id,
            langgraph_timeout_seconds = excluded.langgraph_timeout_seconds,
            once_fired = excluded.once_fired,
            created_at = excluded.created_at,
            last_run = excluded.last_run,
            last_status = excluded.last_status,
            run_count = excluded.run_count,
            extra_json = excluded.extra_json,
            updated_at = excluded.updated_at
        """,
        (
            r["task_id"],
            r["name"],
            r["prompt"],
            r["schedule"],
            r["rrule"],
            r["scheduled_at"],
            r["status"],
            r["schedule_type"],
            r["workspace"],
            r["valid_from"],
            r["valid_until"],
            r["max_duration_minutes"],
            r["feishu_push_enabled"],
            r["langgraph_run"],
            r["langgraph_thread_mode"],
            r["langgraph_thread_id"],
            r["langgraph_timeout_seconds"],
            r["once_fired"],
            r["created_at"],
            r["last_run"],
            r["last_status"],
            r["run_count"],
            r["extra_json"],
            now,
        ),
    )
    get_db().commit()


def delete_automation(task_id: str) -> bool:
    tid = task_id.strip()

    # run_db_transaction (not bare execute+commit): an open implicit transaction
    # leaked by anything above would be rolled back by the next BEGIN IMMEDIATE,
    # resurrecting the rows we just deleted.
    def _delete(db: Any) -> bool:
        cur = db.execute("DELETE FROM evoflow_automations WHERE task_id = ?", (tid,))
        db.execute("DELETE FROM evoflow_automation_runs WHERE task_id = ?", (tid,))
        return cur.rowcount > 0

    return bool(run_db_transaction(_delete))


def set_automation_owner_scope(
    task_id: str,
    *,
    org_id: str,
    owner_scope_id: str,
    created_by: str | None = None,
) -> None:
    tid = str(task_id or "").strip()
    if not tid:
        return
    cols = {str(r[1]) for r in get_db().execute("PRAGMA table_info(evoflow_automations)").fetchall()}
    if "owner_scope_id" not in cols:
        return
    if "created_by" in cols and created_by:
        get_db().execute(
            """
            UPDATE evoflow_automations
            SET org_id = COALESCE(NULLIF(org_id, ''), ?),
                owner_scope_id = COALESCE(NULLIF(owner_scope_id, ''), ?),
                created_by = COALESCE(NULLIF(created_by, ''), ?)
            WHERE task_id = ?
            """,
            (org_id, owner_scope_id, created_by, tid),
        )
    else:
        get_db().execute(
            """
            UPDATE evoflow_automations
            SET org_id = COALESCE(NULLIF(org_id, ''), ?),
                owner_scope_id = COALESCE(NULLIF(owner_scope_id, ''), ?)
            WHERE task_id = ?
            """,
            (org_id, owner_scope_id, tid),
        )
    get_db().commit()


def get_automation_owner_scope(task_id: str) -> tuple[str | None, str | None]:
    tid = str(task_id or "").strip()
    if not tid:
        return None, None
    cols = {str(r[1]) for r in get_db().execute("PRAGMA table_info(evoflow_automations)").fetchall()}
    if "owner_scope_id" not in cols:
        return None, None
    row = (
        get_db()
        .execute(
            "SELECT org_id, owner_scope_id FROM evoflow_automations WHERE task_id = ?",
            (tid,),
        )
        .fetchone()
    )
    if not row:
        return None, None
    return (str(row[0] or "").strip() or None, str(row[1] or "").strip() or None)


def automation_visible_to_principal(
    task_id: str,
    *,
    is_admin: bool = False,
    personal_scope: str | None = None,
    org_scope: str | None = None,
    principal: Any = None,
) -> bool:
    from evoflow.authz.resource_visibility import owner_scope_visible_to_principal

    _org, owner = get_automation_owner_scope(task_id)
    return owner_scope_visible_to_principal(
        owner,
        principal,
        is_admin=is_admin,
        personal_scope=personal_scope,
        org_scope=org_scope,
    )


def automation_count() -> int:
    row = get_db().execute("SELECT COUNT(*) FROM evoflow_automations").fetchone()
    return int(row[0]) if row else 0


# --- Scheduler slot claims (cross-process, minute-level dedupe) ---

# A claim older than this is considered abandoned (owner crashed mid-run).
SLOT_CLAIM_STALE_MS_DEFAULT = 900_000  # 15 minutes


def claim_automation_slot(
    task_id: str,
    slot: str,
    *,
    run_id: str = "",
    trigger_type: str = "",
    owner: str = "",
    stale_after_ms: int = SLOT_CLAIM_STALE_MS_DEFAULT,
) -> dict[str, Any]:
    """Atomically claim ``(task_id, slot)`` — the cross-process dedupe gate.

    Two scheduler processes (desktop sidecar + dev gateway) ticking in the
    same minute both call this; exactly one wins because the INSERT runs
    inside a ``BEGIN IMMEDIATE`` transaction and the primary key
    ``(task_id, slot)`` rejects the loser.

    Returns::

        {"claimed": bool, "reason": str, "state": str, "attempts": int}

    ``reason`` is ``"claimed"`` / ``"duplicate"`` / ``"stale_takeover"``.
    """
    from evoflow.persistence.db import run_db_transaction

    tid = str(task_id or "").strip()
    sl = str(slot or "").strip()
    if not tid or not sl:
        return {"claimed": False, "reason": "empty", "state": "", "attempts": 0}

    now_ms = int(time.time() * 1000)
    now_iso = utc_now_iso_z()

    def _do(db: Any) -> dict[str, Any]:
        cur = db.execute(
            """
            INSERT INTO evoflow_automation_slot_claims (
                task_id, slot, state, run_id, trigger_type, owner,
                attempts, claimed_at, claimed_at_ms, completed_at, updated_at
            ) VALUES (?, ?, 'claimed', ?, ?, ?, 1, ?, ?, '', ?)
            ON CONFLICT(task_id, slot) DO NOTHING
            """,
            (tid, sl, run_id, trigger_type, owner, now_iso, now_ms, now_iso),
        )
        if int(cur.rowcount or 0) > 0:
            return {"claimed": True, "reason": "claimed", "state": "claimed", "attempts": 1}

        row = db.execute(
            "SELECT state, attempts, claimed_at_ms FROM evoflow_automation_slot_claims "
            "WHERE task_id = ? AND slot = ?",
            (tid, sl),
        ).fetchone()
        if row is None:
            # Row vanished between INSERT and SELECT (retention / manual cleanup).
            return {"claimed": False, "reason": "duplicate", "state": "", "attempts": 0}

        state = str(row["state"] or "")
        attempts = int(row["attempts"] or 0)
        claimed_ms = int(row["claimed_at_ms"] or 0)
        age_ms = now_ms - claimed_ms if claimed_ms else 0

        # A 'claimed' row that never completed means the owner died mid-run.
        # Re-running is unsafe (side effects may already have happened), so we
        # only reconcile the row to 'abandoned' and report it — the caller
        # decides whether to re-run (catch-up only fills *missing* slots).
        if state == "claimed" and stale_after_ms > 0 and age_ms > stale_after_ms:
            db.execute(
                "UPDATE evoflow_automation_slot_claims SET state = 'abandoned', updated_at = ? "
                "WHERE task_id = ? AND slot = ? AND state = 'claimed'",
                (now_iso, tid, sl),
            )
            return {
                "claimed": False,
                "reason": "abandoned",
                "state": "abandoned",
                "attempts": attempts,
            }

        return {"claimed": False, "reason": "duplicate", "state": state, "attempts": attempts}

    try:
        return run_db_transaction(_do)
    except Exception:
        # Never let a dedupe failure cause a double run: fail closed.
        logger.exception("automation slot claim failed task_id=%s slot=%s", tid, sl)
        return {"claimed": False, "reason": "error", "state": "", "attempts": 0}


def complete_automation_slot(
    task_id: str,
    slot: str,
    *,
    status: str = "done",
    run_id: str = "",
) -> None:
    """Mark a claimed slot as finished (``done`` / ``failed``)."""
    from evoflow.persistence.db import run_db_transaction

    tid = str(task_id or "").strip()
    sl = str(slot or "").strip()
    if not tid or not sl:
        return
    now_iso = utc_now_iso_z()

    def _do(db: Any) -> None:
        db.execute(
            "UPDATE evoflow_automation_slot_claims "
            "SET state = ?, completed_at = ?, updated_at = ? "
            "WHERE task_id = ? AND slot = ?",
            (status, now_iso, now_iso, tid, sl),
        )

    try:
        run_db_transaction(_do)
    except Exception:
        logger.debug("automation slot completion failed task_id=%s slot=%s", tid, sl, exc_info=True)


def list_automation_slot_claims(
    task_id: str,
    *,
    since_slot: str = "",
    limit: int = 500,
) -> list[dict[str, Any]]:
    """Slot-claim rows for one automation (newest first)."""
    rows = (
        get_db()
        .execute(
            "SELECT task_id, slot, state, run_id, trigger_type, owner, attempts, "
            "claimed_at, claimed_at_ms, completed_at FROM evoflow_automation_slot_claims "
            "WHERE task_id = ? AND slot >= ? ORDER BY slot DESC LIMIT ?",
            (str(task_id or "").strip(), str(since_slot or ""), max(1, int(limit))),
        )
        .fetchall()
    )
    return [_row_dict(r) for r in rows]


def list_automation_slot_claim_slots(
    task_id: str,
    *,
    since_slot: str = "",
    limit: int = 2000,
) -> set[str]:
    """Set of slots already claimed for one automation (for catch-up gap detection)."""
    rows = (
        get_db()
        .execute(
            "SELECT slot FROM evoflow_automation_slot_claims "
            "WHERE task_id = ? AND slot >= ? ORDER BY slot ASC LIMIT ?",
            (str(task_id or "").strip(), str(since_slot or ""), max(1, int(limit))),
        )
        .fetchall()
    )
    return {str(r["slot"] or "") for r in rows}


# --- Scheduler state (small key/value; survives restarts) ---


def get_automation_scheduler_state(key: str) -> str:
    row = get_db().execute("SELECT v FROM evoflow_automation_scheduler_state WHERE k = ?", (str(key),)).fetchone()
    return str(row["v"]) if row else ""


def set_automation_scheduler_state(key: str, value: str) -> None:
    from evoflow.persistence.db import run_db_transaction

    k = str(key or "").strip()
    if not k:
        return
    now_iso = utc_now_iso_z()
    now_ms = int(time.time() * 1000)

    def _do(db: Any) -> None:
        db.execute(
            "INSERT INTO evoflow_automation_scheduler_state (k, v, updated_at, updated_at_ms) "
            "VALUES (?, ?, ?, ?) ON CONFLICT(k) DO UPDATE SET "
            "v = excluded.v, updated_at = excluded.updated_at, updated_at_ms = excluded.updated_at_ms",
            (k, str(value or ""), now_iso, now_ms),
        )

    try:
        run_db_transaction(_do)
    except Exception:
        logger.debug("automation scheduler state write failed key=%s", k, exc_info=True)


def list_automation_run_times(
    task_id: str,
    *,
    since_iso: str = "",
    limit: int = 500,
) -> list[datetime]:
    """Local-naive start times of recorded runs for one automation (newest first).

    Used by catch-up so a slot that already ran — e.g. before the claim table
    existed, or after the claim row was lost — is never fired a second time.
    """
    rows = (
        get_db()
        .execute(
            "SELECT started_at FROM evoflow_automation_runs "
            "WHERE task_id = ? AND started_at >= ? ORDER BY id DESC LIMIT ?",
            (str(task_id or "").strip(), str(since_iso or ""), max(1, int(limit))),
        )
        .fetchall()
    )
    out: list[datetime] = []
    for r in rows:
        raw = str(r["started_at"] or "").strip()
        if not raw:
            continue
        try:
            dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        except ValueError:
            continue
        if dt.tzinfo:
            dt = dt.astimezone().replace(tzinfo=None)
        out.append(dt)
    return out


def append_automation_run(task_id: str, record: dict[str, Any]) -> None:
    from evoflow.persistence.timestamps import coerce_iso_z

    r = automation_run_doc_to_row(record)
    updated = coerce_iso_z(r.get("started_at"), now_if_empty=True)
    get_db().execute(
        """
        INSERT INTO evoflow_automation_runs (
            task_id, run_id, started_at, trigger_type, status, output, error,
            duration_seconds, langgraph_thread_id, langgraph_run, extra_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            task_id.strip(),
            r["run_id"],
            r["started_at"],
            r["trigger_type"],
            r["status"],
            r["output"],
            r["error"],
            r["duration_seconds"],
            r["langgraph_thread_id"],
            r["langgraph_run"],
            r["extra_json"],
            updated,
        ),
    )
    get_db().commit()


def list_automation_runs(task_id: str, *, limit: int = 50, offset: int = 0) -> list[dict[str, Any]]:
    rows = (
        get_db()
        .execute(
            """
        SELECT run_id, started_at, trigger_type, status, output, error,
               duration_seconds, langgraph_thread_id, langgraph_run, extra_json
        FROM evoflow_automation_runs
        WHERE task_id = ?
        ORDER BY id DESC
        LIMIT ? OFFSET ?
        """,
            (task_id.strip(), int(limit), int(offset)),
        )
        .fetchall()
    )
    return [_automation_run_doc_light(_row_dict(row)) for row in rows]


def list_recent_automation_runs(*, limit: int = 200, output_max: int = 400) -> list[dict[str, Any]]:
    """Newest runs across all automations (one query). Truncate ``output`` for list UIs."""
    lim = max(1, min(int(limit or 200), 500))
    out_max = max(0, min(int(output_max or 400), 2000))
    rows = (
        get_db()
        .execute(
            """
        SELECT task_id, run_id, started_at, trigger_type, status,
               substr(COALESCE(output, ''), 1, ?) AS output,
               error, duration_seconds, langgraph_thread_id, langgraph_run, extra_json
        FROM evoflow_automation_runs
        ORDER BY id DESC
        LIMIT ?
        """,
            (out_max, lim),
        )
        .fetchall()
    )
    out: list[dict[str, Any]] = []
    for row in rows:
        doc = _automation_run_doc_light(_row_dict(row))
        doc["task_id"] = str(row["task_id"] or "").strip()
        out.append(doc)
    return out


def _automation_run_doc_light(row: dict[str, Any]) -> dict[str, Any]:
    """Map a run row and cap ``output`` / ``error`` so history payloads stay small."""
    doc = automation_run_row_to_doc(row)
    for key, cap in (("output", 800), ("error", 400)):
        val = doc.get(key)
        if isinstance(val, str) and len(val) > cap:
            doc[key] = val[:cap]
    return doc


def count_automation_runs(task_id: str) -> int:
    row = (
        get_db()
        .execute(
            "SELECT COUNT(*) FROM evoflow_automation_runs WHERE task_id = ?",
            (task_id.strip(),),
        )
        .fetchone()
    )
    return int(row[0]) if row else 0
