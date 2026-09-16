"""Department registry for smart employees (proactive roles).

Roles keep a free-text ``department`` column for prompts / Feishu / org checks.
This table is the managed catalog: create/rename/delete, with member counts
derived from ``evoflow_proactive_roles.department`` name match.

Each department may designate a ``head_agent_code`` (负责人) who is expected to
be a member of that department; reporting lines remain on roles via
``reports_to``.
"""

from __future__ import annotations

import json
import logging
import re
import uuid
from typing import Any

from evoflow.persistence.db import get_db, run_db_transaction
from evoflow.timeutil import utc_now_iso_z

logger = logging.getLogger(__name__)

_DEPT_COLS = "id, name, sort_order, head_agent_code, created_at, updated_at"

_CREATE_DEPTS_SQL = """
CREATE TABLE IF NOT EXISTS evoflow_departments (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    head_agent_code TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
)
"""

_CREATE_DEPTS_IDX_SQL = (
    "CREATE INDEX IF NOT EXISTS idx_departments_sort ON evoflow_departments(sort_order, name)"
)


def _sanitize_name(value: Any) -> str:
    text = str(value or "").strip()
    if not text or text.casefold() in {"none", "null", "undefined"}:
        return ""
    # Collapse whitespace; keep CJK / letters.
    text = re.sub(r"\s+", " ", text)
    return text[:64]


def _new_id() -> str:
    return uuid.uuid4().hex[:12]


def _row_dict(row: Any) -> dict[str, Any]:
    d = {k: row[k] for k in row.keys()}
    if "head_agent_code" not in d:
        d["head_agent_code"] = ""
    else:
        d["head_agent_code"] = str(d.get("head_agent_code") or "").strip()
    return d


def _table_columns(conn: Any) -> set[str]:
    return {
        str(r[1])
        for r in conn.execute("PRAGMA table_info(evoflow_departments)").fetchall()
    }


def ensure_departments_table(conn: Any | None = None) -> None:
    """Idempotent DDL for existing installs (baseline is not re-applied at v1)."""
    db = conn or get_db()
    db.execute(_CREATE_DEPTS_SQL)
    db.execute(_CREATE_DEPTS_IDX_SQL)
    cols = _table_columns(db)
    if "head_agent_code" not in cols:
        db.execute(
            "ALTER TABLE evoflow_departments "
            "ADD COLUMN head_agent_code TEXT NOT NULL DEFAULT ''"
        )
    if conn is None and not db.in_transaction:
        try:
            db.commit()
        except Exception:
            logger.debug("departments: commit ensure table failed", exc_info=True)


def _role_reports_to_from_row(row: Any) -> str:
    col = ""
    try:
        col = str(row["reports_to"] or "").strip()
    except Exception:
        col = ""
    if col:
        return col
    raw = ""
    try:
        raw = row["config_json"] or ""
    except Exception:
        raw = ""
    if not raw:
        return ""
    try:
        cfg = json.loads(raw) if isinstance(raw, str) else (raw or {})
    except Exception:
        return ""
    return str((cfg or {}).get("reports_to") or "").strip()


def _set_role_reports_to(conn: Any, agent_code: str, reports_to: str, now: str) -> None:
    """Update both the reports_to column and config_json.reports_to."""
    code = str(agent_code or "").strip()
    mgr = str(reports_to or "").strip()
    if not code:
        return
    row = conn.execute(
        "SELECT config_json FROM evoflow_proactive_roles WHERE agent_code = ?",
        (code,),
    ).fetchone()
    if not row:
        return
    raw = row["config_json"] if hasattr(row, "keys") else row[0]
    try:
        cfg = json.loads(raw or "{}") if isinstance(raw, str) else dict(raw or {})
    except Exception:
        cfg = {}
    if not isinstance(cfg, dict):
        cfg = {}
    cfg["reports_to"] = mgr
    conn.execute(
        """
        UPDATE evoflow_proactive_roles
        SET reports_to = ?, config_json = ?, updated_at = ?
        WHERE agent_code = ?
        """,
        (mgr, json.dumps(cfg, ensure_ascii=False), now, code),
    )


