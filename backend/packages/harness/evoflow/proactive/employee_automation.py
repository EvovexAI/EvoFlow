"""Employee heartbeat as a first-class automation rule.

Architecture
------------
* **Definition (规则)**: each active duty role with a cron upserts a shadow row in
  ``evoflow_automations`` (``kind=employee_heartbeat``, ``task_id=emp:{code}``).
* **Runs (运行记录)**: every cron fire (incl. busy/skip) writes
  ``evoflow_automation_runs`` via the shared automation scheduler — same slot
  claim / catch-up / minute-aligned tick as prompt automations.
* **Role row** (``evoflow_proactive_roles``) remains the human/岗位 SSOT; schedule
  edits sync into the shadow automation. ``evoflow_duty_runs`` stays as the
  employee work-board trail (dual-written by the duty path) for UI compat.

Concurrency & exact slots
-------------------------
Firing is owned by ``automation_runner`` only (when
``EVOFLOW_EMPLOYEE_VIA_AUTOMATION`` is on, default). Slot claims prevent
double-fire across Gateway processes. Cron is minute-granular Beijing time —
e.g. ``0 */2 * * *`` means **:00** of those hours, not a drifting offset.
"""

from __future__ import annotations

import logging
import os
from typing import Any

from evoflow.timeutil import utc_now_iso_z

logger = logging.getLogger(__name__)

EMPLOYEE_AUTOMATION_KIND = "employee_heartbeat"
_TASK_PREFIX = "emp:"


def employee_via_automation_enabled() -> bool:
    """When True (default), cron fire for employees is owned by automation_runner."""
    v = os.getenv("EVOFLOW_EMPLOYEE_VIA_AUTOMATION", "").strip().lower()
    if not v:
        return True
    return v not in ("0", "false", "no", "off", "disabled")


def employee_automation_task_id(agent_code: str) -> str:
    code = str(agent_code or "").strip()
    if not code:
        return ""
    return f"{_TASK_PREFIX}{code}"


def agent_code_from_employee_task(task_id: str, task: dict[str, Any] | None = None) -> str:
    if isinstance(task, dict):
        code = str(task.get("agent_code") or "").strip()
        if code:
            return code
    tid = str(task_id or "").strip()
    if tid.startswith(_TASK_PREFIX):
        return tid[len(_TASK_PREFIX) :].strip()
    return ""


def is_employee_automation(task: dict[str, Any] | None, *, task_id: str = "") -> bool:
    if isinstance(task, dict):
        kind = str(task.get("kind") or "").strip().lower()
        if kind == EMPLOYEE_AUTOMATION_KIND:
            return True
        if str(task.get("managed_by") or "").strip() == "proactive_role":
            return True
        if str(task.get("agent_code") or "").strip() and str(task_id or "").startswith(_TASK_PREFIX):
            return True
    tid = str(task_id or (task or {}).get("task_id") or "").strip()
    return tid.startswith(_TASK_PREFIX)


def _role_wants_scheduled_patrol(role: Any) -> bool:
    status = str(getattr(role, "status", "") or "").strip().lower()
    if status not in ("active", ""):
        return False
    cfg = getattr(role, "config", None)
    if cfg is not None and bool(getattr(cfg, "auto_patrol_suspended", False)):
        return False
    return True


def build_employee_automation_doc(role: Any) -> dict[str, Any]:
    """Build the shadow automation document for a proactive role."""
    from evoflow.proactive.schedule import resolve_role_cron

    code = str(getattr(role, "agent_code", "") or "").strip()
    name = str(getattr(role, "role_name", "") or "").strip() or code
    cron = resolve_role_cron(role)
    active = _role_wants_scheduled_patrol(role)
    now = utc_now_iso_z()
    return {
        "name": f"员工上班 · {name}",
        "prompt": "",  # not used — runner dispatches ProactiveEngine
        "schedule": cron,
        "schedule_type": "cron",
        "status": "active" if active else "paused",
        "feishu_push_enabled": False,
        "langgraph_run": False,
        "langgraph_thread_mode": "fresh",
        "kind": EMPLOYEE_AUTOMATION_KIND,
        "managed_by": "proactive_role",
        "agent_code": code,
        "description": "Shadow rule for smart-employee heartbeat (synced from role schedule).",
        "created_at": now,
        "updated_at": now,
    }


def upsert_employee_automation(role: Any) -> str | None:
    """Upsert shadow automation for ``role``. Returns task_id or None."""
    code = str(getattr(role, "agent_code", "") or "").strip()
    if not code:
        return None
    task_id = employee_automation_task_id(code)
    doc = build_employee_automation_doc(role)
    try:
        from evoflow.persistence import automation_repositories as auto_repo

        existing = auto_repo.load_automation(task_id)
        if existing:
            # Preserve created_at / last_run counters from prior row.
            for keep in ("created_at", "last_run", "last_status", "run_count", "once_fired"):
                if existing.get(keep) not in (None, ""):
                    doc[keep] = existing[keep]
            # Never let operators' manual edits to name/prompt stick for managed rows —
            # schedule + status always come from the role.
            doc["name"] = f"员工上班 · {str(getattr(role, 'role_name', '') or '').strip() or code}"
        auto_repo.save_automation(task_id, doc)
        return task_id
    except Exception:
        logger.exception("employee_automation: upsert failed agent=%s", code)
        return None


def delete_employee_automation(agent_code: str) -> bool:
    tid = employee_automation_task_id(agent_code)
    if not tid:
        return False
    try:
        from evoflow.persistence import automation_repositories as auto_repo

        return bool(auto_repo.delete_automation(tid))
    except Exception:
        logger.debug(
            "employee_automation: delete failed agent=%s",
            agent_code,
            exc_info=True,
        )
        return False


