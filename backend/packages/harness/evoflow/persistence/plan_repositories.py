"""Per-thread plan markdown (formerly ``outputs/plan.md``) in SQLite."""

from __future__ import annotations

from evoflow.persistence.db import get_db
from evoflow.timeutil import utc_now_iso_z


def get_thread_plan(thread_id: str) -> dict[str, str] | None:
    tid = (thread_id or "").strip()
    if not tid:
        return None
    row = (
        get_db()
        .execute(
            """
        SELECT plan_md, plan_md_stamped, stamped_label, updated_at
        FROM evoflow_thread_plans WHERE thread_id = ?
        """,
            (tid,),
        )
        .fetchone()
    )
    if not row:
        return None
    return {
        "plan_md": str(row[0] or ""),
        "plan_md_stamped": str(row[1] or ""),
        "stamped_label": str(row[2] or ""),
        "updated_at": str(row[3] or ""),
    }


def save_thread_plan(
    thread_id: str,
    plan_md: str,
    *,
    plan_md_stamped: str = "",
    stamped_label: str = "",
) -> None:
    tid = (thread_id or "").strip()
    if not tid:
        raise ValueError("thread_id is required")
    now = utc_now_iso_z()
    get_db().execute(
        """
        INSERT INTO evoflow_thread_plans (
            thread_id, plan_md, plan_md_stamped, stamped_label, updated_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(thread_id) DO UPDATE SET
            plan_md = excluded.plan_md,
            plan_md_stamped = excluded.plan_md_stamped,
            stamped_label = excluded.stamped_label,
            updated_at = excluded.updated_at
        """,
        (tid, plan_md, plan_md_stamped or "", stamped_label or "", now),
    )
    get_db().commit()


def migrate_thread_plan_from_file(thread_id: str, plan_path) -> str | None:
    """One-time import of legacy ``plan.md`` if DB row is empty."""
    from pathlib import Path

    existing = get_thread_plan(thread_id)
    if existing and (existing.get("plan_md") or "").strip():
        return existing["plan_md"]
    p = Path(plan_path)
    if not p.is_file():
        return None
    try:
        text = p.read_text(encoding="utf-8").strip()
    except OSError:
        return None
    if text:
        save_thread_plan(thread_id, text)
    return text or None
