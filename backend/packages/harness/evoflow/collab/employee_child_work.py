"""Origin-session child_work for employee calls (bottom-dock avatar icons).

Registers on the *caller's* chat session (not the employee duty session), so
``SessionChildWorkIcons`` can show one avatar per running teammate and open
``V4EmployeeProcessPane`` on click.
"""

from __future__ import annotations

import hashlib
import logging
from typing import Any

logger = logging.getLogger(__name__)

KIND_EMPLOYEE = "employee"


def _origin_ref_id(origin_session_key: str, agent_code: str) -> str:
    """work_id is globally unique (kind:ref) — include origin hash so two caller chats
    can each show the same employee without UNIQUE collisions."""
    code = str(agent_code or "").strip()
    origin = str(origin_session_key or "").strip()
    if not code:
        return ""
    if not origin:
        return code
    h = hashlib.sha1(origin.encode("utf-8")).hexdigest()[:8]
    return f"{code}@{h}"[:200]


def _role_title(agent_code: str, role_name: str = "") -> str:
    name = str(role_name or "").strip()
    code = str(agent_code or "").strip()
    if name and name != code:
        return name[:80]
    try:
        from evoflow.admin.agents import get_agent

        display = str(get_agent(code).get("agent_name") or "").strip()
        if display:
            return display[:80]
    except Exception:
        pass
    return code[:80] or "员工"


def _is_employee_owned_session(session_key: str, agent_code: str) -> bool:
    sk = str(session_key or "").strip()
    code = str(agent_code or "").strip()
    if not sk or not code:
        return False
    return sk == f"proactive:{code}" or sk.startswith(f"proactive:{code}:")


def register_origin_employee_child_work(
    *,
    origin_session_key: str,
    agent_code: str,
    role_name: str = "",
    employee_session_key: str = "",
    duty_run_id: str = "",
    task_id: str = "",
    source: str = "",
    goal_preview: str = "",
    status: str = "running",
) -> dict[str, Any] | None:
    """Upsert ``kind=employee`` on the initiator chat (ref_id = agent_code)."""
    origin = str(origin_session_key or "").strip()
    code = str(agent_code or "").strip()
    if not origin or not code:
        return None
    # Icon belongs on the caller screen — never on the employee's own trail.
    if _is_employee_owned_session(origin, code):
        return None
    title = _role_title(code, role_name)
    ref = _origin_ref_id(origin, code)
    extra: dict[str, Any] = {
        "agent_code": code,
        "role_name": title,
        "employee_session_key": str(employee_session_key or "").strip(),
        "duty_run_id": str(duty_run_id or "").strip(),
        "task_id": str(task_id or "").strip(),
        "source": str(source or "").strip(),
        "goal_preview": str(goal_preview or "").strip()[:240],
        "origin_session_key": origin,
    }
    try:
        from evoflow.persistence.session_runtime_repository import safe_register_child_work

        return safe_register_child_work(
            session_key=origin,
            kind=KIND_EMPLOYEE,
            ref_id=ref,
            status=str(status or "running").strip() or "running",
            title=title,
            extra=extra,
        )
    except Exception:
        logger.debug(
            "employee_child_work: register failed origin=%s agent=%s",
            origin,
            code,
            exc_info=True,
        )
        return None