def sync_all_employee_automations() -> dict[str, int]:
    """Reconcile shadow automations with current proactive roles.

    Creates/updates rows for every non-archived role; pauses orphans that no
    longer have a matching role (does not delete — keeps run history).
    """
    from evoflow.proactive.repositories import ProactiveRepository

    upserted = 0
    paused = 0
    roles = ProactiveRepository.list_roles()
    live_ids: set[str] = set()
    for role in roles:
        code = str(getattr(role, "agent_code", "") or "").strip()
        if not code:
            continue
        status = str(getattr(role, "status", "") or "").strip().lower()
        if status == "archived":
            # Keep history but pause the rule.
            tid = employee_automation_task_id(code)
            live_ids.add(tid)
            try:
                from evoflow.persistence import automation_repositories as auto_repo

                existing = auto_repo.load_automation(tid)
                if existing and str(existing.get("status") or "").lower() == "active":
                    existing["status"] = "paused"
                    existing["kind"] = EMPLOYEE_AUTOMATION_KIND
                    existing["managed_by"] = "proactive_role"
                    existing["agent_code"] = code
                    auto_repo.save_automation(tid, existing)
                    paused += 1
            except Exception:
                logger.debug("employee_automation: pause archived failed code=%s", code, exc_info=True)
            continue
        tid = upsert_employee_automation(role)
        if tid:
            live_ids.add(tid)
            upserted += 1

    # Pause managed employee rules whose role vanished.
    try:
        from evoflow.persistence import automation_repositories as auto_repo

        for tid, doc in auto_repo.list_automations():
            if not is_employee_automation(doc, task_id=tid):
                continue
            if tid in live_ids:
                continue
            if str(doc.get("status") or "").lower() == "active":
                doc["status"] = "paused"
                auto_repo.save_automation(tid, doc)
                paused += 1
    except Exception:
        logger.debug("employee_automation: orphan pause scan failed", exc_info=True)

    return {"upserted": upserted, "paused": paused}


def automation_run_to_round_journal(run: dict[str, Any], *, agent_code: str) -> dict[str, Any]:
    """Map an automation_runs row (employee kind) to work-board round_log shape."""
    rid = str(run.get("round_id") or run.get("run_id") or "").strip()
    started = str(run.get("started_at") or "").strip()
    status_raw = str(run.get("status") or "").strip().lower()
    skip = str(run.get("skip_reason") or "").strip()
    err = str(run.get("error") or "").strip()
    reason = str(run.get("trigger_reason") or run.get("summary") or "").strip()
    sk = str(run.get("session_key") or "").strip()
    msg_n = int(run.get("msg_count") or 0)
    tool_n = int(run.get("tool_count") or 0)

    if status_raw in ("started", "running", "queued"):
        status, result, outcome = "executing", None, reason or "上班中…"
    elif status_raw in ("busy",):
        status, result, outcome = "completed", None, "到点触发，但员工忙碌中（本轮未开跑）"
    elif status_raw in ("skipped", "skip"):
        status, result, outcome = "completed", None, reason or f"到点触发 · 已跳过（{skip or '未知'}）"
    elif status_raw in ("fail", "failed", "error"):
        status, result, outcome = "failed", "failure", err or reason or "本轮失败"
    else:
        bits = []
        if msg_n or tool_n:
            bits.append(f"轨迹 {msg_n} 条 · 工具 {tool_n} 次")
        if reason:
            bits.append(reason)
        status, result, outcome = "completed", "success", "；".join(bits) or "值班结束"

    title = "定时上班"
    trig = str(run.get("trigger_type") or "").strip().lower()
    if "manual" in trig or "api" in trig:
        title = "手动上班"
    elif "dispatch" in trig:
        title = "派发上班"

    return {
        "id": f"auto-run:{run.get('run_id') or rid}",
        "role_agent_code": agent_code,
        "title": title,
        "description": reason or f"自动化触发 {trig or 'schedule'}",
        "rationale": "",
        "action_type": "report",
        "risk_level": "low",
        "action_plan": {
            "kind": "round_log",
            "phase": "check_in" if status == "executing" else "wrap_up",
            "synthetic": True,
            "source": "automation_run",
            "run_id": str(run.get("run_id") or ""),
            "session_key": sk,
            "trigger_source": trig,
            "scheduled": trig in ("schedule", "catchup", "near_miss"),
            "skip_reason": skip,
            "msg_count": msg_n,
            "tool_count": tool_n,
        },
        "expected_outcome": "",
        "status": status,
        "result": result,
        "approval_id": None,
        "approved_by": None,
        "approved_at": None,
        "approval_timeout_minutes": 0,
        "execution_thread_id": None,
        "execution_result": "",
        "round_id": rid,
        "goal": title,
        "outcome": outcome,
        "created_at": started,
        "updated_at": started,
        "session_key": sk,
    }


def list_employee_automation_rounds(agent_code: str, *, limit: int = 40) -> list[dict[str, Any]]:
    """Board rounds from ``evoflow_automation_runs`` for this employee's shadow task."""
    code = str(agent_code or "").strip()
    if not code:
        return []
    tid = employee_automation_task_id(code)
    try:
        from evoflow.persistence import automation_repositories as auto_repo

        runs = auto_repo.list_automation_runs(tid, limit=max(1, min(int(limit or 40), 200)))
    except Exception:
        logger.debug("employee_automation: list runs failed agent=%s", code, exc_info=True)
        return []
    return [automation_run_to_round_journal(r, agent_code=code) for r in runs]
