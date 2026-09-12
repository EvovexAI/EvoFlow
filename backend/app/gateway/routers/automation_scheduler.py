"""Automation scheduler API: status, CRUD on ``~/.evoflow/tasks/automations``, manual run.

CRUD mirrors ``evopanel/scripts/dev-api.js`` so Web (dev-api) and Desktop (Gateway via ``gatewayProxy``) share one backend implementation.
"""

from __future__ import annotations

import logging
import re
import uuid
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, BackgroundTasks, Body, HTTPException, Query, Request

from app.gateway.automation_runner import _rewrite_automation_toml, _run_one_task, get_automation_scheduler_status, load_automation_toml

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/automation", tags=["automation"])

_UPDATE_KEYS = frozenset(
    {
        "name",
        "prompt",
        "schedule",
        "schedule_type",
        "rrule",
        "scheduled_at",
        "status",
        "workspace",
        "valid_from",
        "valid_until",
        "max_duration_minutes",
        "feishu_push_enabled",
        "push_channel",
        "push_target_id",
        "once_fired",
        "langgraph_thread_mode",
        "langgraph_timeout_seconds",
        "memory_enabled",
        "agent_code",
        "model_name",
        "app_id",
        "app_parameters",
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
    """Stamp or clear published-workflow binding on an automation document."""
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
    # Prompt-only automations should not keep a stale app binding when explicitly cleared.
    if str(row.get("app_id") or "").strip() == "":
        row.pop("app_id", None)
        row.pop("app_name", None)
        if "app_parameters" in body or "parameters" in body:
            row.pop("app_parameters", None)


def _stamp_app_name(row: dict[str, Any], app: dict[str, Any] | None) -> None:
    if not app:
        return
    name = str(app.get("name") or "").strip()
    if name:
        row["app_name"] = name[:120]


def _history_path(task_id: str) -> Any:
    del task_id
    return None  # legacy; history in SQLite


def _is_five_field_cron_or_keyword(s: str) -> bool:
    t = (s or "").strip()
    if not t or "FREQ=" in t.upper():
        return False
    if t.startswith("@"):
        return True
    return len(t.split()) >= 5


def _parse_cron_five(expr: str) -> tuple[str, str, str, str, str]:
    parts = expr.strip().split()
    if len(parts) >= 5:
        return parts[0], parts[1], parts[2], parts[3], parts[4]
    return "*", "*", "*", "*", "*"


def cron_to_rrule(cron_expr: str) -> dict[str, Any]:
    """Best-effort port of ``evopanel/scripts/dev-api.js`` ``cronToRrule``."""
    raw = (cron_expr or "").strip()
    if not raw:
        return {"rrule": "FREQ=DAILY;INTERVAL=1;BYHOUR=9", "scheduled_at": ""}
    if re.match(r"^\d{4}-\d{2}-\d{2}", raw):
        return {"rrule": "", "scheduled_at": raw}
    kw = raw.lower().strip()
    if kw in ("@hourly", "每小时"):
        return {"rrule": "FREQ=HOURLY;INTERVAL=1", "scheduled_at": ""}
    if kw in ("@daily", "每天", "daily"):
        return {"rrule": "FREQ=DAILY;INTERVAL=1", "scheduled_at": ""}
    if kw in ("@weekly", "每周"):
        return {"rrule": "FREQ=WEEKLY;INTERVAL=1;BYDAY=SU", "scheduled_at": ""}

    minute, hour, dom, month, dow = _parse_cron_five(raw)
    # ``0 */2 * * *`` / ``0 */8 * * *`` — every N hours at given minute.
    _hour_step_match = re.fullmatch(r"\*/(\d+)", hour)
    if _hour_step_match and dom in ("*", "?") and month in ("*", "?") and dow in ("*", "?"):
        step = int(_hour_step_match.group(1))
        mf = minute.strip()
        try:
            by_minute = int(mf, 10) if mf not in ("*", "?") else 0
        except ValueError:
            by_minute = 0
        rrule = f"FREQ=HOURLY;INTERVAL={step}"
        if by_minute != 0:
            rrule += f";BYMINUTE={by_minute}"
        return {"rrule": rrule, "scheduled_at": ""}

    # ``m * * * *`` / ``0,15,30,45 * * * *`` — every hour at given minute(s); hour field must be ``*``.
    is_hourly_slot = hour in ("*", "?") and dom in ("*", "?") and month in ("*", "?") and (dow in ("*", "?"))
    if is_hourly_slot:
        mf = minute.strip()
        if mf in ("*", "?"):
            return {"rrule": "FREQ=HOURLY;INTERVAL=1", "scheduled_at": ""}
        if mf.isdigit():
            return {"rrule": f"FREQ=HOURLY;INTERVAL=1;BYMINUTE={mf}", "scheduled_at": ""}
        if re.fullmatch(r"\d{1,2}(,\d{1,2})*", mf):
            return {"rrule": f"FREQ=HOURLY;INTERVAL=1;BYMINUTE={mf}", "scheduled_at": ""}

    is_daily = hour != "*" and dom == "*" and month == "*" and (dow == "*" or dow == "?")
    if is_daily:
        try:
            h = int(hour, 10)
        except ValueError:
            h = 9
        try:
            m = 0 if minute == "*" else int(minute, 10)
        except ValueError:
            m = 0
        rule = "FREQ=DAILY;INTERVAL=1"
        rule += f";BYHOUR={h}"
        if m != 0:
            rule += f";BYMINUTE={m}"
        return {"rrule": rule, "scheduled_at": ""}

    is_weekly = (dow != "*" and dow != "?") or (dom != "*" and not dom.strip().isdigit() and "/" not in dom and "-" not in dom and "," not in dom)
    if is_weekly:
        dow_map = {"0": "SU", "1": "MO", "2": "TU", "3": "WE", "4": "TH", "5": "FR", "6": "SA"}
        days: list[str] = []
        if dow not in ("*", "?"):
            for d in dow.split(","):
                n = d.strip()
                days.append(dow_map.get(n, n))
        try:
            h = int(hour, 10) if hour != "*" else 0
        except ValueError:
            h = 0
        rule = "FREQ=WEEKLY;INTERVAL=1"
        if days:
            rule += ";BYDAY=" + ",".join(days)
        rule += f";BYHOUR={h}"
        return {"rrule": rule, "scheduled_at": ""}

    try:
        dh = int(hour, 10) if hour != "*" else 9
    except ValueError:
        dh = 9
    return {"rrule": f"FREQ=DAILY;INTERVAL=1;BYHOUR={dh}", "scheduled_at": ""}


def _schedule_for_toml(args: dict[str, Any], rrule: str, scheduled_at: str, schedule_fallback: str) -> str:
    """Prefer a 5-field cron in ``schedule`` when EvoPanel sends both RRULE and cron so ``automation_tick`` can fire."""
    raw = str(args.get("schedule") or "").strip()
    if raw and _is_five_field_cron_or_keyword(raw):
        return raw
    if scheduled_at:
        return scheduled_at
    return schedule_fallback or rrule


def _list_all_automations(request: Request | None = None) -> list[dict[str, Any]]:
    from app.gateway.automation_runner import _load_automation_tomls
    from evoflow.admin.automation_schedule import enrich_automation_for_api
    from evoflow.persistence import automation_repositories as auto_repo

    filter_ctx: dict[str, Any] | None = None
    if request is not None:
        try:
            from evoflow.authz.context import resolve_request_authz
            from evoflow.authz.scope import org_scope, personal_scope

            ctx = resolve_request_authz(request)
            p = ctx.get("principal") or {}
            pid = str(p.get("principal_id") or "")
            filter_ctx = {
                "is_admin": bool(ctx.get("is_org_admin")),
                "personal_scope": personal_scope(pid) if pid else None,
                "org_scope": org_scope(str(ctx.get("org_id") or "local")),
                "principal": p,
            }
        except Exception:
            filter_ctx = None

    out: list[dict[str, Any]] = []
    for tid, data in _load_automation_tomls():
        if filter_ctx is not None:
            try:
                if not auto_repo.automation_visible_to_principal(
                    tid,
                    is_admin=filter_ctx["is_admin"],
                    personal_scope=filter_ctx["personal_scope"],
                    org_scope=filter_ctx["org_scope"],
                    principal=filter_ctx["principal"],
                ):
                    continue
            except Exception:
                continue
        latest = None
        try:
            runs = auto_repo.list_automation_runs(tid, limit=1, offset=0)
            latest = runs[0] if runs else None
        except Exception:
            latest = None
        row = enrich_automation_for_api({"id": tid, **data}, latest_run=latest)
        out.append(row)
    return out


def _gen_id() -> str:
    return uuid.uuid4().hex[:8]


def _automation_visible(request: Request, task_id: str) -> bool:
    try:
        from evoflow.authz.context import resolve_request_authz
        from evoflow.authz.scope import org_scope, personal_scope
        from evoflow.persistence import automation_repositories as auto_repo

        ctx = resolve_request_authz(request)
        p = ctx.get("principal") or {}
        pid = str(p.get("principal_id") or "")
        return auto_repo.automation_visible_to_principal(
            task_id,
            is_admin=bool(ctx.get("is_org_admin")),
            personal_scope=personal_scope(pid) if pid else None,
            org_scope=org_scope(str(ctx.get("org_id") or "local")),
            principal=p,
        )
    except Exception:
        return False


def _read_history(task_id: str) -> list[dict[str, Any]]:
    from evoflow.persistence import automation_repositories as auto_repo

    return auto_repo.list_automation_runs(task_id, limit=500, offset=0)


@router.post("/schedule/preview")
async def automation_schedule_preview(body: dict[str, Any] = Body(default_factory=dict)) -> dict[str, Any]:
    """Parse schedule/cron with the same matcher the Gateway runner uses; return summary + next runs."""
    from evoflow.admin.automation_schedule import preview_schedule

    try:
        count = int(body.get("count") or 5)
    except (TypeError, ValueError):
        count = 5
    return preview_schedule(
        schedule=str(body.get("schedule") or body.get("cron") or body.get("cron_expr") or ""),
        schedule_type=str(body.get("schedule_type") or ""),
        scheduled_at=str(body.get("scheduled_at") or ""),
        rrule=str(body.get("rrule") or ""),
        count=count,
    )


@router.get("/scheduler/status")
async def automation_scheduler_status() -> dict:
    """Return whether backend cron is enabled and last tick diagnostics (for EvoPanel / curl)."""
    return get_automation_scheduler_status()


@router.post("/scheduler/start")
async def automation_scheduler_client_start(request: Request) -> dict[str, Any]:
    """EvoPanel «启动调度» — reports task counts and live Gateway scheduler snapshot (same idea as dev-api ``automation_start``)."""
    tasks = _list_all_automations(request)
    active = sum(1 for t in tasks if str(t.get("status") or "").lower() == "active")
    gateway_scheduler = get_automation_scheduler_status()
    return {
        "state": "running",
        "active_timers": active,
        "total_tasks": len(tasks),
        "note": "Cron execution runs in Gateway by default; set EVOFLOW_AUTOMATION_SCHEDULER=0 to disable.",
        "gateway_scheduler": gateway_scheduler,
    }


@router.post("/scheduler/stop")
async def automation_scheduler_client_stop() -> dict[str, str]:
    """EvoPanel «停止调度» — state only (backend loop is env-controlled); matches dev-api."""
    return {"state": "stopped"}


@router.get("/feishu-push-default")
async def automation_feishu_push_default() -> dict[str, Any]:
    """Whether any push target is available; includes full target list for UI selectors."""
    from app.channels.feishu_automation_learned_chat import read_learned_feishu_automation_chat_id
    from app.gateway.channel_result_push import list_push_targets, push_targets_configured
    from app.gateway.routers.channels import _channels_section_from_app_config, get_feishu_automation_default_chat_id
    from evoflow.config.app_config import get_app_config

    targets = list_push_targets()
    learned = read_learned_feishu_automation_chat_id()
    cfg_chat: str | None = None
    cfg = get_app_config()
    ch = _channels_section_from_app_config(cfg)
    if isinstance(ch, dict):
        fe = ch.get("feishu")
        if isinstance(fe, dict):
            v = fe.get("automation_push_chat_id")
            if v is not None and str(v).strip():
                cfg_chat = str(v).strip()
    resolved = get_feishu_automation_default_chat_id()
    return {
        "configured": push_targets_configured(),
        "from_config": bool(cfg_chat),
        "from_learned": bool(learned),
        "chat_id": resolved,
        "targets": targets,
    }


@router.get("/push-targets")
async def automation_push_targets(limit: int = 200) -> dict[str, Any]:
    from app.gateway.channel_result_push import list_push_targets

    return {"targets": list_push_targets(limit=limit)}


@router.get("/tasks")
async def automation_tasks_list(request: Request) -> dict[str, Any]:
    return {"automations": _list_all_automations(request)}


@router.get("/tasks/{task_id}/history")
async def automation_task_history(
    request: Request, task_id: str, limit: int = Query(50, ge=1, le=50)
) -> dict[str, Any]:
    """Return newest runs first (``list_automation_runs`` is already ``ORDER BY id DESC``)."""
    from evoflow.persistence import automation_repositories as auto_repo

    tid = task_id.strip()
    if load_automation_toml(tid) is None:
        raise HTTPException(status_code=404, detail=f"Automation '{tid}' not found")
    if not _automation_visible(request, tid):
        raise HTTPException(status_code=404, detail=f"Automation '{tid}' not found")
    lim = max(1, min(int(limit or 50), 50))
    records = auto_repo.list_automation_runs(tid, limit=lim, offset=0)
    return {"id": tid, "runs": records, "total": auto_repo.count_automation_runs(tid)}


@router.get("/tasks/{task_id}")
async def automation_task_get(request: Request, task_id: str) -> dict[str, Any]:
    tid = task_id.strip()
    data = load_automation_toml(tid)
    if data is None:
        raise HTTPException(status_code=404, detail=f"Automation '{tid}' not found")
    if not _automation_visible(request, tid):
        raise HTTPException(status_code=404, detail=f"Automation '{tid}' not found")
    history = _read_history(tid)
    return {"id": tid, **data, "history": history}


@router.post("/tasks")
async def automation_task_create(
    request: Request, body: dict[str, Any] = Body(default_factory=dict)
) -> dict[str, Any]:
    name = str(body.get("name") or "").strip()
    prompt = str(body.get("prompt") or "").strip()
    app_id = str(body.get("app_id") or body.get("workflow_id") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="name is required")
    if not prompt and not app_id:
        raise HTTPException(status_code=400, detail="prompt or app_id is required")
    if app_id:
        from evoflow.persistence import app_repositories

        app = app_repositories.load_app(app_id)
        if app is None:
            raise HTTPException(status_code=400, detail=f"Application '{app_id}' not found")
        if str(app.get("status") or "").strip().lower() != "published":
            raise HTTPException(status_code=400, detail=f"Application '{app_id}' must be published")
    else:
        app = None

    schedule_type = body.get("schedule_type") or "recurring"
    rrule = ""
    scheduled_at = ""
    schedule_fb = ""

    cron_src = str(body.get("cron_expr") or "").strip() or str(body.get("schedule") or "").strip()

    if schedule_type == "once" and body.get("scheduled_at"):
        scheduled_at = str(body["scheduled_at"]).strip()
        schedule_fb = scheduled_at
    elif cron_src and _is_five_field_cron_or_keyword(cron_src):
        conv = cron_to_rrule(cron_src)
        rrule = str(conv.get("rrule") or "")
        scheduled_at = str(conv.get("scheduled_at") or "")
        schedule_fb = cron_src
    elif body.get("rrule") or ("FREQ=" in cron_src.upper()):
        from evoflow.admin.automation_schedule import rrule_to_cron

        rrule = str(body.get("rrule") or cron_src).strip()
        derived = rrule_to_cron(rrule)
        if derived and _is_five_field_cron_or_keyword(derived):
            schedule_fb = derived
            cron_src = derived
        else:
            schedule_fb = rrule
    elif cron_src:
        conv = cron_to_rrule(cron_src)
        rrule = str(conv.get("rrule") or "")
        scheduled_at = str(conv.get("scheduled_at") or "")
        schedule_fb = rrule or scheduled_at
    else:
        # Default: daily 09:00 as 5-field cron (not RRULE-only)
        cron_src = "0 9 * * *"
        conv = cron_to_rrule(cron_src)
        rrule = str(conv.get("rrule") or "")
        schedule_fb = cron_src

    schedule_toml = _schedule_for_toml(body, rrule, scheduled_at, schedule_fb)
    # Keep ``rrule`` aligned with the 5-field ``schedule`` actually written (fixes stale DAILY rrule from old cron parsers).
    if _is_five_field_cron_or_keyword(schedule_toml):
        conv_sync = cron_to_rrule(schedule_toml)
        if conv_sync.get("rrule"):
            rrule = str(conv_sync["rrule"])

    task_id = _gen_id()
    row: dict[str, Any] = {
        "name": name,
        "prompt": prompt or (f"运行工作流 {app_id}" if app_id else ""),
        "schedule": schedule_toml,
        "rrule": rrule,
        "scheduled_at": scheduled_at or None,
        "status": "active",
        "schedule_type": schedule_type,
        "workspace": body.get("workspace") or None,
        "valid_from": body.get("valid_from") or None,
        "valid_until": body.get("valid_until") or None,
        "max_duration_minutes": int(body.get("max_duration_minutes") or 30),
        "feishu_push_enabled": bool(body.get("feishu_push_enabled")),
        "push_channel": str(body.get("push_channel") or "").strip(),
        "push_target_id": str(body.get("push_target_id") or "").strip(),
        "langgraph_run": True,
        "langgraph_thread_mode": "sticky" if body.get("langgraph_thread_mode") == "sticky" else "fresh",
        "created_at": datetime.now(UTC).isoformat(),
    }
    if body.get("langgraph_timeout_seconds") is not None:
        try:
            row["langgraph_timeout_seconds"] = int(body["langgraph_timeout_seconds"])
        except (TypeError, ValueError):
            pass
    row["memory_enabled"] = bool(body.get("memory_enabled"))
    agent_code = str(body.get("agent_code") or "").strip()
    model_name = str(body.get("model_name") or "").strip()
    if agent_code:
        row["agent_code"] = agent_code
    if model_name:
        row["model_name"] = model_name
    _apply_workflow_binding(row, body)
    if app_id:
        _stamp_app_name(row, app)

    _rewrite_automation_toml(task_id, row)
    try:
        from evoflow.authz.resource_visibility import stamp_kwargs_from_request
        from evoflow.persistence import automation_repositories as auto_repo

        own = stamp_kwargs_from_request(request)
        if own.get("owner_scope_id"):
            auto_repo.set_automation_owner_scope(
                task_id,
                org_id=own.get("org_id") or "local",
                owner_scope_id=own["owner_scope_id"],
                created_by=own.get("created_by"),
            )
    except Exception:
        pass
    return {
        "success": True,
        "id": task_id,
        "name": name,
        "schedule_type": schedule_type,
        "schedule": rrule or scheduled_at,
        "app_id": row.get("app_id") or "",
    }


@router.put("/tasks/{task_id}")
async def automation_task_update(
    request: Request, task_id: str, body: dict[str, Any] = Body(default_factory=dict)
) -> dict[str, Any]:
    tid = task_id.strip()
    task = load_automation_toml(tid)
    if task is None:
        raise HTTPException(status_code=404, detail=f"Automation '{tid}' not found")
    if not _automation_visible(request, tid):
        raise HTTPException(status_code=404, detail=f"Automation '{tid}' not found")

    cron_src = str(body.get("cron_expr") or "").strip()
    if not cron_src and _is_five_field_cron_or_keyword(str(body.get("schedule") or "")):
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
            continue  # handled by _apply_workflow_binding
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
                raise HTTPException(status_code=400, detail=f"Application '{bound_app}' not found")
            if str(app.get("status") or "").strip().lower() != "published":
                raise HTTPException(status_code=400, detail=f"Application '{bound_app}' must be published")
            _stamp_app_name(updated, app)
        else:
            updated.pop("app_name", None)

    prompt_now = str(updated.get("prompt") or "").strip()
    app_now = str(updated.get("app_id") or "").strip()
    if not prompt_now and not app_now:
        raise HTTPException(status_code=400, detail="prompt or app_id is required")

    if str(body.get("schedule") or "").strip() and _is_five_field_cron_or_keyword(str(body["schedule"])):
        updated["schedule"] = str(body["schedule"]).strip()

    # 编辑调度时间时重置 once_fired，让一次性任务修改后可重新触发
    if "scheduled_at" in body or "schedule_type" in body or "schedule" in body:
        updated["once_fired"] = False
        if str(updated.get("schedule_type") or "").lower() == "once" and updated.get("scheduled_at"):
            updated["status"] = "active"

    updated["langgraph_run"] = True
    updated.pop("langgraph_assistant_id", None)

    _rewrite_automation_toml(tid, updated)
    return {"success": True, "id": tid}


@router.delete("/tasks/{task_id}")
async def automation_task_delete(request: Request, task_id: str) -> dict[str, Any]:
    tid = task_id.strip()
    from evoflow.persistence import automation_repositories as auto_repo

    if load_automation_toml(tid) is None:
        raise HTTPException(status_code=404, detail=f"Automation '{tid}' not found")
    if not _automation_visible(request, tid):
        raise HTTPException(status_code=404, detail=f"Automation '{tid}' not found")
    if not auto_repo.delete_automation(tid):
        raise HTTPException(status_code=404, detail=f"Automation '{tid}' not found")
    return {"success": True, "id": tid}


@router.post("/tasks/{task_id}/pause")
async def automation_task_pause(request: Request, task_id: str) -> dict[str, Any]:
    tid = task_id.strip()
    task = load_automation_toml(tid)
    if task is None:
        raise HTTPException(status_code=404, detail=f"Automation '{tid}' not found")
    if not _automation_visible(request, tid):
        raise HTTPException(status_code=404, detail=f"Automation '{tid}' not found")
    task["status"] = "paused"
    _rewrite_automation_toml(tid, task)
    return {"success": True, "id": tid, "status": "paused"}


@router.post("/tasks/{task_id}/resume")
async def automation_task_resume(request: Request, task_id: str) -> dict[str, Any]:
    tid = task_id.strip()
    task = load_automation_toml(tid)
    if task is None:
        raise HTTPException(status_code=404, detail=f"Automation '{tid}' not found")
    if not _automation_visible(request, tid):
        raise HTTPException(status_code=404, detail=f"Automation '{tid}' not found")
    task["status"] = "active"
    _rewrite_automation_toml(tid, task)
    return {"success": True, "id": tid, "status": "active"}


@router.post("/tasks/{task_id}/run")
async def automation_task_run_now(
    request: Request,
    task_id: str,
    background_tasks: BackgroundTasks,
    run_async: bool = Query(True, description="If true, start the run after responding (same work as sync; use to avoid long HTTP hold). Default True: manual run never blocks the HTTP request — the automation executes in the background."),
) -> dict:
    """Run one automation immediately (same pipeline as cron: Feishu + optional LangGraph).

    Does not require ``status=active`` (for EvoPanel「手动运行」). Requires ChannelService running
    for Feishu push / LangGraph-triggered notifications.

    Default ``run_async=True``: returns immediately and executes in the background, so a
    long prompt-only run (direct LangGraph, can take many minutes) never holds the HTTP request.
    Pass ``?run_async=false`` only when a caller explicitly needs synchronous completion.
    """
    from app.channels.service import get_channel_service

    tid = task_id.strip()
    data = load_automation_toml(tid)
    if data is None:
        raise HTTPException(status_code=404, detail=f"Automation TOML not found: {tid}")
    if not _automation_visible(request, tid):
        raise HTTPException(status_code=404, detail=f"Automation TOML not found: {tid}")

    service = get_channel_service()
    if service is None:
        raise HTTPException(
            status_code=503,
            detail="Channel service not started — cannot run automation (Feishu / LangGraph path)",
        )
    try:
        st = service.get_status()
    except Exception as e:
        raise HTTPException(status_code=503, detail=f"Channel service status error: {e}") from e
    if not st.get("service_running"):
        raise HTTPException(
            status_code=503,
            detail="Channel service not running — enable IM channels or fix startup errors",
        )

    data_snapshot = dict(data)
    if run_async:

        async def _run_in_background() -> None:
            from app.channels.service import get_channel_service as _gcs

            try:
                svc = _gcs()
                if svc is None:
                    logger.warning("automation run_async: no channel service task_id=%s", tid)
                    return
                try:
                    st2 = svc.get_status()
                except Exception as e2:
                    logger.warning("automation run_async: status error task_id=%s err=%s", tid, e2)
                    return
                if not st2.get("service_running"):
                    logger.warning("automation run_async: channel not running task_id=%s", tid)
                    return
                await _run_one_task(tid, data_snapshot, svc, skip_status_gate=True, trigger_type="manual_http_async")
            except Exception:
                logger.exception("automation run_async: run failed task_id=%s", tid)

        background_tasks.add_task(_run_in_background)
        return {"success": True, "task_id": tid, "queued": True}

    await _run_one_task(tid, data, service, skip_status_gate=True, trigger_type="manual_http")
    return {"success": True, "task_id": tid}