class DepartmentRepository:
    @staticmethod
    def ensure_from_roles() -> int:
        """Upsert department rows for distinct non-empty role.department labels.

        Returns number of newly created rows.
        """
        created = 0
        now = utc_now_iso_z()

        def _work(conn: Any) -> None:
            nonlocal created
            ensure_departments_table(conn)
            existing = {
                str(r["name"]).strip()
                for r in conn.execute("SELECT name FROM evoflow_departments").fetchall()
                if str(r["name"] or "").strip()
            }
            rows = conn.execute(
                """
                SELECT DISTINCT TRIM(department) AS name
                FROM evoflow_proactive_roles
                WHERE TRIM(COALESCE(department, '')) != ''
                """
            ).fetchall()
            max_sort = conn.execute(
                "SELECT COALESCE(MAX(sort_order), 0) FROM evoflow_departments"
            ).fetchone()[0]
            sort = int(max_sort or 0)
            for row in rows:
                name = _sanitize_name(row["name"] if hasattr(row, "keys") else row[0])
                if not name or name in existing:
                    continue
                sort += 10
                conn.execute(
                    f"""
                    INSERT INTO evoflow_departments ({_DEPT_COLS})
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (_new_id(), name, sort, "", now, now),
                )
                existing.add(name)
                created += 1

        run_db_transaction(_work)
        if created:
            logger.info("departments: seeded %d from role labels", created)
        return created

    @staticmethod
    def list_departments(*, with_members: bool = True) -> list[dict[str, Any]]:
        DepartmentRepository.ensure_from_roles()
        ensure_departments_table()
        conn = get_db()
        depts = [
            _row_dict(r)
            for r in conn.execute(
                f"""
                SELECT {_DEPT_COLS}
                FROM evoflow_departments
                ORDER BY sort_order ASC, name COLLATE NOCASE ASC
                """
            ).fetchall()
        ]
        if not with_members:
            return depts
        counts = {
            str(r["department"] or "").strip(): int(r["n"] or 0)
            for r in conn.execute(
                """
                SELECT TRIM(department) AS department, COUNT(*) AS n
                FROM evoflow_proactive_roles
                WHERE status != 'archived' AND TRIM(COALESCE(department, '')) != ''
                GROUP BY TRIM(department)
                """
            ).fetchall()
        }
        members_by_dept: dict[str, list[dict[str, str]]] = {}
        for r in conn.execute(
            """
            SELECT agent_code, role_name, department, status, reports_to, config_json
            FROM evoflow_proactive_roles
            WHERE status != 'archived' AND TRIM(COALESCE(department, '')) != ''
            ORDER BY role_name COLLATE NOCASE ASC
            """
        ).fetchall():
            dname = str(r["department"] or "").strip()
            members_by_dept.setdefault(dname, []).append(
                {
                    "agent_code": str(r["agent_code"] or ""),
                    "role_name": str(r["role_name"] or r["agent_code"] or ""),
                    "status": str(r["status"] or ""),
                    "reports_to": _role_reports_to_from_row(r),
                }
            )
        out: list[dict[str, Any]] = []
        for d in depts:
            name = str(d.get("name") or "").strip()
            members = members_by_dept.get(name, [])
            head = str(d.get("head_agent_code") or "").strip()
            # Drop stale head if no longer a member.
            if head and not any(m["agent_code"] == head for m in members):
                head = ""
            head_name = ""
            if head:
                for m in members:
                    if m["agent_code"] == head:
                        head_name = m["role_name"]
                        break
            out.append(
                {
                    **d,
                    "head_agent_code": head,
                    "head_role_name": head_name,
                    "member_count": counts.get(name, 0),
                    "members": members,
                }
            )
        return out

    @staticmethod
    def get(dept_id: str) -> dict[str, Any] | None:
        did = str(dept_id or "").strip()
        if not did:
            return None
        ensure_departments_table()
        row = (
            get_db()
            .execute(
                f"SELECT {_DEPT_COLS} FROM evoflow_departments WHERE id = ?",
                (did,),
            )
            .fetchone()
        )
        return _row_dict(row) if row else None

    @staticmethod
    def get_by_name(name: str) -> dict[str, Any] | None:
        n = _sanitize_name(name)
        if not n:
            return None
        ensure_departments_table()
        row = (
            get_db()
            .execute(
                f"SELECT {_DEPT_COLS} FROM evoflow_departments WHERE name = ? COLLATE NOCASE",
                (n,),
            )
            .fetchone()
        )
        return _row_dict(row) if row else None

    @staticmethod
    def create(*, name: str, sort_order: int | None = None) -> dict[str, Any]:
        n = _sanitize_name(name)
        if not n:
            raise ValueError("部门名称不能为空")
        if DepartmentRepository.get_by_name(n):
            raise ValueError(f"部门「{n}」已存在")
        now = utc_now_iso_z()
        did = _new_id()

        def _work(conn: Any) -> None:
            ensure_departments_table(conn)
            sort = sort_order
            if sort is None:
                sort = int(
                    conn.execute(
                        "SELECT COALESCE(MAX(sort_order), 0) FROM evoflow_departments"
                    ).fetchone()[0]
                    or 0
                ) + 10
            conn.execute(
                f"""
                INSERT INTO evoflow_departments ({_DEPT_COLS})
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (did, n, int(sort), "", now, now),
            )

        run_db_transaction(_work)
        row = DepartmentRepository.get(did)
        assert row is not None
        return row

    @staticmethod
    def rename(dept_id: str, *, name: str) -> dict[str, Any]:
        did = str(dept_id or "").strip()
        existing = DepartmentRepository.get(did)
        if not existing:
            raise ValueError("部门不存在")
        n = _sanitize_name(name)
        if not n:
            raise ValueError("部门名称不能为空")
        clash = DepartmentRepository.get_by_name(n)
        if clash and str(clash.get("id")) != did:
            raise ValueError(f"部门「{n}」已存在")
        old_name = str(existing.get("name") or "").strip()
        now = utc_now_iso_z()

        def _work(conn: Any) -> None:
            conn.execute(
                """
                UPDATE evoflow_departments
                SET name = ?, updated_at = ?
                WHERE id = ?
                """,
                (n, now, did),
            )
            if old_name and old_name != n:
                # Keep role.department in sync (name is the join key).
                conn.execute(
                    """
                    UPDATE evoflow_proactive_roles
                    SET department = ?, updated_at = ?
                    WHERE TRIM(department) = ?
                    """,
                    (n, now, old_name),
                )

        run_db_transaction(_work)
        row = DepartmentRepository.get(did)
        assert row is not None
        return row

    @staticmethod
    def set_head(
        dept_id: str,
        *,
        head_agent_code: str = "",
        align_unmanaged: bool = False,
    ) -> dict[str, Any]:
        """Set department head (负责人). Empty clears.

        When *align_unmanaged* is True, members with empty ``reports_to`` (except
        the head) are pointed at the head. Members who already report to someone
        are left unchanged.
        """
        did = str(dept_id or "").strip()
        existing = DepartmentRepository.get(did)
        if not existing:
            raise ValueError("部门不存在")
        name = str(existing.get("name") or "").strip()
        head = str(head_agent_code or "").strip()
        now = utc_now_iso_z()

        if head:
            row = get_db().execute(
                """
                SELECT agent_code, department, status
                FROM evoflow_proactive_roles
                WHERE agent_code = ?
                """,
                (head,),
            ).fetchone()
            if not row or str(row["status"] or "") == "archived":
                raise ValueError(f"负责人岗位「{head}」不存在或已归档")
            if str(row["department"] or "").strip() != name:
                raise ValueError("负责人必须是本部门成员，请先加入部门")

        def _work(conn: Any) -> None:
            conn.execute(
                """
                UPDATE evoflow_departments
                SET head_agent_code = ?, updated_at = ?
                WHERE id = ?
                """,
                (head, now, did),
            )
            if align_unmanaged and head and name:
                members = conn.execute(
                    """
                    SELECT agent_code, reports_to, config_json
                    FROM evoflow_proactive_roles
                    WHERE status != 'archived' AND TRIM(department) = ?
                    """,
                    (name,),
                ).fetchall()
                for m in members:
                    code = str(m["agent_code"] or "").strip()
                    if not code or code == head:
                        continue
                    cur = _role_reports_to_from_row(m)
                    if cur:
                        continue
                    _set_role_reports_to(conn, code, head, now)
                # Head should not report to someone inside the same dept by default
                # when they become the root — leave their reports_to as-is
                # (may report to company-level boss outside dept).

        run_db_transaction(_work)
        listed = DepartmentRepository.list_departments(with_members=True)
        for d in listed:
            if str(d.get("id")) == did:
                return d
        return {**existing, "head_agent_code": head}

    @staticmethod
    def delete(dept_id: str, *, clear_members: bool = True) -> None:
        did = str(dept_id or "").strip()
        existing = DepartmentRepository.get(did)
        if not existing:
            raise ValueError("部门不存在")
        name = str(existing.get("name") or "").strip()
        now = utc_now_iso_z()

        def _work(conn: Any) -> None:
            if clear_members and name:
                conn.execute(
                    """
                    UPDATE evoflow_proactive_roles
                    SET department = '', updated_at = ?
                    WHERE TRIM(department) = ?
                    """,
                    (now, name),
                )
            conn.execute("DELETE FROM evoflow_departments WHERE id = ?", (did,))

        run_db_transaction(_work)

    @staticmethod
    def set_members(dept_id: str, agent_codes: list[str]) -> dict[str, Any]:
        """Set the member roster for a department (non-archived roles only).

        Codes in *agent_codes* get ``department = name``; other non-archived roles
        currently in this department are cleared. If the current head is removed
        from the roster, ``head_agent_code`` is cleared.
        """
        did = str(dept_id or "").strip()
        existing = DepartmentRepository.get(did)
        if not existing:
            raise ValueError("部门不存在")
        name = str(existing.get("name") or "").strip()
        codes = sorted(
            {
                str(c or "").strip()
                for c in (agent_codes or [])
                if str(c or "").strip()
            }
        )
        now = utc_now_iso_z()
        head = str(existing.get("head_agent_code") or "").strip()
        if head and head not in codes:
            head = ""

        def _work(conn: Any) -> None:
            conn.execute(
                """
                UPDATE evoflow_proactive_roles
                SET department = '', updated_at = ?
                WHERE status != 'archived' AND TRIM(department) = ?
                """,
                (now, name),
            )
            for code in codes:
                conn.execute(
                    """
                    UPDATE evoflow_proactive_roles
                    SET department = ?, updated_at = ?
                    WHERE agent_code = ? AND status != 'archived'
                    """,
                    (name, now, code),
                )
            conn.execute(
                """
                UPDATE evoflow_departments
                SET head_agent_code = ?, updated_at = ?
                WHERE id = ?
                """,
                (head, now, did),
            )

        run_db_transaction(_work)
        listed = DepartmentRepository.list_departments(with_members=True)
        for d in listed:
            if str(d.get("id")) == did:
                return d
        return {**existing, "member_count": len(codes), "members": [], "head_agent_code": head}
