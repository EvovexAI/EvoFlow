"""Persistence layer for the proactive module.

All DB access goes through ``evoflow.persistence.db.get_db()`` - same pattern
as ``automation_repositories.py``.
"""

from __future__ import annotations

import json
import logging
import uuid
from typing import Any

from evoflow.persistence.db import get_db, run_db_transaction
from evoflow.proactive.models import (
    Approval,
    ApprovalStatus,
    Initiative,
    InitiativeActionType,
    InitiativeRiskLevel,
    InitiativeStatus,
    ProactiveAutonomyLevel,
    ProactiveMemory,
    ProactiveRole,
    ProactiveRoleConfig,
)
from evoflow.timeutil import utc_now_iso_z

logger = logging.getLogger(__name__)

_ROLE_COLS = """
    agent_code, role_name, position_code, department, config_json, reports_to,
    heartbeat_rrule, heartbeat_schedule, status, last_heartbeat_at, next_heartbeat_at,
    created_at, updated_at
"""

_INIT_COLS = """
    id, role_agent_code, title, description, rationale,
    action_type, risk_level, action_plan_json, expected_outcome,
    status, approval_id, approved_by, approved_at,
    approval_timeout_minutes, execution_thread_id, execution_result,
    round_id, goal, outcome,
    config_autonomy_level,
    created_at, updated_at
"""

_APPROVAL_COLS = """
    id, initiative_id, role_agent_code, channel,
    feishu_message_id, status, decided_by, decided_at,
    decision_comment, rejection_reason, escalation_level, task_id, created_at, updated_at
"""


def _row_dict(row: Any) -> dict[str, Any]:
    return {k: row[k] for k in row.keys()}


def _sanitize_role_text(value: Any, *, fallback: str = "") -> str:
    """Normalize DB/API text; never persist Python ``str(None)`` as ``\"None\"``."""
    if value is None:
        return fallback
    text = str(value).strip()
    if not text or text.casefold() in {"none", "null", "undefined"}:
        return fallback
    return text


def _agent_display_name(agent_code: str) -> str:
    """Best-effort Chinese/display name from the agents table (never the raw code)."""
    code = _sanitize_role_text(agent_code)
    if not code:
        return ""
    try:
        from evoflow.admin.agents import get_agent

        row = get_agent(code)
        name = _sanitize_role_text(row.get("agent_name"))
        if name and name != code:
            return name
    except Exception:
        logger.debug("proactive: agent display name lookup failed code=%s", code, exc_info=True)
    return ""


def _preferred_role_display_name(agent_code: str, role_name: Any, *, agent_name: str = "") -> str:
    """Job title only: keep real ``role_name``; never substitute agent_name or agent_code.

    ``agent_name`` is accepted for call-site compat but ignored — 岗位名 ≠ 智能体名.
    Collapsed ``role_name == agent_code`` / empty → empty string (UI shows 未命名岗位).
    """
    del agent_name  # explicit: do not fall back to agent display name
    code = _sanitize_role_text(agent_code)
    name = _sanitize_role_text(role_name)
    if name and name != code:
        return name
    return ""


# ═══════════════════════════════════════════════════════════════════════
#  Roles
# ═══════════════════════════════════════════════════════════════════════


def _row_to_role(row: dict[str, Any]) -> ProactiveRole:
    cfg = ProactiveRoleConfig.from_json(str(row["config_json"] or "{}"))
    # Column is canonical; keep config.reports_to aligned for prompts / JSON APIs.
    col_mgr = str(row.get("reports_to") or "").strip()
    cfg_mgr = str(getattr(cfg, "reports_to", "") or "").strip()
    cfg.reports_to = col_mgr or cfg_mgr
    agent_code = _sanitize_role_text(row.get("agent_code"))
    role_name = _preferred_role_display_name(agent_code, row.get("role_name"))
    return ProactiveRole(
        agent_code=agent_code,
        role_name=role_name,
        position_code=_sanitize_role_text(row.get("position_code")),
        department=_sanitize_role_text(row.get("department")),
        config=cfg,
        heartbeat_rrule=str(row["heartbeat_rrule"] or "FREQ=HOURLY;INTERVAL=2"),
        heartbeat_schedule=str(row.get("heartbeat_schedule") or ""),
        status=str(row["status"] or "active"),
        last_heartbeat_at=str(row["last_heartbeat_at"]) if row["last_heartbeat_at"] else None,
        next_heartbeat_at=str(row["next_heartbeat_at"]) if row["next_heartbeat_at"] else None,
        created_at=str(row["created_at"] or ""),
        updated_at=str(row["updated_at"] or ""),
    )


def _heal_role_schedule_if_needed(role: ProactiveRole) -> ProactiveRole:
    """Lazy persist: rewrite legacy RRULE → cron once without requiring a manual migrate."""
    from evoflow.proactive.schedule import ensure_role_schedule_fields

    if not ensure_role_schedule_fields(role):
        return role
    try:
        ProactiveRepository.save_role(role)
    except Exception:
        logger.debug(
            "proactive: schedule heal persist failed code=%s",
            getattr(role, "agent_code", ""),
            exc_info=True,
        )
    return role


def _heal_role_display_name_if_needed(role: ProactiveRole, *, raw_role_name: str = "") -> ProactiveRole:
    """No-op: never persist agent_name into role_name (岗位名不可被智能体名回填)."""
    del raw_role_name
    return role


