"""员工前台只读视图：名册汇总 / 跨岗看板 / 单岗简报。

供 ``platform`` ``employees.org_status`` / ``employees.board_overview`` /
``employees.brief`` 使用（原小V专用工具迁入，主智能体与小V同源）。
"""

from __future__ import annotations

import logging
from typing import Any

from evoflow.agents.xiaomi.identity import is_xiaomi_agent

logger = logging.getLogger(__name__)


def active_employee_rows(*, exclude_xiaomi: bool = True) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Active roster rows (+ list_roles meta). Optionally exclude 小V herself."""
    from evoflow.admin import employees as emp

    data = emp.list_roles(status="active")
    roles = data.get("roles") if isinstance(data, dict) else []
    rows: list[dict[str, Any]] = []
    for r in roles or []:
        if not isinstance(r, dict):
            continue
        code = str(r.get("agent_code") or "").strip()
        if exclude_xiaomi and is_xiaomi_agent(code):
            continue
        rows.append(
            {
                "agent_code": code,
                "role_name": r.get("role_name"),
                "department": r.get("department"),
                "busy": bool(r.get("busy")),
                "status": r.get("status"),
                "reports_to": r.get("reports_to"),
                "last_heartbeat_at": r.get("last_heartbeat_at"),
                "next_heartbeat_at": r.get("next_heartbeat_at"),
                "pending_approvals": r.get("pending_approvals"),
            }
        )
    meta = data if isinstance(data, dict) else {}
    return rows, meta


def org_status() -> dict[str, Any]:
    """有多少员工、谁空闲/忙碌、待审批合计。"""
    rows, meta = active_employee_rows()
    busy_n = sum(1 for r in rows if r.get("busy"))
    idle_n = len(rows) - busy_n
    pending_n = sum(int(r.get("pending_approvals") or 0) for r in rows)
    return {
        "ok": True,
        "employee_count": len(rows),
        "busy_count": busy_n,
        "idle_count": idle_n,
        "pending_approvals_total": pending_n,
        "gateway_reachable": bool(meta.get("gateway_reachable")),
        "employees": rows,
        "hint": "先看忙闲再派活；派新目标 employees.dispatch，催已有 Task employees.wake。",
    }


def _is_open_task(task: dict[str, Any]) -> bool:
    st = str(task.get("status") or "").lower()
    if st in {"completed", "reviewed", "cancelled", "canceled", "rejected"}:
        return False
    try:
        prog = int(task.get("progress") or 0)
    except (TypeError, ValueError):
        prog = 0
    return prog < 100


def _task_brief_item(t: dict[str, Any]) -> dict[str, Any]:
    try:
        prog = int(t.get("progress") or 0)
    except (TypeError, ValueError):
        prog = 0
    summary = str(t.get("summary") or "").strip()
    result = t.get("result")
    result_s = ""
    if isinstance(result, str):
        result_s = result.strip()
    elif result is not None:
        result_s = str(result).strip()
    report = summary or result_s
    return {
        "task_id": t.get("task_id") or t.get("id"),
        "name": t.get("name"),
        "status": t.get("status"),
        "progress": prog,
        "assigned_role": t.get("assigned_role") or t.get("role_name"),
        "report": (report[:500] if report else None),
        "updated_at": t.get("updated_at") or t.get("completed_at") or t.get("created_at"),
    }


def board_overview(*, limit_per_role: int = 8) -> dict[str, Any]:
    """各岗未结 Task + stuck_candidates。"""
    from evoflow.admin import tasks as admin_tasks

    lim = max(1, min(20, int(limit_per_role or 8)))
    rows, _meta = active_employee_rows()
    boards: list[dict[str, Any]] = []
    total_open = 0
    stuck: list[dict[str, Any]] = []
    for r in rows:
        name = str(r.get("role_name") or "").strip()
        code = str(r.get("agent_code") or "").strip()
        if not name:
            continue
        try:
            listed = admin_tasks.list_tasks(role=name, include_subtasks=False)
            tasks = list(listed.get("tasks") or [])
        except Exception:
            tasks = []
        open_all = [
            t
            for t in tasks
            if isinstance(t, dict)
            and str(t.get("status") or "").lower()
            not in {"completed", "reviewed", "cancelled", "canceled", "rejected"}
            and int(t.get("progress") or 0) < 100
        ]
        total_open += len(open_all)
        sample = []
        for t in open_all[:lim]:
            try:
                prog = int(t.get("progress") or 0)
            except (TypeError, ValueError):
                prog = 0
            st = str(t.get("status") or "").strip()
            tid = t.get("task_id") or t.get("id")
            item = {
                "task_id": tid,
                "name": t.get("name"),
                "status": st,
                "progress": prog,
            }
            sample.append(item)
            if prog >= 90:
                continue
            if prog < 30 and st.lower() not in {"blocked", "waiting_approval"}:
                stuck.append({"agent_code": code, "role_name": name, "busy": bool(r.get("busy")), **item})
            elif st.lower() in {"blocked", "stalled", "waiting", "paused"}:
                stuck.append({"agent_code": code, "role_name": name, "busy": bool(r.get("busy")), **item})
        boards.append(
            {
                "agent_code": code,
                "role_name": name,
                "busy": bool(r.get("busy")),
                "open_count": len(open_all),
                "tasks": sample,
            }
        )
    return {
        "ok": True,
        "employee_count": len(rows),
        "total_open_tasks": total_open,
        "stuck_candidates": stuck[:24],
        "boards": boards,
        "hint": "关注 stuck_candidates；催办 employees.wake(task_id)；单任务详情 tasks.get。",
    }


def _resolve_employee_code(agent_code_or_name: str) -> tuple[str, str | None]:
    raw = str(agent_code_or_name or "").strip()
    if not raw:
        return "", "agent_code is required"
    if is_xiaomi_agent(raw):
        return "", "cannot inspect xiaomi herself; pick an employee"
    try:
        from evoflow.admin import employees as emp
        from evoflow.admin.errors import NotFoundError

        try:
            detail = emp.get_role(raw, recent_limit=0)
            code = str(detail.get("agent_code") or raw).strip()
            if code and not is_xiaomi_agent(code):
                return code, None
        except NotFoundError:
            pass
        data = emp.list_roles(status="active")
        roles = data.get("roles") if isinstance(data, dict) else []
        needle = raw.lower()
        for r in roles or []:
            if not isinstance(r, dict):
                continue
            code = str(r.get("agent_code") or "").strip()
            name = str(r.get("role_name") or "").strip()
            if is_xiaomi_agent(code):
                continue
            if code.lower() == needle or name.lower() == needle:
                return code, None
        return "", f"employee not found: {raw}"
    except Exception as exc:
        return "", str(exc)


def _condense_work_trail(messages: list[dict[str, Any]], *, max_tools: int = 16) -> dict[str, Any]:
    tools: list[str] = []
    last_assistant = ""
    for m in messages or []:
        if not isinstance(m, dict):
            continue
        role = str(m.get("role") or m.get("type") or "").strip().lower()
        if role in {"tool", "toolresult"}:
            name = str(m.get("tool_name") or m.get("name") or "").strip()
            if not name:
                payload = m.get("content_json")
                if isinstance(payload, dict):
                    name = str(payload.get("name") or payload.get("tool_name") or "").strip()
            if name:
                tools.append(name)
        elif role in {"assistant", "ai"}:
            payload = m.get("content_json")
            text = ""
            if isinstance(payload, str):
                text = payload
            elif isinstance(payload, dict):
                text = str(payload.get("content") or payload.get("text") or "")
                if not text and isinstance(payload.get("parts"), list):
                    bits = []
                    for p in payload["parts"]:
                        if isinstance(p, dict) and p.get("type") in {None, "text", "string"}:
                            bits.append(str(p.get("text") or p.get("content") or ""))
                        elif isinstance(p, str):
                            bits.append(p)
                    text = "".join(bits)
            elif isinstance(payload, list):
                bits = []
                for p in payload:
                    if isinstance(p, dict):
                        bits.append(str(p.get("text") or p.get("content") or ""))
                    elif isinstance(p, str):
                        bits.append(p)
                text = "".join(bits)
            text = str(text or "").strip()
            if text:
                last_assistant = text
    return {
        "tool_sequence": tools[-max(1, min(int(max_tools), 40)) :],
        "tool_count": len(tools),
        "last_assistant_text": (last_assistant[:480] if last_assistant else ""),
    }


def _employee_open_tasks(role_name: str, *, limit: int = 8) -> list[dict[str, Any]]:
    try:
        from evoflow.admin import tasks as admin_tasks

        listed = admin_tasks.list_tasks(role=role_name, include_subtasks=False)
        tasks = list(listed.get("tasks") or [])
    except Exception:
        return []
    open_tasks = [_task_brief_item(t) for t in tasks if isinstance(t, dict) and _is_open_task(t)]
    return open_tasks[: max(1, min(int(limit), 20))]


def _recent_rounds_from_chat(agent_code: str, *, limit: int = 5) -> list[dict[str, Any]]:
    code = str(agent_code or "").strip()
    if not code:
        return []
    sk = f"proactive:{code}"
    try:
        from evoflow.persistence.db import get_db

        rows = (
            get_db()
            .execute(
                """
                SELECT round_id,
                       MIN(created_at) AS first_at,
                       MAX(created_at) AS last_at,
                       COUNT(*) AS msg_n,
                       SUM(CASE WHEN role = 'tool' THEN 1 ELSE 0 END) AS tool_n
                FROM evoflow_chat_messages
                WHERE session_key = ?
                  AND round_id IS NOT NULL
                  AND TRIM(round_id) != ''
                GROUP BY round_id
                ORDER BY last_at DESC
                LIMIT ?
                """,
                (sk, max(1, min(int(limit), 20))),
            )
            .fetchall()
        )
    except Exception:
        return []
    out: list[dict[str, Any]] = []
    for row in rows:
        rid = str(row["round_id"] or "").strip()
        if not rid:
            continue
        msg_n = int(row["msg_n"] or 0)
        tool_n = int(row["tool_n"] or 0)
        kind = "派发" if rid.startswith("dispatch:") else "值班"
        out.append(
            {
                "round_id": rid,
                "title": f"{kind}轮次",
                "outcome": f"本轮轨迹 {msg_n} 条（工具 {tool_n} 次）",
                "updated_at": str(row["last_at"] or row["first_at"] or "").strip() or None,
            }
        )
    return out


def employee_brief(
    agent_code: str,
    *,
    include_trail: bool = True,
    task_limit: int = 8,
) -> dict[str, Any]:
    """某岗忙闲、未结任务、近况、工作轨迹摘要。"""
    from evoflow.admin import employees as emp
    from evoflow.admin.errors import NotFoundError, ValidationError
    from evoflow.proactive.repositories import ProactiveMemoryRepository, ProactiveRepository

    code, err = _resolve_employee_code(agent_code)
    if err:
        raise ValidationError(err)

    try:
        detail = emp.get_role(code, recent_limit=6)
    except NotFoundError as e:
        raise ValidationError(str(e)) from e

    role = ProactiveRepository.get_role(code)
    role_name = str((detail.get("role_name") if isinstance(detail, dict) else None) or code)
    busy = False
    busy_started = ""
    try:
        from evoflow.proactive.runner import get_proactive_runner

        runner = get_proactive_runner()
        busy = bool(runner.is_role_busy(code))
        if busy:
            for row in runner.busy_roles():
                if str(row.get("agent_code") or "") == code:
                    busy_started = str(row.get("started_at") or "")
                    break
    except Exception:
        busy = False

    mem = ProactiveMemoryRepository.get(code)
    open_tasks = _employee_open_tasks(role_name, limit=task_limit)
    recent_inits = []
    for i in list((detail or {}).get("recent_initiatives") or [])[:6]:
        if not isinstance(i, dict):
            continue
        recent_inits.append(
            {
                "id": i.get("id"),
                "title": i.get("title"),
                "status": i.get("status"),
                "result": i.get("result"),
                "action_type": i.get("action_type"),
                "round_id": i.get("round_id"),
                "created_at": i.get("created_at"),
            }
        )

    rounds_meta = _recent_rounds_from_chat(code, limit=5)
    trail: dict[str, Any] | None = None
    if include_trail:
        try:
            from evoflow.persistence.chat_message_repositories import list_messages_for_display_all

            rid = str((rounds_meta[0] or {}).get("round_id") or "").strip() if rounds_meta else ""
            session_key = f"proactive:{code}"
            raw = list_messages_for_display_all(
                session_key,
                max_rows=80,
                round_id=rid or None,
            )
            trail = {
                "round_id": rid or None,
                **_condense_work_trail(list(raw.get("messages") or [])),
            }
        except Exception:
            trail = {"round_id": None, "tool_sequence": [], "tool_count": 0, "last_assistant_text": ""}

    person_brief: dict[str, Any] | None = None
    try:
        from evoflow.person_kernel import desensitized_person_brief

        person_brief = desensitized_person_brief(code)
    except Exception:
        person_brief = None

    return {
        "ok": True,
        "agent_code": code,
        "role_name": role_name,
        "status": detail.get("status") if isinstance(detail, dict) else getattr(role, "status", None),
        "busy": busy,
        "busy_started_at": busy_started or None,
        "last_heartbeat_at": detail.get("last_heartbeat_at") if isinstance(detail, dict) else None,
        "next_heartbeat_at": detail.get("next_heartbeat_at") if isinstance(detail, dict) else None,
        "within_work_hours": detail.get("within_work_hours") if isinstance(detail, dict) else None,
        "last_think_at": getattr(mem, "last_think_at", None),
        "last_think_summary": (str(getattr(mem, "last_think_summary", "") or "").strip()[:600] or None),
        "open_tasks": open_tasks,
        "open_task_count": len(open_tasks),
        "recent_initiatives": recent_inits,
        "recent_rounds": rounds_meta,
        "work_trail": trail,
        "person_workplace": person_brief,
        "hint": (
            "用白话说明忙闲、未结任务与最近在干啥；person_workplace 仅脱敏职场摘要。"
            "单任务 → tasks.get；新派 → employees.dispatch；催办 → employees.wake。"
        ),
        "watch_path": f"/proactive/{code}?live=1",
    }
