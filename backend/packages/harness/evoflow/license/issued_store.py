"""Persist issued activation codes for ops ledger UI / CLI."""

from __future__ import annotations

import time
import uuid
from typing import Any

from evoflow.license.codec import code_fingerprint, normalize_activation_code
from evoflow.persistence.db import get_db, run_db_transaction
from evoflow.timeutil import unix_to_beijing_iso, utc_now_iso_z

STATUS_ACTIVE = "active"
STATUS_REVOKED = "revoked"
STATUS_EXPIRED = "expired"


def _row_to_dict(row: Any) -> dict[str, Any]:
    if row is None:
        return {}
    if hasattr(row, "keys"):
        return {k: row[k] for k in row.keys()}
    return dict(row)


def _effective_status(stored: str, expires_at_unix: int, *, now: int | None = None) -> str:
    st = str(stored or STATUS_ACTIVE).strip() or STATUS_ACTIVE
    if st == STATUS_REVOKED:
        return STATUS_REVOKED
    ts = int(now if now is not None else time.time())
    if int(expires_at_unix or 0) > 0 and ts >= int(expires_at_unix):
        return STATUS_EXPIRED
    return STATUS_ACTIVE


def _enrich(row: dict[str, Any], *, now: int | None = None) -> dict[str, Any]:
    out = dict(row)
    exp_unix = int(out.get("expires_at_unix") or 0)
    out["status"] = _effective_status(str(out.get("status") or ""), exp_unix, now=now)
    out["floating"] = not str(out.get("machine_id") or "").strip()
    days = None
    if exp_unix > 0:
        rem = exp_unix - int(now if now is not None else time.time())
        days = max(0, int(rem // 86400)) if rem > 0 else 0
    out["days_remaining"] = days
    return out


def insert_issued_code(
    *,
    code: str,
    expires_at_unix: int,
    issued_to: str = "",
    note: str = "",
    machine_id: str = "",
    issued_at: str | None = None,
) -> dict[str, Any]:
    """Insert a newly issued code into the ledger. Returns enriched row."""
    rid = str(uuid.uuid4())
    compact = normalize_activation_code(code)
    fp = code_fingerprint(code)
    exp_unix = int(expires_at_unix)
    issued = str(issued_at or utc_now_iso_z())
    expires_at = unix_to_beijing_iso(exp_unix) if exp_unix > 0 else ""
    mid = str(machine_id or "").strip().upper()
    to = str(issued_to or "").strip()
    note_s = str(note or "").strip()

    def _do(db: Any) -> None:
        db.execute(
            """
            INSERT INTO evoflow_license_issued_codes (
                id, code, code_fp, issued_to, note, machine_id,
                expires_at, expires_at_unix, issued_at, status, revoked_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                rid,
                compact,
                fp,
                to,
                note_s,
                mid,
                expires_at,
                exp_unix,
                issued,
                STATUS_ACTIVE,
                "",
            ),
        )

    run_db_transaction(_do)
    return get_issued_code(rid) or {
        "id": rid,
        "code": compact,
        "code_fp": fp,
        "issued_to": to,
        "note": note_s,
        "machine_id": mid,
        "expires_at": expires_at,
        "expires_at_unix": exp_unix,
        "issued_at": issued,
        "status": STATUS_ACTIVE,
        "revoked_at": "",
        "floating": not mid,
    }


def get_issued_code(code_id: str) -> dict[str, Any] | None:
    cid = str(code_id or "").strip()
    if not cid:
        return None

    def _do(db: Any) -> dict[str, Any] | None:
        row = db.execute(
            "SELECT * FROM evoflow_license_issued_codes WHERE id = ?",
            (cid,),
        ).fetchone()
        if not row:
            return None
        return _enrich(_row_to_dict(row))

    return run_db_transaction(_do)


def revoke_issued_code(code_id: str) -> dict[str, Any] | None:
    cid = str(code_id or "").strip()
    if not cid:
        return None
    now = utc_now_iso_z()

    def _do(db: Any) -> dict[str, Any] | None:
        cur = db.execute(
            """
            UPDATE evoflow_license_issued_codes
            SET status = ?, revoked_at = ?
            WHERE id = ? AND status != ?
            """,
            (STATUS_REVOKED, now, cid, STATUS_REVOKED),
        )
        if cur.rowcount <= 0:
            row = db.execute(
                "SELECT * FROM evoflow_license_issued_codes WHERE id = ?",
                (cid,),
            ).fetchone()
            return _enrich(_row_to_dict(row)) if row else None
        row = db.execute(
            "SELECT * FROM evoflow_license_issued_codes WHERE id = ?",
            (cid,),
        ).fetchone()
        return _enrich(_row_to_dict(row)) if row else None

    return run_db_transaction(_do)


def list_issued_codes(
    *,
    q: str = "",
    status: str = "",
    limit: int = 200,
    offset: int = 0,
) -> dict[str, Any]:
    """Return ``{ items, total, stats }`` with effective status applied."""
    query = str(q or "").strip()
    if query.lower() in {"undefined", "null"}:
        query = ""
    want = str(status or "").strip().lower()
    if want in {"undefined", "null"}:
        want = ""
    lim = max(1, min(int(limit or 200), 500))
    off = max(0, int(offset or 0))
    now = int(time.time())

    db = get_db()
    raw_rows = db.execute(
        """
        SELECT * FROM evoflow_license_issued_codes
        ORDER BY issued_at DESC, id DESC
        """
    ).fetchall()
    items = [_enrich(_row_to_dict(r), now=now) for r in raw_rows]

    if query:
        ql = query.lower()

        def _match(row: dict[str, Any]) -> bool:
            hay = " ".join(
                [
                    str(row.get("issued_to") or ""),
                    str(row.get("note") or ""),
                    str(row.get("machine_id") or ""),
                    str(row.get("code") or ""),
                    str(row.get("id") or ""),
                ]
            ).lower()
            return ql in hay

        items = [r for r in items if _match(r)]

    stats = {
        "total": len(items),
        "active": sum(1 for r in items if r.get("status") == STATUS_ACTIVE),
        "expired": sum(1 for r in items if r.get("status") == STATUS_EXPIRED),
        "revoked": sum(1 for r in items if r.get("status") == STATUS_REVOKED),
        "expiring_soon": sum(
            1
            for r in items
            if r.get("status") == STATUS_ACTIVE
            and isinstance(r.get("days_remaining"), int)
            and int(r["days_remaining"]) <= 30
        ),
    }

    if want in {STATUS_ACTIVE, STATUS_EXPIRED, STATUS_REVOKED}:
        items = [r for r in items if r.get("status") == want]
    elif want == "expiring_soon":
        items = [
            r
            for r in items
            if r.get("status") == STATUS_ACTIVE
            and isinstance(r.get("days_remaining"), int)
            and int(r["days_remaining"]) <= 30
        ]

    total = len(items)
    page = items[off : off + lim]
    return {"items": page, "total": total, "stats": stats, "limit": lim, "offset": off}
