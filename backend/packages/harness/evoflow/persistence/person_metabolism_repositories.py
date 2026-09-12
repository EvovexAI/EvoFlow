"""Person Kernel Phase C persistence: morning state, dream log, evolution proposals."""

from __future__ import annotations

import json
import uuid
from typing import Any

from evoflow.persistence.db import get_db, run_db_transaction
from evoflow.timeutil import utc_now_iso_z


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


def get_person_state(agent_code: str, as_of_date: str) -> dict[str, Any] | None:
    code = str(agent_code or "").strip().lower()
    day = str(as_of_date or "").strip()
    if not code or not day:
        return None
    try:
        row = (
            get_db()
            .execute(
                """
                SELECT agent_code, as_of_date, stance_md, meta_json, updated_at
                FROM evoflow_person_state
                WHERE agent_code = ? AND as_of_date = ?
                """,
                (code, day),
            )
            .fetchone()
        )
    except Exception:
        return None
    if not row:
        return None
    d = _row_dict(row)
    d["meta"] = _loads(d.pop("meta_json", None)) or {}
    return d


def upsert_person_state(
    agent_code: str,
    as_of_date: str,
    stance_md: str,
    *,
    meta: dict[str, Any] | None = None,
) -> None:
    code = str(agent_code or "").strip().lower()
    day = str(as_of_date or "").strip()
    if not code or not day:
        return
    now = utc_now_iso_z()
    meta_json = _dumps(meta or {})

    def _write(db: Any) -> None:
        db.execute(
            """
            INSERT INTO evoflow_person_state (
                agent_code, as_of_date, stance_md, meta_json, updated_at
            ) VALUES (?,?,?,?,?)
            ON CONFLICT(agent_code, as_of_date) DO UPDATE SET
                stance_md = excluded.stance_md,
                meta_json = excluded.meta_json,
                updated_at = excluded.updated_at
            """,
            (code, day, str(stance_md or "")[:4000], meta_json, now),
        )

    try:
        run_db_transaction(_write)
    except Exception:
        pass


def get_dream_log(agent_code: str, as_of_date: str) -> dict[str, Any] | None:
    code = str(agent_code or "").strip().lower()
    day = str(as_of_date or "").strip()
    if not code or not day:
        return None
    try:
        row = (
            get_db()
            .execute(
                """
                SELECT agent_code, as_of_date, summary_md, meta_json, created_at
                FROM evoflow_person_dream_log
                WHERE agent_code = ? AND as_of_date = ?
                """,
                (code, day),
            )
            .fetchone()
        )
    except Exception:
        return None
    if not row:
        return None
    d = _row_dict(row)
    d["meta"] = _loads(d.pop("meta_json", None)) or {}
    return d


def upsert_dream_log(
    agent_code: str,
    as_of_date: str,
    summary_md: str,
    *,
    meta: dict[str, Any] | None = None,
) -> None:
    code = str(agent_code or "").strip().lower()
    day = str(as_of_date or "").strip()
    if not code or not day:
        return
    now = utc_now_iso_z()

    def _write(db: Any) -> None:
        db.execute(
            """
            INSERT INTO evoflow_person_dream_log (
                agent_code, as_of_date, summary_md, meta_json, created_at
            ) VALUES (?,?,?,?,?)
            ON CONFLICT(agent_code, as_of_date) DO UPDATE SET
                summary_md = excluded.summary_md,
                meta_json = excluded.meta_json,
                created_at = excluded.created_at
            """,
            (code, day, str(summary_md or "")[:4000], _dumps(meta or {}), now),
        )

    try:
        run_db_transaction(_write)
    except Exception:
        pass