def _role_reports_to(role: ProactiveRole) -> str:
    return str(getattr(getattr(role, "config", None), "reports_to", "") or "").strip()


class ProactiveRepository:
    """CRUD for roles, initiatives, and approvals."""

    # ── Roles ──────────────────────────────────────────────────

    @staticmethod
    def list_roles(*, status: str | None = None) -> list[ProactiveRole]:
        sql = f"SELECT {_ROLE_COLS.strip()} FROM evoflow_proactive_roles"
        params: tuple[Any, ...] = ()
        if status:
            sql += " WHERE status = ?"
            params = (status,)
        sql += " ORDER BY created_at"
        rows = get_db().execute(sql, params).fetchall()
        out: list[ProactiveRole] = []
        for r in rows:
            raw = _row_dict(r)
            role = _row_to_role(raw)
            role = _heal_role_display_name_if_needed(
                role, raw_role_name=_sanitize_role_text(raw.get("role_name"))
            )
            out.append(_heal_role_schedule_if_needed(role))
        return out

    @staticmethod
    def get_role(agent_code: str) -> ProactiveRole | None:
        row = (
            get_db()
            .execute(
                f"SELECT {_ROLE_COLS.strip()} FROM evoflow_proactive_roles WHERE agent_code = ?",
                (agent_code.strip(),),
            )
            .fetchone()
        )
        if not row:
            return None
        raw = _row_dict(row)
        role = _row_to_role(raw)
        role = _heal_role_display_name_if_needed(
            role, raw_role_name=_sanitize_role_text(raw.get("role_name"))
        )
        return _heal_role_schedule_if_needed(role)

    @staticmethod
    def save_role(role: ProactiveRole) -> None:
        from evoflow.proactive.schedule import ensure_role_schedule_fields

        ensure_role_schedule_fields(role)
        now = utc_now_iso_z()
        agent_code = _sanitize_role_text(getattr(role, "agent_code", None))
        if not agent_code:
            raise ValueError("Cannot save proactive role with empty agent_code")
        role.agent_code = agent_code
        # Keep real job titles only; never fold agent_name / agent_code into role_name.
        role.role_name = _preferred_role_display_name(agent_code, getattr(role, "role_name", None))
        role.position_code = _sanitize_role_text(getattr(role, "position_code", None))
        role.department = _sanitize_role_text(getattr(role, "department", None))
        reports_to = _role_reports_to(role)
        role.config.reports_to = reports_to
        config_json = role.config.to_json()
        get_db().execute(
            f"""
            INSERT INTO evoflow_proactive_roles ({_ROLE_COLS.strip()})
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(agent_code) DO UPDATE SET
                role_name = excluded.role_name,
                position_code = excluded.position_code,
                department = excluded.department,
                config_json = excluded.config_json,
                reports_to = excluded.reports_to,
                heartbeat_rrule = excluded.heartbeat_rrule,
                heartbeat_schedule = excluded.heartbeat_schedule,
                status = excluded.status,
                last_heartbeat_at = excluded.last_heartbeat_at,
                next_heartbeat_at = excluded.next_heartbeat_at,
                updated_at = excluded.updated_at
            """,
            (
                role.agent_code,
                role.role_name,
                role.position_code,
                role.department,
                config_json,
                reports_to,
                role.heartbeat_rrule,
                str(getattr(role, "heartbeat_schedule", "") or ""),
                role.status,
                role.last_heartbeat_at,
                role.next_heartbeat_at,
                role.created_at or now,
                now,
            ),
        )
        get_db().commit()

    @staticmethod
    def delete_role(agent_code: str) -> bool:
        """Cascade-safe delete of a duty role.

        Guards:
        - Rejects when the role still has direct reports (``reports_to`` → self).
        - Best-effort cancels in-flight patrol via ``runner.cancel_role``.
        - Cascade-deletes child rows: initiatives, approvals, memory, cost_log.
        - Cleans chat session data under ``proactive:{agent_code}``.
        """
        code = str(agent_code or "").strip()
        if not code:
            return False

        db = get_db()

        # 1. Reject if this role is still someone's direct manager.
        subs = (
            db.execute(
                "SELECT agent_code, role_name FROM evoflow_proactive_roles "
                "WHERE reports_to = ? AND agent_code != ?",
                (code, code),
            )
            .fetchall()
        )
        if subs:
            names = "、".join(
                f"`{str(r[0] or '')}`（{str(r[1] or '')}）" for r in subs[:8]
            )
            more = f" 等 {len(subs)} 个" if len(subs) > 8 else ""
            raise ValueError(
                f"无法删除岗位：请先处理下级岗位的汇报关系。"
                f"该岗位仍有 {len(subs)} 个下级岗位：{names}{more}。"
            )

        # 2. Best-effort cancel any in-flight patrol (idempotent, non-fatal).
        try:
            from evoflow.proactive.runner import get_proactive_runner

            runner = get_proactive_runner()
            import asyncio

            try:
                asyncio.get_running_loop()
                # We're inside an async context (API/router) — can await.
                asyncio.ensure_future(runner.cancel_role(code))
            except RuntimeError:
                # Sync context: run cancellation synchronously if not running,
                # otherwise best-effort skip.
                try:
                    asyncio.run(runner.cancel_role(code))
                except Exception:
                    logger.debug(
                        "proactive.role.delete cancel_role sync failed code=%s",
                        code,
                        exc_info=True,
                    )
        except Exception:
            logger.debug(
                "proactive.role.delete cancel_role skipped code=%s",
                code,
                exc_info=True,
            )

        # 3. Cascade-delete child tables in FK-safe order.
        # approvals.initiative_id → initiatives.id → roles.agent_code
        # Old code deleted initiatives first; with PRAGMA foreign_keys=ON that
        # fails, the error was swallowed, and DELETE role then raised IntegrityError.
        try:
            db.execute(
                """
                DELETE FROM evoflow_proactive_approvals
                WHERE role_agent_code = ?
                   OR initiative_id IN (
                        SELECT id FROM evoflow_proactive_initiatives
                        WHERE role_agent_code = ?
                   )
                """,
                (code, code),
            )
        except Exception as e:
            logger.debug("proactive.role.delete cascade skip approvals: %s", e)

        for table in (
            "evoflow_proactive_initiatives",
            "evoflow_proactive_memory",
            "evoflow_proactive_cost_log",
        ):
            try:
                db.execute(
                    f"DELETE FROM {table} WHERE role_agent_code = ?",
                    (code,),
                )
            except Exception as e:
                logger.debug(
                    "proactive.role.delete cascade skip %s: %s", table, e
                )

        # 4. Clean chat session data under ``proactive:{code}`` (+ duty/task/chat children).
        try:
            from evoflow.persistence import session_repositories as sess_repo
            from evoflow.proactive.chat_session import (
                list_employee_conversation_sessions,
                proactive_session_key,
            )

            wipe_keys: list[str] = []
            sk0 = proactive_session_key(code)
            if sk0:
                wipe_keys.append(sk0)
            for crow in list_employee_conversation_sessions(code, limit=200):
                k = str(crow.get("session_key") or "").strip()
                if k and k not in wipe_keys:
                    wipe_keys.append(k)

            if wipe_keys:
                import asyncio

                from evoflow.persistence import chat_message_repositories as msg_repo
                from evoflow.persistence.chat_session_service import delete_session_full

                async def _wipe_sessions() -> None:
                    for sk in wipe_keys:
                        try:
                            await delete_session_full(sk)
                        except Exception:
                            try:
                                msg_repo.delete_messages_for_session(sk)
                                sess_repo.mark_session_deleted(sk)
                            except Exception:
                                logger.debug(
                                    "proactive.role.delete session wipe fallback failed sk=%s",
                                    sk,
                                    exc_info=True,
                                )

                try:
                    asyncio.get_running_loop()
                    asyncio.ensure_future(_wipe_sessions())
                except RuntimeError:
                    try:
                        asyncio.run(_wipe_sessions())
                    except Exception:
                        logger.debug(
                            "proactive.role.delete session wipe sync failed",
                            exc_info=True,
                        )
        except Exception:
            logger.debug(
                "proactive.role.delete chat session cleanup skipped code=%s",
                code,
                exc_info=True,
            )

        # 5. Delete the role row.
        cur = db.execute(
            "DELETE FROM evoflow_proactive_roles WHERE agent_code = ?",
            (code,),
        )
        db.commit()
        deleted = cur.rowcount > 0
        if deleted:
            logger.info(
                "proactive.role.deleted code=%s (cascade clean done)",
                code,
            )
        return deleted

    @staticmethod
    def rebind_role(old_agent_code: str, new_agent_code: str) -> ProactiveRole:
        """Move a duty contract to another Agent (PK = agent_code).

        Copies the role row, rewrites child ``role_agent_code`` refs, then
        deletes the old role. Does not touch chat history under
        ``proactive:{old}``.
        """
        old_code = str(old_agent_code or "").strip()
        new_code = str(new_agent_code or "").strip()
        if not old_code or not new_code:
            raise ValueError("old_agent_code and new_agent_code are required")
        if old_code == new_code:
            role = ProactiveRepository.get_role(old_code)
            if not role:
                raise KeyError(f"Role '{old_code}' not found")
            return role

        role = ProactiveRepository.get_role(old_code)
        if not role:
            raise KeyError(f"Role '{old_code}' not found")
        if ProactiveRepository.get_role(new_code):
            raise ValueError(f"Role '{new_code}' already exists")

        now = utc_now_iso_z()
        db = get_db()
        reports_to = _role_reports_to(role)
        role.config.reports_to = reports_to
        db.execute(
            f"""
            INSERT INTO evoflow_proactive_roles ({_ROLE_COLS.strip()})
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
            """,
            (
                new_code,
                role.role_name,
                role.position_code,
                role.department,
                role.config.to_json(),
                reports_to,
                role.heartbeat_rrule,
                str(getattr(role, "heartbeat_schedule", "") or ""),
                role.status,
                role.last_heartbeat_at,
                role.next_heartbeat_at,
                role.created_at or now,
                now,
            ),
        )
        for table in (
            "evoflow_proactive_initiatives",
            "evoflow_proactive_approvals",
            "evoflow_proactive_memory",
            "evoflow_proactive_cost_log",
        ):
            try:
                db.execute(
                    f"UPDATE {table} SET role_agent_code = ? WHERE role_agent_code = ?",
                    (new_code, old_code),
                )
            except Exception as e:
                # cost_log may be absent on very old DBs
                if table.endswith("cost_log"):
                    logger.debug("proactive.rebind skip %s: %s", table, e)
                    continue
                raise
        # Keep memory_json.role_agent_code aligned with the row PK after rebind.
        try:
            mem_row = db.execute(
                "SELECT memory_json FROM evoflow_proactive_memory WHERE role_agent_code = ?",
                (new_code,),
            ).fetchone()
            if mem_row is not None:
                raw = str(mem_row[0] if not hasattr(mem_row, "keys") else mem_row["memory_json"] or "")
                try:
                    blob = json.loads(raw) if raw.strip() else {}
                except Exception:
                    blob = {}
                if isinstance(blob, dict) and blob.get("role_agent_code") != new_code:
                    blob["role_agent_code"] = new_code
                    db.execute(
                        "UPDATE evoflow_proactive_memory SET memory_json = ?, updated_at = ? "
                        "WHERE role_agent_code = ?",
                        (json.dumps(blob, ensure_ascii=False), now, new_code),
                    )
        except Exception:
            logger.debug("proactive.rebind memory_json rewrite skipped", exc_info=True)
        # Point direct reports at the rebound code (column + config_json).
        peers = db.execute(
            "SELECT agent_code, config_json FROM evoflow_proactive_roles "
            "WHERE reports_to = ? AND agent_code != ?",
            (old_code, new_code),
        ).fetchall()
        for peer in peers:
            peer_code = str(peer[0] or "").strip()
            try:
                cfg = json.loads(peer[1] or "{}")
            except Exception:
                cfg = {}
            if not isinstance(cfg, dict):
                cfg = {}
            cfg["reports_to"] = new_code
            db.execute(
                "UPDATE evoflow_proactive_roles "
                "SET reports_to = ?, config_json = ?, updated_at = ? WHERE agent_code = ?",
                (new_code, json.dumps(cfg, ensure_ascii=False), now, peer_code),
            )
        db.execute(
            "DELETE FROM evoflow_proactive_roles WHERE agent_code = ?",
            (old_code,),
        )
        db.commit()
        rebound = ProactiveRepository.get_role(new_code)
        if not rebound:
            raise RuntimeError(f"Rebind failed: role '{new_code}' missing after migrate")
        logger.info(
            "proactive.role.rebound old=%s new=%s name=%s",
            old_code,
            new_code,
            rebound.role_name,
        )
        return rebound

    @staticmethod
    def list_due_roles(now_iso: str) -> list[ProactiveRole]:
        """Roles whose next_heartbeat_at is due.

        Compares parsed instants (not raw ISO strings) so legacy UTC ``Z``
        timestamps and Beijing ``+08:00`` values stay consistent.

        Roles with a null/empty ``next_heartbeat_at`` are **not** treated as
        immediately due (that stampeded every restart). Instead we backfill the
        next cron slot and skip this tick.
        """
        from evoflow.proactive.schedule import compute_next_duty_iso
        from evoflow.timeutil import parse_iso_to_ms

        now_ms = parse_iso_to_ms(now_iso)
        rows = (
            get_db()
            .execute(
                f"""
                SELECT {_ROLE_COLS.strip()} FROM evoflow_proactive_roles
                WHERE status = 'active'
                ORDER BY next_heartbeat_at NULLS FIRST
                """
            )
            .fetchall()
        )
        due: list[ProactiveRole] = []
        for r in rows:
            role = _row_to_role(_row_dict(r))
            code = str(role.agent_code or "").strip()
            if not code or code.lower() == "none":
                continue
            if getattr(role.config, "auto_patrol_suspended", False):
                continue
            nh = str(role.next_heartbeat_at or "").strip()
            if not nh:
                # Schedule forward; do not fire on this tick.
                try:
                    nxt = compute_next_duty_iso(role)
                    ProactiveRepository.update_heartbeat(
                        code,
                        last_heartbeat_at=role.last_heartbeat_at or now_iso,
                        next_heartbeat_at=nxt,
                    )
                    role.next_heartbeat_at = nxt
                except Exception:
                    logger.debug(
                        "proactive.list_due_roles: backfill next failed role=%s",
                        code,
                        exc_info=True,
                    )
                continue
            nh_ms = parse_iso_to_ms(nh)
            if nh_ms <= 0 or (now_ms > 0 and nh_ms <= now_ms):
                due.append(role)
        return due

    @staticmethod
    def update_heartbeat_in_txn(
        db: Any,
        agent_code: str,
        *,
        last_heartbeat_at: str,
        next_heartbeat_at: str | None,
    ) -> None:
        """Internal: execute UPDATE without commit (for batch transaction)."""
        db.execute(
            """
            UPDATE evoflow_proactive_roles
            SET last_heartbeat_at = ?, next_heartbeat_at = ?, updated_at = ?
            WHERE agent_code = ?
            """,
            (last_heartbeat_at, next_heartbeat_at, utc_now_iso_z(), agent_code),
        )

    @staticmethod
    def update_heartbeat(
        agent_code: str,
        *,
        last_heartbeat_at: str,
        next_heartbeat_at: str | None,
    ) -> None:
        run_db_transaction(
            lambda db: ProactiveRepository.update_heartbeat_in_txn(
                db, agent_code, last_heartbeat_at=last_heartbeat_at, next_heartbeat_at=next_heartbeat_at
            )
        )

    # ── Initiatives ────────────────────────────────────────────

    @staticmethod
    def _row_to_initiative(row: dict[str, Any]) -> Initiative:
        action_plan = {}
        raw_plan = row.get("action_plan_json") or "{}"
        try:
            action_plan = json.loads(raw_plan) if isinstance(raw_plan, str) else (raw_plan or {})
        except (json.JSONDecodeError, TypeError):
            action_plan = {}
        return Initiative(
            id=str(row["id"]),
            role_agent_code=str(row["role_agent_code"]),
            title=str(row["title"]),
            description=str(row["description"]),
            rationale=str(row["rationale"] or ""),
            action_type=InitiativeActionType(str(row["action_type"] or "analysis")),
            risk_level=InitiativeRiskLevel(str(row["risk_level"] or "low")),
            action_plan=action_plan,
            expected_outcome=str(row["expected_outcome"] or ""),
            status=InitiativeStatus(str(row["status"] or "proposed")),
            approval_id=str(row["approval_id"]) if row["approval_id"] else None,
            approved_by=str(row["approved_by"]) if row["approved_by"] else None,
            approved_at=str(row["approved_at"]) if row["approved_at"] else None,
            approval_timeout_minutes=int(row["approval_timeout_minutes"] or 30),
            execution_thread_id=str(row["execution_thread_id"]) if row["execution_thread_id"] else None,
            execution_result=str(row["execution_result"]) if row["execution_result"] else None,
            round_id=str(row["round_id"]) if row["round_id"] else None,
            goal=str(row["goal"] or ""),
            outcome=str(row["outcome"] or ""),
            config_autonomy_level=ProactiveAutonomyLevel(str(row["config_autonomy_level"] or "approval_for_risky")),
            created_at=str(row["created_at"] or ""),
            updated_at=str(row["updated_at"] or ""),
        )

    @staticmethod
    def list_initiatives(
        *,
        role_agent_code: str | None = None,
        status: str | None = None,
        limit: int = 50,
        offset: int = 0,
    ) -> list[Initiative]:
        sql = f"SELECT {_INIT_COLS.strip()} FROM evoflow_proactive_initiatives WHERE 1=1"
        params: list[Any] = []
        if role_agent_code:
            sql += " AND role_agent_code = ?"
            params.append(role_agent_code)
        if status:
            sql += " AND status = ?"
            params.append(status)
        sql += " ORDER BY created_at DESC LIMIT ? OFFSET ?"
        params.extend([limit, offset])
        rows = get_db().execute(sql, params).fetchall()
        return [ProactiveRepository._row_to_initiative(_row_dict(r)) for r in rows]

    @staticmethod
    def get_initiative(initiative_id: str) -> Initiative | None:
        row = (
            get_db()
            .execute(
                f"SELECT {_INIT_COLS.strip()} FROM evoflow_proactive_initiatives WHERE id = ?",
                (initiative_id.strip(),),
            )
            .fetchone()
        )
        return ProactiveRepository._row_to_initiative(_row_dict(row)) if row else None

    @staticmethod
    def save_initiative_in_txn(db: Any, init: Initiative) -> None:
        """Internal: execute INSERT/UPDATE without commit (for batch transaction)."""
        now = utc_now_iso_z()
        db.execute(
            f"""
            INSERT INTO evoflow_proactive_initiatives ({_INIT_COLS.strip()})
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(id) DO UPDATE SET
                title = excluded.title,
                description = excluded.description,
                rationale = excluded.rationale,
                action_type = excluded.action_type,
                risk_level = excluded.risk_level,
                action_plan_json = excluded.action_plan_json,
                expected_outcome = excluded.expected_outcome,
                status = excluded.status,
                approval_id = excluded.approval_id,
                approved_by = excluded.approved_by,
                approved_at = excluded.approved_at,
                approval_timeout_minutes = excluded.approval_timeout_minutes,
                execution_thread_id = excluded.execution_thread_id,
                execution_result = excluded.execution_result,
                round_id = excluded.round_id,
                goal = excluded.goal,
                outcome = excluded.outcome,
                config_autonomy_level = excluded.config_autonomy_level,
                updated_at = excluded.updated_at
            """,
            (
                init.id,
                init.role_agent_code,
                init.title,
                init.description,
                init.rationale,
                init.action_type.value,
                init.risk_level.value,
                json.dumps(init.action_plan, ensure_ascii=False),
                init.expected_outcome,
                init.status.value,
                init.approval_id,
                init.approved_by,
                init.approved_at,
                init.approval_timeout_minutes,
                init.execution_thread_id,
                init.execution_result,
                init.round_id,
                init.goal,
                init.outcome,
                init.config_autonomy_level.value,
                init.created_at or now,
                now,
            ),
        )

    @staticmethod
    def save_initiative(init: Initiative) -> None:
        run_db_transaction(lambda db: ProactiveRepository.save_initiative_in_txn(db, init))

    @staticmethod
    def update_initiative_status(
        initiative_id: str,
        status: InitiativeStatus,
        *,
        approved_by: str | None = None,
        execution_result: str | None = None,
    ) -> None:
        sets = ["status = ?", "updated_at = ?"]
        params: list[Any] = [status.value, utc_now_iso_z()]
        if approved_by:
            sets.append("approved_by = ?")
            params.append(approved_by)
        if execution_result:
            sets.append("execution_result = ?")
            params.append(execution_result)
        params.append(initiative_id)
        get_db().execute(
            f"UPDATE evoflow_proactive_initiatives SET {', '.join(sets)} WHERE id = ?",
            params,
        )
        get_db().commit()

    @staticmethod
    def new_initiative_id() -> str:
        return f"init_{uuid.uuid4().hex[:12]}"

    # ── Approvals ──────────────────────────────────────────────

    @staticmethod
    def _row_to_approval(row: dict[str, Any]) -> Approval:
        keys = row.keys() if hasattr(row, "keys") else row
        return Approval(
            id=str(row["id"]),
            initiative_id=str(row["initiative_id"] or ""),
            role_agent_code=str(row["role_agent_code"]),
            channel=str(row["channel"] or "feishu"),
            feishu_message_id=str(row["feishu_message_id"]) if row["feishu_message_id"] else None,
            status=ApprovalStatus(str(row["status"] or "pending")),
            decided_by=str(row["decided_by"]) if row["decided_by"] else None,
            decided_at=str(row["decided_at"]) if row["decided_at"] else None,
            decision_comment=str(row["decision_comment"] or ""),
            rejection_reason=str(row["rejection_reason"] or "") if "rejection_reason" in keys else "",
            escalation_level=int(row["escalation_level"] or 0),
            task_id=str(row["task_id"] or "") if "task_id" in keys else "",
            created_at=str(row["created_at"] or ""),
            updated_at=str(row["updated_at"] or ""),
        )

    @staticmethod
    def list_approvals(*, status: str | None = None, limit: int = 50) -> list[Approval]:
        sql = f"SELECT {_APPROVAL_COLS.strip()} FROM evoflow_proactive_approvals WHERE 1=1"
        params: list[Any] = []
        if status:
            sql += " AND status = ?"
            params.append(status)
        sql += " ORDER BY created_at DESC LIMIT ?"
        params.append(limit)
        rows = get_db().execute(sql, params).fetchall()
        return [ProactiveRepository._row_to_approval(_row_dict(r)) for r in rows]

    @staticmethod
    def get_approval(approval_id: str) -> Approval | None:
        row = (
            get_db()
            .execute(
                f"SELECT {_APPROVAL_COLS.strip()} FROM evoflow_proactive_approvals WHERE id = ?",
                (approval_id.strip(),),
            )
            .fetchone()
        )
        return ProactiveRepository._row_to_approval(_row_dict(row)) if row else None

    @staticmethod
    def get_approval_by_initiative(initiative_id: str) -> Approval | None:
        row = (
            get_db()
            .execute(
                f"SELECT {_APPROVAL_COLS.strip()} FROM evoflow_proactive_approvals "
                "WHERE initiative_id = ? ORDER BY created_at DESC LIMIT 1",
                (initiative_id.strip(),),
            )
            .fetchone()
        )
        return ProactiveRepository._row_to_approval(_row_dict(row)) if row else None

    @staticmethod
    def save_approval(appr: Approval) -> None:
        now = utc_now_iso_z()
        get_db().execute(
            f"""
            INSERT INTO evoflow_proactive_approvals ({_APPROVAL_COLS.strip()})
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(id) DO UPDATE SET
                channel = excluded.channel,
                feishu_message_id = excluded.feishu_message_id,
                status = excluded.status,
                decided_by = excluded.decided_by,
                decided_at = excluded.decided_at,
                decision_comment = excluded.decision_comment,
                rejection_reason = excluded.rejection_reason,
                escalation_level = excluded.escalation_level,
                task_id = excluded.task_id,
                updated_at = excluded.updated_at
            """,
            (
                appr.id,
                appr.initiative_id or "",
                appr.role_agent_code,
                appr.channel,
                appr.feishu_message_id,
                appr.status.value,
                appr.decided_by,
                appr.decided_at,
                appr.decision_comment,
                appr.rejection_reason,
                appr.escalation_level,
                appr.task_id or "",
                appr.created_at or now,
                now,
            ),
        )
        get_db().commit()

    @staticmethod
    def get_approval_by_task(task_id: str) -> Approval | None:
        tid = str(task_id or "").strip()
        if not tid:
            return None
        row = (
            get_db()
            .execute(
                f"SELECT {_APPROVAL_COLS.strip()} FROM evoflow_proactive_approvals "
                "WHERE task_id = ? ORDER BY created_at DESC LIMIT 1",
                (tid,),
            )
            .fetchone()
        )
        return ProactiveRepository._row_to_approval(_row_dict(row)) if row else None

    @staticmethod
    def new_approval_id() -> str:
        return f"appr_{uuid.uuid4().hex[:12]}"

    @staticmethod
    def list_pending_approvals() -> list[Approval]:
        return ProactiveRepository.list_approvals(status="pending")

    @staticmethod
    def list_stale_executing(
        *,
        max_age_minutes: int | None = None,
        max_age_hours: float | None = None,
        limit: int = 100,
    ) -> list[Initiative]:
        """Find initiatives stuck in 'executing' longer than the TTL.

        Default TTL is **45 minutes** (was 6h) so zombie check_in journals stop
        poisoning the next duty cycle's work log within one heartbeat window.
        ``max_age_hours`` is kept as a backward-compatible alias.
        """
        from evoflow.timeutil import parse_iso_to_ms

        if max_age_minutes is None:
            if max_age_hours is not None:
                max_age_minutes = max(1, int(float(max_age_hours) * 60))
            else:
                max_age_minutes = 45
        cutoff_ms = parse_iso_to_ms(utc_now_iso_z()) - int(max_age_minutes) * 60_000
        rows = (
            get_db()
            .execute(
                f"SELECT {_INIT_COLS.strip()} FROM evoflow_proactive_initiatives "
                "WHERE status = 'executing' ORDER BY updated_at DESC LIMIT ?",
                (limit,),
            )
            .fetchall()
        )
        stale: list[Initiative] = []
        for r in rows:
            init = ProactiveRepository._row_to_initiative(_row_dict(r))
            ts = str(init.updated_at or init.created_at or "")
            if parse_iso_to_ms(ts) <= cutoff_ms:
                stale.append(init)
        return stale


