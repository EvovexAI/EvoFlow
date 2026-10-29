"""Person Kernel Phase D persistence: relations, commitments, affect."""

from __future__ import annotations

import json
import uuid
from typing import Any

from evoflow.persistence.db import get_db, run_db_transaction
from evoflow.timeutil import utc_now_iso_z

# Legacy workplace axes (dual-written for wrap-up / old readers).
# Legacy workplace axes (dual-written for wrap-up / old readers).
_AFFECT_AXES = (
    "curiosity",
    "confidence",
    "pressure",
    "connection",
    "frustration",
    "energy",
)
_HORMONE_EXTRA = ("oxytocin", "dopamine", "serotonin", "cortisol")

# Unified hormone substrate (SoT). ``energy`` is shared with legacy.
_HORMONE_AXES = (
    "oxytocin",
    "dopamine",
    "serotonin",
    "cortisol",
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


def _default_affect_row(agent_code: str = "") -> dict[str, Any]:
    from evoflow.person_affect import HORMONE_DEFAULTS, default_hormones, legacy_from_hormones

    hormones = default_hormones()
    legacy = legacy_from_hormones(hormones)
    return {
        "agent_code": agent_code,
        **legacy,
        **hormones,
        "updated_at": "",
        "meta": {},
    }


def get_affect(agent_code: str, *, apply_decay: bool = True) -> dict[str, Any]:
    """Load affect; hormones are SoT. Optionally decay toward setpoints on read."""
    from evoflow.person_affect import (
        HORMONE_AXES,
        HORMONE_DEFAULTS,
        apply_idle_longing,
        decay_hormones_toward_setpoint,
        hormones_from_legacy,
        legacy_from_hormones,
    )

    code = str(agent_code or "").strip().lower()
    if not code:
        return _default_affect_row("")
    cols = ", ".join(_AFFECT_AXES + _HORMONE_EXTRA)
    try:
        row = (
            get_db()
            .execute(
                f"""
                SELECT agent_code, {cols}, updated_at, meta_json
                FROM evoflow_person_affect WHERE agent_code = ?
                """,
                (code,),
            )
            .fetchone()
        )
    except Exception:
        # Pre-migration DB without hormone columns — fall back to legacy select.
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
            return _default_affect_row(code)
    if not row:
        return _default_affect_row(code)
    d = _row_dict(row)
    meta = _loads(d.pop("meta_json", None)) or {}
    if not isinstance(meta, dict):
        meta = {}
    # Prefer hormone columns when present; else migrate from legacy once in-memory.
    has_hormones = any(d.get(k) is not None for k in _HORMONE_EXTRA)
    if has_hormones:
        hormones = {
            k: _clamp01(float(d.get(k, HORMONE_DEFAULTS[k]) or HORMONE_DEFAULTS[k]))
            for k in HORMONE_AXES
        }
        # energy lives in legacy column name too.
        hormones["energy"] = _clamp01(float(d.get("energy", HORMONE_DEFAULTS["energy"]) or 0.65))
    else:
        hormones = hormones_from_legacy(d)
    updated_at = str(d.get("updated_at") or "")
    if apply_decay:
        hormones = decay_hormones_toward_setpoint(hormones, updated_at=updated_at)
        hormones = apply_idle_longing(
            hormones,
            last_significant_at=str(meta.get("last_significant_at") or ""),
        )
    legacy = legacy_from_hormones(hormones)
    out = {
        "agent_code": code,
        **legacy,
        **hormones,
        "updated_at": updated_at,
        "meta": meta,
        "mood_label": None,
    }
    try:
        from evoflow.person_affect import mood_label

        out["mood_label"] = mood_label(hormones)
    except Exception:
        out["mood_label"] = "平稳"
    return out


def save_affect(
    agent_code: str,
    axes: dict[str, float],
    *,
    meta: dict[str, Any] | None = None,
    significant: bool = False,
    source: str = "",
) -> None:
    """Persist hormones (+ dual-write legacy). ``axes`` may use hormone or legacy keys."""
    from evoflow.person_affect import (
        HORMONE_AXES,
        HORMONE_DEFAULTS,
        hormones_from_legacy,
        legacy_from_hormones,
    )

    code = str(agent_code or "").strip().lower()
    if not code:
        return
    now = utc_now_iso_z()
    # Absolute values if any hormone/legacy present as absolute; else treat as full state.
    # Callers historically pass absolute axis maps. Deltas go through apply_hormone_deltas.
    incoming = {str(k).lower(): float(v) for k, v in (axes or {}).items() if v is not None}
    hormone_keys = set(HORMONE_AXES)
    if any(k in hormone_keys for k in incoming):
        hormones = {k: _clamp01(float(incoming.get(k, HORMONE_DEFAULTS[k]))) for k in HORMONE_AXES}
        # Fill missing hormones from mapped legacy if provided.
        if any(k in incoming for k in ("curiosity", "confidence", "pressure", "connection", "frustration")):
            from_leg = hormones_from_legacy(incoming)
            for k in HORMONE_AXES:
                if k not in incoming:
                    hormones[k] = from_leg[k]
    else:
        hormones = hormones_from_legacy(incoming or {})
    legacy = legacy_from_hormones(hormones)

    prev_meta: dict[str, Any] = {}
    try:
        prev = get_affect(code, apply_decay=False)
        prev_meta = dict(prev.get("meta") or {}) if isinstance(prev.get("meta"), dict) else {}
    except Exception:
        prev_meta = {}
    merged_meta = dict(prev_meta)
    if meta:
        merged_meta.update(meta)
    if source:
        merged_meta["source"] = str(source)[:64]
    if significant:
        merged_meta["last_significant_at"] = now
    merged_meta.setdefault("last_event", merged_meta.get("last_event") or source or "save")

    def _write(db: Any) -> None:
        db.execute(
            """
            INSERT INTO evoflow_person_affect (
                agent_code,
                curiosity, confidence, pressure, connection, frustration, energy,
                oxytocin, dopamine, serotonin, cortisol,
                updated_at, meta_json
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(agent_code) DO UPDATE SET
                curiosity=excluded.curiosity,
                confidence=excluded.confidence,
                pressure=excluded.pressure,
                connection=excluded.connection,
                frustration=excluded.frustration,
                energy=excluded.energy,
                oxytocin=excluded.oxytocin,
                dopamine=excluded.dopamine,
                serotonin=excluded.serotonin,
                cortisol=excluded.cortisol,
                updated_at=excluded.updated_at,
                meta_json=excluded.meta_json
            """,
            (
                code,
                legacy["curiosity"],
                legacy["confidence"],
                legacy["pressure"],
                legacy["connection"],
                legacy["frustration"],
                legacy["energy"],
                hormones["oxytocin"],
                hormones["dopamine"],
                hormones["serotonin"],
                hormones["cortisol"],
                now,
                _dumps(merged_meta),
            ),
        )

    try:
        run_db_transaction(_write)
    except Exception:
        # Hormone columns may be missing on very old connections — try legacy-only write.
        try:

            def _write_legacy(db: Any) -> None:
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
                        legacy["curiosity"],
                        legacy["confidence"],
                        legacy["pressure"],
                        legacy["connection"],
                        legacy["frustration"],
                        legacy["energy"],
                        now,
                        _dumps(merged_meta),
                    ),
                )

            run_db_transaction(_write_legacy)
        except Exception:
            pass


