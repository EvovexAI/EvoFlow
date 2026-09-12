"""Scheduled automation admin (SQLite ``evoflow_automations``)."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from evoflow.admin.automation_schedule import cron_to_rrule, is_five_field_cron_or_keyword, schedule_for_payload
from evoflow.admin.errors import NotFoundError, ValidationError
from evoflow.persistence import automation_repositories as auto_repo

_UPDATE_KEYS = frozenset(
    {
        "name",
        "prompt",
        "schedule",
        "rrule",
        "scheduled_at",
        "status",
        "workspace",
        "valid_from",
        "valid_until",
        "max_duration_minutes",
        "feishu_push_enabled",
        "once_fired",
        "langgraph_thread_mode",
        "langgraph_timeout_seconds",
        "memory_enabled",
        "agent_code",
        "model_name",
        "app_id",
        "app_parameters",
        "push_channel",
        "push_target_id",
        "schedule_type",
    }
)


def _coerce_app_parameters(raw: Any) -> dict[str, str]:
    if not isinstance(raw, dict):
        return {}
    out: dict[str, str] = {}
    for key, val in raw.items():
        k = str(key or "").strip()
        if not k:
            continue
        out[k] = "" if val is None else str(val)
    return out


def _apply_workflow_binding(row: dict[str, Any], body: dict[str, Any]) -> None:
    if "app_id" in body or "workflow_id" in body:
        app_id = str(body.get("app_id") or body.get("workflow_id") or "").strip()
        if app_id:
            row["app_id"] = app_id
        else:
            row.pop("app_id", None)
            row.pop("app_name", None)
    if "app_parameters" in body or "parameters" in body:
        raw = body.get("app_parameters")
        if raw is None and "parameters" in body:
            raw = body.get("parameters")
        params = _coerce_app_parameters(raw)
        if params:
            row["app_parameters"] = params
        else:
            row.pop("app_parameters", None)
    if str(row.get("app_id") or "").strip() == "":
        row.pop("app_id", None)
        row.pop("app_name", None)
        if "app_parameters" in body or "parameters" in body:
            row.pop("app_parameters", None)


def _row(task_id: str, data: dict[str, Any]) -> dict[str, Any]:
    return {"id": task_id, **data}


def list_automations() -> dict[str, Any]:
    items = [_row(tid, data) for tid, data in auto_repo.list_automations()]
    return {"automations": items, "count": len(items)}


def get_automation(task_id: str) -> dict[str, Any]:
    data = auto_repo.load_automation(task_id.strip())
    if data is None:
        raise NotFoundError(f"Automation '{task_id}' not found")
    # Newest first (same order as list_automation_runs / history API).
    history = auto_repo.list_automation_runs(task_id.strip(), limit=50, offset=0)
    return {**_row(task_id.strip(), data), "history": history}


def get_automation_history(task_id: str, *, limit: int = 50) -> dict[str, Any]:
    tid = task_id.strip()
    if auto_repo.load_automation(tid) is None:
        raise NotFoundError(f"Automation '{tid}' not found")
    lim = max(1, min(int(limit or 50), 500))
    # list_automation_runs is already newest-first; do not reverse then slice (that returned the oldest).
    records = auto_repo.list_automation_runs(tid, limit=lim, offset=0)
    return {"id": tid, "runs": records, "total": auto_repo.count_automation_runs(tid)}


def create_automation(data: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(data, dict):
        raise ValidationError("Automation payload must be a JSON object")
    name = str(data.get("name") or "").strip()
    prompt = str(data.get("prompt") or "").strip()
    app_id = str(data.get("app_id") or data.get("workflow_id") or "").strip()
    if not name:
        raise ValidationError("name is required")
    if not prompt and not app_id:
        raise ValidationError("prompt or app_id is required")
    if app_id:
        from evoflow.persistence import app_repositories

        app = app_repositories.load_app(app_id)
        if app is None:
            raise ValidationError(f"Application '{app_id}' not found")
        if str(app.get("status") or "").strip().lower() != "published":
            raise ValidationError(f"Application '{app_id}' must be published")
        app_name = str(app.get("name") or "").strip()
    else:
        app_name = ""

    schedule_type = data.get("schedule_type") or "recurring"
    rrule = ""
    scheduled_at = ""
    schedule_fb = ""
    cron_src = str(data.get("cron_expr") or data.get("schedule") or "").strip()

    if schedule_type == "once" and data.get("scheduled_at"):
        scheduled_at = str(data["scheduled_at"]).strip()
        schedule_fb = scheduled_at
    elif data.get("rrule"):
        rrule = str(data["rrule"]).strip()
        schedule_fb = rrule
    elif cron_src:
        conv = cron_to_rrule(cron_src)
        rrule = str(conv.get("rrule") or "")
        scheduled_at = str(conv.get("scheduled_at") or "")
        schedule_fb = rrule or scheduled_at
    else:
        rrule = "FREQ=DAILY;INTERVAL=1;BYHOUR=9"
        schedule_fb = rrule

    schedule_toml = schedule_for_payload(data, rrule, scheduled_at, schedule_fb)
    if is_five_field_cron_or_keyword(schedule_toml):
        conv_sync = cron_to_rrule(schedule_toml)
        if conv_sync.get("rrule"):
            rrule = str(conv_sync["rrule"])

    task_id = str(data.get("id") or uuid.uuid4().hex[:8])
    row: dict[str, Any] = {
        "name": name,
        "prompt": prompt or (f"运行工作流 {app_id}" if app_id else ""),
        "schedule": schedule_toml,
        "rrule": rrule,
        "scheduled_at": scheduled_at or None,
        "status": str(data.get("status") or "active"),
        "schedule_type": schedule_type,
        "workspace": data.get("workspace") or None,
        "valid_from": data.get("valid_from") or None,
        "valid_until": data.get("valid_until") or None,
        "max_duration_minutes": int(data.get("max_duration_minutes") or 30),
        "feishu_push_enabled": bool(data.get("feishu_push_enabled")),
        "langgraph_run": True,
        "langgraph_thread_mode": "sticky" if data.get("langgraph_thread_mode") == "sticky" else "fresh",
        "created_at": datetime.now(UTC).isoformat(),
        "memory_enabled": bool(data.get("memory_enabled")),
    }
    if data.get("langgraph_timeout_seconds") is not None:
        try:
            row["langgraph_timeout_seconds"] = int(data["langgraph_timeout_seconds"])
        except (TypeError, ValueError):
            pass
    agent_code = str(data.get("agent_code") or "").strip()
    model_name = str(data.get("model_name") or "").strip()
    if agent_code:
        row["agent_code"] = agent_code
    if model_name:
        row["model_name"] = model_name
    _apply_workflow_binding(row, data)
    if app_id and app_name:
        row["app_name"] = app_name[:120]
    auto_repo.save_automation(task_id, row)
    return {
        "success": True,
        "id": task_id,
        "name": name,
        "schedule_type": schedule_type,
        "schedule": rrule or scheduled_at,
        "app_id": row.get("app_id") or "",
    }


def update_automation(task_id: str, data: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(data, dict):
        raise ValidationError("Automation payload must be a JSON object")
    tid = task_id.strip()
    task = auto_repo.load_automation(tid)
    if task is None:
        raise NotFoundError(f"Automation '{tid}' not found")

    body = dict(data)
    cron_src = str(body.get("cron_expr") or "").strip()
    if not cron_src and is_five_field_cron_or_keyword(str(body.get("schedule") or "")):
        cron_src = str(body["schedule"]).strip()
    if cron_src:
        conv = cron_to_rrule(cron_src)
        body = {**body, "rrule": conv.get("rrule") or body.get("rrule")}
        if conv.get("scheduled_at"):
            body["scheduled_at"] = conv["scheduled_at"]

    updated = dict(task)
    for k in _UPDATE_KEYS:
        if k not in body:
            continue
        if k in ("app_id", "app_parameters"):
            continue
        val = body[k]
        if k == "memory_enabled":
            if val is None:
                updated.pop("memory_enabled", None)
            else:
                updated["memory_enabled"] = bool(val)
            continue
        if k in ("agent_code", "model_name", "push_channel", "push_target_id"):
            s = "" if val is None else str(val).strip()
            if s:
                updated[k] = s
            else:
                updated.pop(k, None)
            continue
        updated[k] = "" if val is None else val

    if "app_id" in body or "workflow_id" in body or "app_parameters" in body or "parameters" in body:
        _apply_workflow_binding(updated, body)
        bound_app = str(updated.get("app_id") or "").strip()
        if bound_app:
            from evoflow.persistence import app_repositories

            app = app_repositories.load_app(bound_app)
            if app is None:
                raise ValidationError(f"Application '{bound_app}' not found")
            if str(app.get("status") or "").strip().lower() != "published":
                raise ValidationError(f"Application '{bound_app}' must be published")
            name = str(app.get("name") or "").strip()
            if name:
                updated["app_name"] = name[:120]
        else:
            updated.pop("app_name", None)

    prompt_now = str(updated.get("prompt") or "").strip()
    app_now = str(updated.get("app_id") or "").strip()
    if not prompt_now and not app_now:
        raise ValidationError("prompt or app_id is required")

    if str(body.get("schedule") or "").strip() and is_five_field_cron_or_keyword(str(body["schedule"])):
        updated["schedule"] = str(body["schedule"]).strip()

    updated["langgraph_run"] = True
    updated.pop("langgraph_assistant_id", None)
    auto_repo.save_automation(tid, updated)
    return {"success": True, "id": tid}


def delete_automation(task_id: str) -> dict[str, Any]:
    tid = task_id.strip()
    if not auto_repo.delete_automation(tid):
        raise NotFoundError(f"Automation '{tid}' not found")
    return {"success": True, "id": tid}


def set_automation_status(task_id: str, *, status: str) -> dict[str, Any]:
    tid = task_id.strip()
    task = auto_repo.load_automation(tid)
    if task is None:
        raise NotFoundError(f"Automation '{tid}' not found")
    task["status"] = status
    auto_repo.save_automation(tid, task)
    return {"success": True, "id": tid, "status": status}