def insert_evolution_proposal(
    agent_code: str,
    *,
    title: str,
    rationale: str,
    field: str = "soul_md",
    patch: dict[str, Any] | None = None,
    evidence: list[Any] | None = None,
    source: str = "dream",
    proposal_id: str | None = None,
) -> str | None:
    code = str(agent_code or "").strip().lower()
    if not code:
        return None
    pid = (proposal_id or "").strip() or f"ep_{uuid.uuid4().hex[:16]}"
    now = utc_now_iso_z()

    def _write(db: Any) -> None:
        db.execute(
            """
            INSERT INTO evoflow_evolution_proposals (
                id, agent_code, status, field, title, rationale,
                patch_json, evidence_json, source, created_at, resolved_at, resolved_by
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
            """,
            (
                pid,
                code,
                "draft",
                str(field or "soul_md")[:80],
                str(title or "")[:200],
                str(rationale or "")[:2000],
                _dumps(patch or {}),
                _dumps(evidence or []),
                str(source or "dream")[:80],
                now,
                "",
                "",
            ),
        )

    try:
        run_db_transaction(_write)
    except Exception:
        return None
    return pid


def get_evolution_proposal(proposal_id: str) -> dict[str, Any] | None:
    pid = str(proposal_id or "").strip()
    if not pid:
        return None
    try:
        row = (
            get_db()
            .execute(
                """
                SELECT id, agent_code, status, field, title, rationale,
                       patch_json, evidence_json, source, created_at,
                       resolved_at, resolved_by
                FROM evoflow_evolution_proposals WHERE id = ?
                """,
                (pid,),
            )
            .fetchone()
        )
    except Exception:
        return None
    if not row:
        return None
    d = _row_dict(row)
    d["patch"] = _loads(d.pop("patch_json", None)) or {}
    d["evidence"] = _loads(d.pop("evidence_json", None)) or []
    return d


def list_evolution_proposals(
    agent_code: str,
    *,
    status: str | None = None,
    limit: int = 20,
) -> list[dict[str, Any]]:
    code = str(agent_code or "").strip().lower()
    if not code:
        return []
    lim = max(1, min(int(limit or 20), 100))
    try:
        if status:
            rows = (
                get_db()
                .execute(
                    """
                    SELECT id, agent_code, status, field, title, rationale,
                           patch_json, evidence_json, source, created_at,
                           resolved_at, resolved_by
                    FROM evoflow_evolution_proposals
                    WHERE agent_code = ? AND status = ?
                    ORDER BY created_at DESC
                    LIMIT ?
                    """,
                    (code, str(status), lim),
                )
                .fetchall()
            )
        else:
            rows = (
                get_db()
                .execute(
                    """
                    SELECT id, agent_code, status, field, title, rationale,
                           patch_json, evidence_json, source, created_at,
                           resolved_at, resolved_by
                    FROM evoflow_evolution_proposals
                    WHERE agent_code = ?
                    ORDER BY created_at DESC
                    LIMIT ?
                    """,
                    (code, lim),
                )
                .fetchall()
            )
    except Exception:
        return []
    out: list[dict[str, Any]] = []
    for row in rows:
        d = _row_dict(row)
        d["patch"] = _loads(d.pop("patch_json", None)) or {}
        d["evidence"] = _loads(d.pop("evidence_json", None)) or []
        out.append(d)
    return out


def resolve_evolution_proposal(
    proposal_id: str,
    *,
    status: str,
    resolved_by: str = "user",
) -> dict[str, Any] | None:
    pid = str(proposal_id or "").strip()
    st = str(status or "").strip().lower()
    if not pid or st not in {"approved", "rejected"}:
        return None
    now = utc_now_iso_z()

    def _write(db: Any) -> None:
        db.execute(
            """
            UPDATE evoflow_evolution_proposals
            SET status = ?, resolved_at = ?, resolved_by = ?
            WHERE id = ? AND status = 'draft'
            """,
            (st, now, str(resolved_by or "user")[:80], pid),
        )

    try:
        run_db_transaction(_write)
    except Exception:
        return None
    return get_evolution_proposal(pid)


def count_open_draft_proposals(agent_code: str) -> int:
    code = str(agent_code or "").strip().lower()
    if not code:
        return 0
    try:
        row = (
            get_db()
            .execute(
                """
                SELECT COUNT(1) FROM evoflow_evolution_proposals
                WHERE agent_code = ? AND status = 'draft'
                """,
                (code,),
            )
            .fetchone()
        )
        return int(row[0] if row else 0)
    except Exception:
        return 0
