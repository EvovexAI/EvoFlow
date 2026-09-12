"""Person Kernel Phase D persistence: relations, commitments, affect."""

from __future__ import annotations

import json
import uuid
from typing import Any

from evoflow.persistence.db import get_db, run_db_transaction
from evoflow.timeutil import utc_now_iso_z

_AFFECT_AXES = (
    "curiosity",
    "confidence",
    "pressure",
    "connection",
    "frustration",
    "energy",
)


def _dumps(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def _loads(raw: str | None) -> Any:
    if not raw:
        return None
    try:
        return json.loads(raw)
    except Exception:
        return None


def _row_dict(row: Any) -> dict[str, Any]:
    return {k: row[k] for k in row.keys()}


def _clamp01(v: float) -> float:
    return max(0.0, min(1.0, float(v)))


def upsert_relation_edge(
    agent_code: str,
    peer_code: str,
    *,
    bond_delta: float = 0.05,
    last_event: str = "",
    meta: dict[str, Any] | None = None,
) -> None:
    a = str(agent_code or "").strip().lower()
    b = str(peer_code or "").strip().lower()
    if not a or not b or a == b:
        return
    if a in {"user", "system"} or b in {"user", "system"}:
        # Still allow user as peer for bond-to-human; skip only empty.
        pass
    now = utc_now_iso_z()
    delta = float(bond_delta)

    def _write(db: Any) -> None:
        row = db.execute(
            "SELECT bond, meta_json FROM evoflow_person_relations WHERE agent_code=? AND peer_code=?",
            (a, b),
        ).fetchone()
        if row:
            bond = _clamp01(float(row[0] or 0.4) + delta)
            old_meta = _loads(row[1]) if len(row) > 1 else {}
            if not isinstance(old_meta, dict):
                old_meta = {}
            if meta:
                old_meta.update(meta)
            db.execute(
                """
                UPDATE evoflow_person_relations
                SET bond=?, last_event=?, meta_json=?, updated_at=?
                WHERE agent_code=? AND peer_code=?
                """,
                (bond, str(last_event or "")[:80], _dumps(old_meta), now, a, b),
            )
        else:
            bond = _clamp01(0.4 + delta)
            db.execute(
                """
                INSERT INTO evoflow_person_relations (
                    agent_code, peer_code, bond, last_event, meta_json, updated_at
                ) VALUES (?,?,?,?,?,?)
                """,
                (a, b, bond, str(last_event or "")[:80], _dumps(meta or {}), now),
            )

    try:
        run_db_transaction(_write)
    except Exception:
        pass


def list_relations(agent_code: str, *, limit: int = 20) -> list[dict[str, Any]]:
    code = str(agent_code or "").strip().lower()
    if not code:
        return []
    lim = max(1, min(int(limit or 20), 100))
    try:
        rows = (
            get_db()
            .execute(
                """
                SELECT agent_code, peer_code, bond, last_event, meta_json, updated_at
                FROM evoflow_person_relations
                WHERE agent_code = ?
                ORDER BY bond DESC, updated_at DESC
                LIMIT ?
                """,
                (code, lim),
            )
            .fetchall()
        )
    except Exception:
        return []
    out = []
    for row in rows:
        d = _row_dict(row)
        d["meta"] = _loads(d.pop("meta_json", None)) or {}
        out.append(d)
    return out


def open_commitment(
    *,
    from_agent: str,
    to_agent: str,
    kind: str = "handoff",
    parent_task_id: str = "",
    child_task_id: str = "",
    note: str = "",
) -> str | None:
    fr = str(from_agent or "").strip().lower()
    to = str(to_agent or "").strip().lower()
    if not fr or not to:
        return None
    cid = f"pc_{uuid.uuid4().hex[:16]}"
    now = utc_now_iso_z()
    child = str(child_task_id or "").strip()

    def _write(db: Any) -> None:
        # Idempotent: same open child_task_id → keep existing
        if child:
            exist = db.execute(
                """
                SELECT id FROM evoflow_person_commitments
                WHERE child_task_id = ? AND status = 'open'
                LIMIT 1
                """,
                (child,),
            ).fetchone()
            if exist:
                return
        db.execute(
            """
            INSERT INTO evoflow_person_commitments (
                id, from_agent, to_agent, kind, status, parent_task_id,
                child_task_id, note, created_at, closed_at
            ) VALUES (?,?,?,?,?,?,?,?,?,?)
            """,
            (
                cid,
                fr,
                to,
                str(kind or "handoff")[:40],
                "open",
                str(parent_task_id or "")[:120],
                child[:120],
                str(note or "")[:500],
                now,
                "",
            ),
        )

    try:
        run_db_transaction(_write)
    except Exception:
        return None
    # If idempotent skip happened, resolve existing id
    if child:
        try:
            row = (
                get_db()
                .execute(
                    "SELECT id FROM evoflow_person_commitments WHERE child_task_id=? AND status='open' LIMIT 1",
                    (child,),
                )
                .fetchone()
            )
            if row:
                return str(row[0])
        except Exception:
            pass
    return cid


def close_commitments_for_child(child_task_id: str, *, note: str = "") -> int:
    child = str(child_task_id or "").strip()
    if not child:
        return 0
    now = utc_now_iso_z()
    closed = 0

    def _write(db: Any) -> None:
        nonlocal closed
        cur = db.execute(
            """
            UPDATE evoflow_person_commitments
            SET status='closed', closed_at=?, note=CASE WHEN ?!='' THEN ? ELSE note END
            WHERE child_task_id=? AND status='open'
            """,
            (now, note, note[:500], child),
        )
        closed = int(cur.rowcount or 0)

    try:
        run_db_transaction(_write)
    except Exception:
        return 0
    return closed


def list_open_commitments(agent_code: str, *, as_to: bool = True, limit: int = 20) -> list[dict[str, Any]]:
    code = str(agent_code or "").strip().lower()
    if not code:
        return []
    lim = max(1, min(int(limit or 20), 100))
    col = "to_agent" if as_to else "from_agent"
    try:
        rows = (
            get_db()
            .execute(
                f"""
                SELECT id, from_agent, to_agent, kind, status, parent_task_id,
                       child_task_id, note, created_at, closed_at
                FROM evoflow_person_commitments
                WHERE {col} = ? AND status = 'open'
                ORDER BY created_at DESC
                LIMIT ?
                """,
                (code, lim),
            )
            .fetchall()
        )
    except Exception:
        return []
    return [_row_dict(r) for r in rows]


def count_open_commitments(agent_code: str) -> int:
    code = str(agent_code or "").strip().lower()
    if not code:
        return 0
    try:
        row = (
            get_db()
            .execute(
                """
                SELECT COUNT(1) FROM evoflow_person_commitments
                WHERE to_agent = ? AND status = 'open'
                """,
                (code,),
            )
            .fetchone()
        )
        return int(row[0] if row else 0)
    except Exception:
        return 0


def get_affect(agent_code: str) -> dict[str, Any]:
    code = str(agent_code or "").strip().lower()
    defaults = {k: 0.5 for k in _AFFECT_AXES}
    defaults.update(
        {
            "curiosity": 0.5,
            "confidence": 0.55,
            "pressure": 0.3,
            "connection": 0.5,
            "frustration": 0.15,
            "energy": 0.65,
        }
    )
    if not code:
        return {"agent_code": "", **defaults, "updated_at": ""}
    try:
        row = (
            get_db()
            .execute(
                f"""
                SELECT agent_code, {", ".join(_AFFECT_AXES)}, updated_at, meta_json
                FROM evoflow_person_affect WHERE agent_code = ?
                """,
                (code,),
            )
            .fetchone()
        )
    except Exception:
        return {"agent_code": code, **defaults, "updated_at": ""}
    if not row:
        return {"agent_code": code, **defaults, "updated_at": ""}
    d = _row_dict(row)
    d["meta"] = _loads(d.pop("meta_json", None)) or {}
    return d


def save_affect(agent_code: str, axes: dict[str, float], *, meta: dict[str, Any] | None = None) -> None:
    code = str(agent_code or "").strip().lower()
    if not code:
        return
    now = utc_now_iso_z()
    vals = {k: _clamp01(axes.get(k, 0.5)) for k in _AFFECT_AXES}

    def _write(db: Any) -> None:
        db.execute(
            f"""
            INSERT INTO evoflow_person_affect (
                agent_code, {", ".join(_AFFECT_AXES)}, updated_at, meta_json
            ) VALUES (?,?,?,?,?,?,?,?,?)
            ON CONFLICT(agent_code) DO UPDATE SET
                curiosity=excluded.curiosity,
                confidence=excluded.confidence,
                pressure=excluded.pressure,
                connection=excluded.connection,
                frustration=excluded.frustration,
                energy=excluded.energy,
                updated_at=excluded.updated_at,
                meta_json=excluded.meta_json
            """,
            (
                code,
                vals["curiosity"],
                vals["confidence"],
                vals["pressure"],
                vals["connection"],
                vals["frustration"],
                vals["energy"],
                now,
                _dumps(meta or {}),
            ),
        )

    try:
        run_db_transaction(_write)
    except Exception:
        pass
