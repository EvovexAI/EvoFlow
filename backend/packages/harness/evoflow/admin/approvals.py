"""Proactive work-item approvals — list / request / decide (CLI + admin).

Employees raise approvals with ``request`` (岗位工作项 Task).
Humans decide via ``approve`` / ``reject`` (prefer Gateway so execution runs there).
"""

from __future__ import annotations

import asyncio
import os
from typing import Any

import httpx

from evoflow.admin.errors import NotFoundError, ValidationError
from evoflow.proactive.models import ApprovalStatus
from evoflow.proactive.repositories import ProactiveRepository


def _proactive_api_base() -> str:
    env = (os.getenv("EVOFLOW_PROACTIVE_URL") or "").strip()
    if env:
        return env.rstrip("/")
    lg = (os.getenv("EVOFLOW_LANGGRAPH_URL") or "http://127.0.0.1:8070/api/langgraph").rstrip("/")
    if lg.endswith("/api/langgraph"):
        return lg[: -len("/api/langgraph")] + "/api/proactive"
    return "http://127.0.0.1:8070/api/proactive"


def _resolve_role_for_task(task: dict[str, Any]):
    code = str(task.get("assigned_to") or "").strip()
    if code:
        role = ProactiveRepository.get_role(code)
        if role:
            return role
    rn = str(task.get("assigned_role") or "").strip().lower()
    if not rn:
        return None
    for r in ProactiveRepository.list_roles() or []:
        if str(r.role_name or "").strip().lower() == rn:
            return r
    return None


def _approval_row(appr, *, enrich: bool = True) -> dict[str, Any]:
    out: dict[str, Any] = {
        "id": appr.id,
        "initiative_id": appr.initiative_id or "",
        "task_id": getattr(appr, "task_id", "") or "",
        "role_agent_code": appr.role_agent_code,
        "channel": appr.channel,
        "status": appr.status.value if hasattr(appr.status, "value") else str(appr.status),
        "decided_by": appr.decided_by or "",
        "decided_at": appr.decided_at or "",
        "decision_comment": appr.decision_comment or "",
        "rejection_reason": appr.rejection_reason or "",
        "created_at": appr.created_at,
        "updated_at": appr.updated_at,
    }
    if not enrich:
        return out

    role = ProactiveRepository.get_role(appr.role_agent_code)
    out["role_name"] = (role.role_name if role else "") or appr.role_agent_code

    tid = str(out.get("task_id") or "").strip()
    if tid:
        from evoflow.proactive.work_items import load_work_item_task, task_risk_level

        task = load_work_item_task(tid)
        if task:
            out["title"] = str(task.get("name") or task.get("title") or "").strip()
            out["description"] = str(task.get("description") or "")[:400]
            out["risk_level"] = task_risk_level(task).value
            out["task_status"] = str(task.get("status") or "")
            out["watch_path"] = (
                f"/proactive/{out['role_agent_code']}/work/{tid}"
                if out.get("role_agent_code")
                else f"/proactive/board"
            )
            return out

    init = ProactiveRepository.get_initiative(appr.initiative_id) if appr.initiative_id else None
    if init:
        risk = init.risk_level
        out["title"] = init.title
        out["description"] = (init.description or "")[:400]
        out["risk_level"] = risk.value if hasattr(risk, "value") else str(risk or "")
        out["watch_path"] = f"/proactive/{appr.role_agent_code}/item/{init.id}"
    else:
        out.setdefault("title", "")
        out.setdefault("description", "")
        out.setdefault("risk_level", "")
        out["watch_path"] = "/proactive?tab=approvals"
    return out


def list_approvals(*, status: str = "pending", limit: int = 50) -> dict[str, Any]:
    st = str(status or "").strip().lower()
    if st in {"", "all", "*"}:
        st = None
    rows = ProactiveRepository.list_approvals(status=st, limit=max(1, min(int(limit or 50), 200)))
    return {
        "approvals": [_approval_row(a) for a in rows],
        "count": len(rows),
        "status_filter": st or "all",
        "hint": "面板 #/proactive?tab=approvals；同意：evoflow approvals approve <task_id>",
    }