# ═══════════════════════════════════════════════════════════════════════
#  Memory
# ═══════════════════════════════════════════════════════════════════════


class ProactiveMemoryRepository:
    """Per-role long-term memory."""

    @staticmethod
    def get(role_agent_code: str) -> ProactiveMemory:
        row = (
            get_db()
            .execute(
                "SELECT memory_json FROM evoflow_proactive_memory WHERE role_agent_code = ?",
                (role_agent_code.strip(),),
            )
            .fetchone()
        )
        if not row:
            return ProactiveMemory(role_agent_code=role_agent_code)
        return ProactiveMemory.from_json(role_agent_code, str(row["memory_json"] or "{}"))

    @staticmethod
    def save_in_txn(db: Any, memory: ProactiveMemory) -> None:
        """Internal: execute INSERT/UPDATE without commit (for batch transaction)."""
        db.execute(
            """
            INSERT INTO evoflow_proactive_memory (role_agent_code, memory_json, updated_at)
            VALUES (?,?,?)
            ON CONFLICT(role_agent_code) DO UPDATE SET
                memory_json = excluded.memory_json,
                updated_at = excluded.updated_at
            """,
            (memory.role_agent_code, memory.to_json(), utc_now_iso_z()),
        )

    @staticmethod
    def save(memory: ProactiveMemory) -> None:
        run_db_transaction(lambda db: ProactiveMemoryRepository.save_in_txn(db, memory))

    @staticmethod
    def append_observation(role_agent_code: str, observation: str) -> None:
        mem = ProactiveMemoryRepository.get(role_agent_code)
        mem.observations.append(observation)
        # Keep last 100 observations
        if len(mem.observations) > 100:
            mem.observations = mem.observations[-100:]
        ProactiveMemoryRepository.save(mem)

    @staticmethod
    def update_after_think_in_txn(
        db: Any,
        role_agent_code: str,
        *,
        new_observations: list[str],
        reflection: str,
        completed: int = 0,
        failed: int = 0,
    ) -> ProactiveMemory:
        """Internal: update memory without commit (for batch transaction)."""
        mem = ProactiveMemoryRepository.get(role_agent_code)
        mem.observations.extend(new_observations)
        if len(mem.observations) > 100:
            mem.observations = mem.observations[-100:]
        mem.completed_initiatives += completed
        mem.failed_initiatives += failed
        mem.last_think_at = utc_now_iso_z()
        mem.last_think_summary = reflection[:500]
        ProactiveMemoryRepository.save_in_txn(db, mem)
        return mem

    @staticmethod
    def update_after_think(
        role_agent_code: str,
        *,
        new_observations: list[str],
        reflection: str,
        completed: int = 0,
        failed: int = 0,
    ) -> ProactiveMemory:
        return run_db_transaction(
            lambda db: ProactiveMemoryRepository.update_after_think_in_txn(
                db,
                role_agent_code,
                new_observations=new_observations,
                reflection=reflection,
                completed=completed,
                failed=failed,
            )
        )