def apply_affect_deltas(
    agent_code: str,
    deltas: dict[str, float] | None,
    *,
    significant: bool = True,
    source: str = "delta",
    clamp_each: float | None = 0.12,
) -> dict[str, Any]:
    """Apply hormone/legacy deltas onto current state and persist."""
    from evoflow.person_affect import apply_hormone_deltas

    code = str(agent_code or "").strip().lower()
    if not code:
        return {"ok": False, "error": "missing agent_code"}
    cur = get_affect(code, apply_decay=True)
    hormones = apply_hormone_deltas(cur, deltas, clamp_each=clamp_each)
    save_affect(code, hormones, significant=significant, source=source, meta={"last_event": source})
    return {"ok": True, "affect": get_affect(code, apply_decay=False)}


def ensure_affect_row(agent_code: str) -> dict[str, Any]:
    """INSERT defaults when missing; return current affect."""
    code = str(agent_code or "").strip().lower()
    if not code:
        return _default_affect_row("")
    cur = get_affect(code, apply_decay=False)
    if cur.get("updated_at"):
        return get_affect(code, apply_decay=True)
    # No row / empty — persist defaults.
    from evoflow.person_affect import default_hormones

    save_affect(code, default_hormones(), significant=False, source="ensure", meta={"source": "ensure"})
    return get_affect(code, apply_decay=True)