def complete_origin_employee_child_works(
    *,
    agent_code: str,
    duty_run_id: str = "",
    employee_session_key: str = "",
    status: str = "completed",
) -> int:
    """Mark active origin ``employee`` icons done for this agent / duty run."""
    code = str(agent_code or "").strip()
    rid = str(duty_run_id or "").strip()
    emp_sk = str(employee_session_key or "").strip()
    st = str(status or "completed").strip().lower() or "completed"
    if not code and not rid:
        return 0
    try:
        from evoflow.persistence.db import run_db_transaction
        from evoflow.persistence.session_runtime_repository import _loads, upsert_child_work
    except Exception:
        logger.debug("employee_child_work: complete imports failed", exc_info=True)
        return 0

    def _tx(db: Any) -> int:
        rows = db.execute(
            """
            SELECT session_key, ref_id, extra_json
            FROM evoflow_session_child_works
            WHERE kind = ?
              AND status IN ('pending', 'running')
            """,
            (KIND_EMPLOYEE,),
        ).fetchall()
        n = 0
        for row in rows:
            extra = _loads(str(row["extra_json"] or ""))
            row_code = str(extra.get("agent_code") or row["ref_id"] or "").strip()
            row_duty = str(extra.get("duty_run_id") or "").strip()
            row_emp = str(extra.get("employee_session_key") or "").strip()
            match = False
            if rid and row_duty and row_duty == rid:
                match = True
            elif rid and emp_sk and row_emp == emp_sk and (not code or row_code == code):
                match = True
            elif code and row_code == code and (not rid or not row_duty or row_duty == rid):
                match = True
            if not match:
                continue
            sk = str(row["session_key"] or "").strip()
            ref = str(row["ref_id"] or code).strip()
            if not sk or not ref:
                continue
            upsert_child_work(
                session_key=sk,
                kind=KIND_EMPLOYEE,
                ref_id=ref,
                status=st,
                extra={
                    "duty_run_id": rid or row_duty,
                    "employee_session_key": emp_sk or row_emp,
                    "agent_code": row_code or code,
                },
                conn=db,
            )
            n += 1
        return n

    try:
        return int(run_db_transaction(_tx) or 0)
    except Exception:
        logger.debug(
            "employee_child_work: complete failed agent=%s duty=%s",
            code,
            rid,
            exc_info=True,
        )
        return 0


def safe_register_origin_employee_child_work(**kwargs: Any) -> dict[str, Any] | None:
    try:
        return register_origin_employee_child_work(**kwargs)
    except Exception:
        logger.debug("employee_child_work: safe register failed", exc_info=True)
        return None


def soft_session_end_may_complete_icons(
    *,
    employee_session_key: str,
    agent_code: str = "",
    run_status: str = "",
    reason: str = "",
) -> bool:
    """Block premature icon clear on sticky idle/done before the employee replies."""
    st = str(run_status or "").strip().lower()
    why = str(reason or "").strip().lower()
    soft = st in {"done", "idle"} or "langgraph_idle" in why
    if not soft:
        return True
    emp_sk = str(employee_session_key or "").strip()
    code = str(agent_code or "").strip()
    if not emp_sk:
        return False
    try:
        from evoflow.persistence.db import get_db
        from evoflow.persistence.session_runtime_repository import _loads

        rows = get_db().execute(
            """
            SELECT ref_id, updated_at, extra_json
            FROM evoflow_session_child_works
            WHERE kind = ?
              AND status IN ('pending', 'running')
            """,
            (KIND_EMPLOYEE,),
        ).fetchall()
        since: str | None = None
        for row in rows or []:
            extra = _loads(str(row["extra_json"] or ""))
            row_code = str(extra.get("agent_code") or row["ref_id"] or "").strip()
            if row_code.startswith(f"{code}@") if code else False:
                row_code = code
            row_emp = str(extra.get("employee_session_key") or "").strip()
            ref = str(row["ref_id"] or "")
            match = row_emp == emp_sk or (
                bool(code)
                and (
                    row_code == code
                    or ref == code
                    or ref.startswith(f"{code}@")
                )
            )
            if not match:
                continue
            ts = str(row["updated_at"] or "").strip()
            if ts and (since is None or ts < since):
                since = ts
        if not since:
            # No active icon → nothing to protect; allow no-op complete.
            return True
        hit = get_db().execute(
            """
            SELECT 1 FROM evoflow_chat_messages
            WHERE session_key = ?
              AND role = 'assistant'
              AND created_at > ?
              AND TRIM(COALESCE(content_json, '')) NOT IN ('', '{}', '{"content":""}')
            LIMIT 1
            """,
            (emp_sk, since),
        ).fetchone()
        return hit is not None
    except Exception:
        logger.debug(
            "employee_child_work: soft complete gate failed session=%s",
            emp_sk,
            exc_info=True,
        )
        # Fail closed on soft terminals so icons are not cleared by a heal race.
        return False


def safe_complete_origin_employee_child_works(**kwargs: Any) -> int:
    try:
        return complete_origin_employee_child_works(**kwargs)
    except Exception:
        logger.debug("employee_child_work: safe complete failed", exc_info=True)
        return 0