def request(
    task_id: str,
    *,
    note: str = "",
    risk_level: str = "",
) -> dict[str, Any]:
    """Employee-facing: push a 岗位工作项 into the human approval queue."""
    from evoflow.collab.storage import (
        get_project_storage,
        patch_collab_main_task_in_project_storage,
    )
    from evoflow.proactive.decision_gate import DecisionGate
    from evoflow.proactive.work_items import load_work_item_task, set_work_item_status

    tid = str(task_id or "").strip()
    if not tid:
        raise ValidationError("task_id is required")

    task = load_work_item_task(tid)
    if not task:
        raise NotFoundError(f"Work item '{tid}' not found")

    role = _resolve_role_for_task(task)
    if not role:
        raise ValidationError(
            f"Cannot resolve employee role for task '{tid}' "
            "(need assigned_to agent_code or assigned_role 岗位名)"
        )

    status = str(task.get("status") or "").strip().lower()
    if status in {"completed", "done", "success", "cancelled", "canceled", "failed"}:
        raise ValidationError(f"Task status is '{status}', cannot request approval")

    extras: dict[str, Any] = {}
    note_s = str(note or "").strip()
    if note_s:
        extras["rationale"] = note_s
    risk_s = str(risk_level or "").strip().lower()
    if risk_s:
        if risk_s not in {"low", "medium", "high", "critical"}:
            raise ValidationError("risk_level must be low|medium|high|critical")
        extras["risk_level"] = risk_s
        task["risk_level"] = risk_s

    if extras:
        try:
            patch_collab_main_task_in_project_storage(get_project_storage(), tid, extras)
        except Exception as e:
            raise ValidationError(f"Failed to patch task metadata: {e}") from e
        task = load_work_item_task(tid) or task

    existing = ProactiveRepository.get_approval_by_task(tid)
    if existing and existing.status == ApprovalStatus.PENDING:
        set_work_item_status(tid, "waiting_user")
        return {
            "ok": True,
            "already_pending": True,
            "approval": _approval_row(existing),
            "task_id": tid,
            "hint": "已在待审批队列；请用户在面板或 evoflow approvals approve 处理",
        }

    async def _run():
        gate = DecisionGate()
        return await gate.request_approval_for_task(role, task)

    approval = asyncio.run(_run())
    set_work_item_status(tid, "waiting_user")

    return {
        "ok": True,
        "already_pending": False,
        "approval": _approval_row(approval),
        "task_id": tid,
        "role_agent_code": role.agent_code,
        "role_name": role.role_name,
        "watch_path": f"/proactive/{role.agent_code}/work/{tid}",
        "hint": "已推送待审批；用户：evoflow approvals approve "
        f"{tid}  或面板 #/proactive?tab=approvals",
    }


def decide(
    item_id: str,
    *,
    decision: str,
    comment: str = "",
    rejection_reason: str = "",
    decided_by: str = "cli",
) -> dict[str, Any]:
    """Human-facing: approve or reject (prefer Gateway HTTP for post-approve execute)."""
    raw = str(item_id or "").strip()
    if raw.startswith("task:"):
        raw = raw[5:]
    if not raw:
        raise ValidationError("item_id (task_id / approval_id / initiative_id) is required")

    dec = str(decision or "").strip().lower()
    if dec not in {"approved", "rejected"}:
        raise ValidationError("decision must be approved|rejected")

    reason = str(rejection_reason or comment or "").strip()
    if dec == "rejected" and not reason:
        raise ValidationError("驳回须填写 --reason（或 --comment）")

    body = {
        "decision": dec,
        "decided_by": str(decided_by or "cli").strip() or "cli",
        "comment": str(comment or "").strip(),
        "rejection_reason": reason if dec == "rejected" else "",
    }

    url = f"{_proactive_api_base()}/approval/{raw}"
    try:
        with httpx.Client(timeout=30.0) as client:
            r = client.post(url, json=body)
    except httpx.TimeoutException as e:
        raise ValidationError(f"Gateway timeout posting approval: {e}") from e
    except httpx.HTTPError as e:
        raise ValidationError(f"Gateway unreachable for approval decide: {e}") from e

    if r.status_code >= 400:
        detail = ""
        try:
            detail = r.json().get("detail") or r.text
        except Exception:
            detail = r.text
        raise ValidationError(str(detail or f"approval failed HTTP {r.status_code}"))

    data = r.json() if r.content else {}
    if isinstance(data, dict):
        data.setdefault("ok", True)
        data.setdefault("via", "gateway")
        return data
    return {"ok": True, "via": "gateway", "raw": data}


def approve(item_id: str, *, comment: str = "", decided_by: str = "cli") -> dict[str, Any]:
    return decide(item_id, decision="approved", comment=comment, decided_by=decided_by)


def reject(
    item_id: str,
    *,
    reason: str,
    comment: str = "",
    decided_by: str = "cli",
) -> dict[str, Any]:
    return decide(
        item_id,
        decision="rejected",
        comment=comment or reason,
        rejection_reason=reason,
        decided_by=decided_by,
    )