# ═══════════════════════════════════════════════════════════════════════
#  Cost log (O2: cost visibility)
# ═══════════════════════════════════════════════════════════════════════


class ProactiveCostRepository:
    """Per-round token consumption and cost tracking."""

    @staticmethod
    def _principal_id_for_agent(role_agent_code: str) -> str | None:
        """Resolve cost attribution principal from agent personal owner_scope."""
        try:
            from evoflow.persistence.config_repositories import get_agent_owner_scope

            _org, owner = get_agent_owner_scope(role_agent_code)
            owner = str(owner or "").strip()
            if owner.startswith("personal:"):
                return owner[len("personal:") :] or None
        except Exception:
            return None
        return None

    @staticmethod
    def log_cost_in_txn(
        db: Any,
        *,
        role_agent_code: str,
        round_id: str = "",
        thread_id: str | None = None,
        model_name: str = "",
        input_tokens: int = 0,
        output_tokens: int = 0,
        total_tokens: int = 0,
        cost_usd: float = 0.0,
        duration_seconds: float = 0.0,
        principal_id: str | None = None,
    ) -> None:
        """Internal: execute INSERT without commit (for batch transaction)."""
        now = utc_now_iso_z()
        pid = (principal_id or "").strip() or ProactiveCostRepository._principal_id_for_agent(
            role_agent_code
        )
        cols = {str(r[1]) for r in db.execute("PRAGMA table_info(evoflow_proactive_cost_log)").fetchall()}
        if "principal_id" in cols:
            db.execute(
                """
                INSERT INTO evoflow_proactive_cost_log
                    (role_agent_code, round_id, thread_id, model_name,
                     input_tokens, output_tokens, total_tokens, cost_usd,
                     duration_seconds, created_at, principal_id)
                VALUES (?,?,?,?,?,?,?,?,?,?,?)
                """,
                (
                    role_agent_code,
                    round_id,
                    thread_id,
                    model_name,
                    input_tokens,
                    output_tokens,
                    total_tokens,
                    cost_usd,
                    duration_seconds,
                    now,
                    pid or "",
                ),
            )
        else:
            db.execute(
                """
                INSERT INTO evoflow_proactive_cost_log
                    (role_agent_code, round_id, thread_id, model_name,
                     input_tokens, output_tokens, total_tokens, cost_usd,
                     duration_seconds, created_at)
                VALUES (?,?,?,?,?,?,?,?,?,?)
                """,
                (
                    role_agent_code,
                    round_id,
                    thread_id,
                    model_name,
                    input_tokens,
                    output_tokens,
                    total_tokens,
                    cost_usd,
                    duration_seconds,
                    now,
                ),
            )

    @staticmethod
    def log_cost(
        *,
        role_agent_code: str,
        round_id: str = "",
        thread_id: str | None = None,
        model_name: str = "",
        input_tokens: int = 0,
        output_tokens: int = 0,
        total_tokens: int = 0,
        cost_usd: float = 0.0,
        duration_seconds: float = 0.0,
        principal_id: str | None = None,
    ) -> None:
        run_db_transaction(
            lambda db: ProactiveCostRepository.log_cost_in_txn(
                db,
                role_agent_code=role_agent_code,
                round_id=round_id,
                thread_id=thread_id,
                model_name=model_name,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                total_tokens=total_tokens,
                cost_usd=cost_usd,
                duration_seconds=duration_seconds,
                principal_id=principal_id,
            )
        )

    @staticmethod
    def get_daily_cost(agent_code: str, date_iso: str | None = None) -> float:
        """Sum cost_usd for a role on a given day (YYYY-MM-DD). Defaults to today."""
        if not date_iso:
            date_iso = utc_now_iso_z()[:10]
        row = get_db().execute(
            "SELECT COALESCE(SUM(cost_usd), 0.0) FROM evoflow_proactive_cost_log "
            "WHERE role_agent_code = ? AND substr(created_at, 1, 10) = ?",
            (agent_code, date_iso),
        ).fetchone()
        return float(row[0]) if row else 0.0

    @staticmethod
    def get_daily_tokens(agent_code: str, date_iso: str | None = None) -> int:
        if not date_iso:
            date_iso = utc_now_iso_z()[:10]
        row = get_db().execute(
            "SELECT COALESCE(SUM(total_tokens), 0) FROM evoflow_proactive_cost_log "
            "WHERE role_agent_code = ? AND substr(created_at, 1, 10) = ?",
            (agent_code, date_iso),
        ).fetchone()
        return int(row[0]) if row else 0

    @staticmethod
    def get_cost_summary(agent_code: str, days: int = 7) -> dict[str, Any]:
        """Return daily cost + token trend for the last N days."""
        rows = get_db().execute(
            "SELECT substr(created_at, 1, 10) day, "
            "COUNT(*) rounds, COALESCE(SUM(cost_usd), 0.0) cost, "
            "COALESCE(SUM(total_tokens), 0) tokens "
            "FROM evoflow_proactive_cost_log "
            "WHERE role_agent_code = ? "
            "GROUP BY day ORDER BY day DESC LIMIT ?",
            (agent_code, days),
        ).fetchall()
        return {
            "role_agent_code": agent_code,
            "days": [
                {
                    "date": r["day"],
                    "rounds": r["rounds"],
                    "cost_usd": round(r["cost"], 6),
                    "total_tokens": r["tokens"],
                }
                for r in rows
            ],
            "total_cost_usd": round(sum(r["cost"] for r in rows), 6),
            "total_tokens": sum(r["tokens"] for r in rows),
        }

    @staticmethod
    def get_round_cost(agent_code: str, round_id: str) -> dict[str, Any]:
        """Sum cost for one duty round (may span multiple cost_log rows)."""
        code = str(agent_code or "").strip()
        rid = str(round_id or "").strip()
        if not code or not rid:
            return {
                "role_agent_code": code,
                "round_id": rid,
                "cost_usd": 0.0,
                "total_tokens": 0,
                "duration_seconds": 0.0,
                "rounds": 0,
            }
        row = get_db().execute(
            """
            SELECT COALESCE(SUM(cost_usd), 0.0) AS cost,
                   COALESCE(SUM(total_tokens), 0) AS tokens,
                   COALESCE(SUM(duration_seconds), 0.0) AS duration,
                   COUNT(*) AS n
            FROM evoflow_proactive_cost_log
            WHERE role_agent_code = ? AND round_id = ?
            """,
            (code, rid),
        ).fetchone()
        return {
            "role_agent_code": code,
            "round_id": rid,
            "cost_usd": round(float(row["cost"] if row else 0), 6),
            "total_tokens": int(row["tokens"] if row else 0),
            "duration_seconds": float(row["duration"] if row else 0),
            "rounds": int(row["n"] if row else 0),
        }
