"""Apps / workflow admin facade for in-process callers (CLI / 小V platform).

Thin wrappers over ``app_repositories`` + ``app_runner`` — same services the
Gateway routers use. Do not HTTP-loopback from tools.
"""

from __future__ import annotations

import copy
import uuid
from typing import Any

from evoflow.admin.errors import NotFoundError, ValidationError
from evoflow.collab import app_runner
from evoflow.persistence import app_repositories
from evoflow.timeutil import utc_now_iso_z


def _new_app_id() -> str:
    ts = utc_now_iso_z().replace(":", "").replace("-", "").replace("T", "").split(".")[0]
    return f"App_{ts}_{uuid.uuid4().hex[:6]}"


def _assert_dispatchable_step_agents(steps: list[Any]) -> None:
    """Reject drafts/updates that would silently fall back at run time (CORE-WF-04)."""
    if not steps:
        return
    from evoflow.collab.workflow_validator import collect_assigned_agent_errors

    errs = collect_assigned_agent_errors(steps)
    if errs:
        raise ValidationError("; ".join(errs[:6]))


def _normalize_plan_for_storage(document: dict[str, Any]) -> dict[str, Any]:
    """Split frontend ``plan`` into goal_template + steps + canvas for storage."""
    doc = dict(document)
    plan = doc.pop("plan", None)
    if isinstance(plan, dict):
        if plan.get("goal"):
            doc["goal_template"] = plan["goal"]
        if plan.get("steps") is not None:
            doc["steps"] = plan["steps"]
        if plan.get("canvas") is not None:
            doc["canvas"] = plan["canvas"]
        if "answer_from_ref" in plan:
            doc["answer_from_ref"] = plan.get("answer_from_ref")
    return doc


def _app_summary(app: dict[str, Any] | None) -> dict[str, Any]:
    if not app or not isinstance(app, dict):
        return {}
    raw_steps = app.get("steps") or []
    return {
        "id": app.get("id"),
        "name": app.get("name"),
        "description": (str(app.get("description") or "")[:240] or None),
        "status": app.get("status"),
        "category": app.get("category"),
        "execution_mode": app.get("execution_mode"),
        "version": app.get("version"),
        "steps_count": len(raw_steps) if isinstance(raw_steps, list) else 0,
        "tags": app.get("tags") or [],
    }


def list_apps(
    *,
    status: str | None = None,
    category: str | None = None,
    search: str | None = None,
    limit: int = 50,
) -> dict[str, Any]:
    lim = max(1, min(int(limit or 50), 100))
    apps = app_repositories.list_apps(
        status=status,
        category=category,
        search=search,
        limit=lim,
    )
    items: list[dict[str, Any]] = []
    for a in apps or []:
        if not isinstance(a, dict):
            continue
        items.append(
            {
                "id": a.get("id"),
                "name": a.get("name"),
                # Keep list payloads lean for tool output budgets (CORE-WF-06).
                "description": (str(a.get("description") or "")[:120] or None),
                "status": a.get("status"),
                "category": a.get("category"),
                "execution_mode": a.get("execution_mode"),
                "tags": (a.get("tags") or [])[:8],
            }
        )
    return {"items": items, "count": len(items), "limit": lim}


def get_app(app_id: str) -> dict[str, Any]:
    aid = str(app_id or "").strip()
    if not aid:
        raise ValidationError("appId is required")
    app = app_repositories.load_app(aid)
    if app is None:
        raise NotFoundError(f"Application not found: {aid}")
    raw_steps = app.get("steps") or []
    steps_preview: list[dict[str, Any]] = []
    if isinstance(raw_steps, list):
        for st in raw_steps:
            if not isinstance(st, dict):
                continue
            steps_preview.append(
                {
                    "ref": st.get("ref") or st.get("id"),
                    "name": st.get("name"),
                    "goal": (str(st.get("goal") or "")[:500]),
                    "description": (str(st.get("description") or "")[:500]),
                    "assigned_agent": st.get("assigned_agent") or st.get("agent"),
                    "depends_on": st.get("depends_on") or st.get("dependsOn") or [],
                }
            )
    return {
        "app": {
            "id": app.get("id"),
            "name": app.get("name"),
            "description": app.get("description"),
            "status": app.get("status"),
            "category": app.get("category"),
            "execution_mode": app.get("execution_mode"),
            "parameters": app.get("parameters") or [],
            "steps_count": len(raw_steps) if isinstance(raw_steps, list) else 0,
            "goal_template": app.get("goal_template") or "",
            "steps_preview": steps_preview,
            "tags": app.get("tags") or [],
            "auto_run": bool(app.get("auto_run")),
        }
    }


def run_app(
    app_id: str,
    *,
    parameters: dict[str, Any] | None = None,
    execution_mode: str | None = None,
    thread_id: str | None = None,
    raised_by: str | None = None,
    created_by: str | None = None,
    principal_id: str | None = None,
    operator_label: str | None = None,
) -> dict[str, Any]:
    aid = str(app_id or "").strip()
    if not aid:
        raise ValidationError("appId is required")
    if app_repositories.load_app(aid) is None:
        raise NotFoundError(f"Application not found: {aid}")
    raw_params = parameters or {}
    str_params = {str(k): "" if v is None else str(v) for k, v in raw_params.items()}
    try:
        result = app_runner.run_app(
            app_id=aid,
            parameters=str_params,
            execution_mode=execution_mode,
            thread_id=thread_id,
            run_kind="debug",
            trigger_kind="manual",
            raised_by=raised_by,
            created_by=created_by,
            principal_id=principal_id,
            operator_label=operator_label,
        )
    except ValueError as exc:
        raise ValidationError(str(exc)) from exc
    return {"run": result}


def cancel_run(run_id: str, *, reason: str = "User cancelled") -> dict[str, Any]:
    rid = str(run_id or "").strip()
    if not rid:
        raise ValidationError("runId is required")
    ok = app_runner.cancel_run(rid, reason)
    return {"cancelled": bool(ok), "runId": rid}


def pause_run(run_id: str, *, reason: str = "User paused") -> dict[str, Any]:
    rid = str(run_id or "").strip()
    if not rid:
        raise ValidationError("runId is required")
    ok = app_runner.pause_run(rid, reason)
    return {"paused": bool(ok), "runId": rid}


def get_run(run_id: str) -> dict[str, Any]:
    rid = str(run_id or "").strip()
    if not rid:
        raise ValidationError("runId is required")
    st = app_runner.get_run_status(rid)
    if st is None:
        raise NotFoundError(f"Run not found: {rid}")
    return {"run": st}


def create_app(
    *,
    name: str,
    description: str = "",
    icon: str = "",
    category: str = "general",
    parameters: list[dict[str, Any]] | None = None,
    steps: list[dict[str, Any]] | None = None,
    goal_template: str = "",
    validation_template: list[str] | None = None,
    flowchart_mermaid: str = "",
    execution_mode: str = "workflow",
    auto_run: bool = False,
    source: str = "platform",
    tags: list[str] | None = None,
    canvas: dict[str, Any] | None = None,
    plan: dict[str, Any] | None = None,
) -> dict[str, Any]:
    title = str(name or "").strip()
    if not title:
        raise ValidationError("name is required")
    app_id = _new_app_id()
    document: dict[str, Any] = {
        "name": title,
        "description": str(description or ""),
        "icon": str(icon or ""),
        "category": str(category or "general"),
        "parameters": parameters or [],
        "steps": steps or [],
        "goal_template": str(goal_template or ""),
        "validation_template": validation_template or [],
        "flowchart_mermaid": str(flowchart_mermaid or ""),
        "execution_mode": str(execution_mode or "workflow"),
        "auto_run": bool(auto_run),
        "source": str(source or "platform"),
        "tags": list(tags or []),
        "canvas": canvas if isinstance(canvas, dict) else {},
        "created_at": utc_now_iso_z(),
        "status": "draft",
        "version": 1,
    }
    if isinstance(plan, dict):
        document["plan"] = plan
    document = _normalize_plan_for_storage(document)
    _assert_dispatchable_step_agents(document.get("steps") or [])
    app_repositories.save_app(app_id, document)
    loaded = app_repositories.load_app(app_id)
    if loaded is None:
        raise ValidationError("Failed to create application")
    loaded["id"] = app_id
    return {"app": loaded, "appId": app_id, "app_id": app_id}


def update_app(app_id: str, patch: dict[str, Any]) -> dict[str, Any]:
    aid = str(app_id or "").strip()
    if not aid:
        raise ValidationError("appId is required")
    existing = app_repositories.load_app(aid)
    if existing is None:
        raise NotFoundError(f"Application not found: {aid}")
    updated = dict(existing)
    data = _normalize_plan_for_storage(dict(patch or {}))
    skip = {"appId", "app_id", "id", "confirm", "confirmed", "yes"}
    data = {k: v for k, v in data.items() if k not in skip and v is not None}
    # Always bump version when any field actually changes so revision history
    # accumulates (CORE-WF-01). Previously non-structural edits reused the same
    # version and INSERT OR REPLACE overwrote the prior snapshot.
    changed = any(data.get(k) != existing.get(k) for k in data)
    for key, value in data.items():
        updated[key] = value
    # Steps changed without an explicit canvas patch → rebuild edges from depends_on (CORE-WF-05).
    if "steps" in data and "canvas" not in data:
        from evoflow.collab.app_canvas import canvas_from_steps

        updated["canvas"] = canvas_from_steps(updated.get("steps") or [])
    if changed:
        updated["version"] = int(existing.get("version") or 1) + 1
    else:
        updated["version"] = int(existing.get("version") or 1)
    _assert_dispatchable_step_agents(updated.get("steps") or [])
    app_repositories.save_app(aid, updated)
    loaded = app_repositories.load_app(aid)
    if loaded is None:
        raise ValidationError("Failed to update application")
    loaded["id"] = aid
    return {"app": loaded, "appId": aid, "app_id": aid}


def delete_app(app_id: str) -> dict[str, Any]:
    aid = str(app_id or "").strip()
    if not aid:
        raise ValidationError("appId is required")
    existing = app_repositories.load_app(aid)
    if existing is None:
        raise NotFoundError(f"Application not found: {aid}")
    # Cancel linked Tasks before wiping runs so board rows do not stay executing (CORE-WF-09).
    cancelled_tasks: list[str] = []
    try:
        runs = app_repositories.list_runs(aid, limit=200)
    except Exception:
        runs = []
    task_ids: list[str] = []
    for run in runs or []:
        if not isinstance(run, dict):
            continue
        tid = str(run.get("task_id") or "").strip()
        if tid and tid not in task_ids:
            task_ids.append(tid)
    if task_ids:
        try:
            from evoflow.admin import tasks as tasks_admin

            for tid in task_ids:
                try:
                    tasks_admin.set_task_state(tid, "cancelled", summary="app deleted")
                    cancelled_tasks.append(tid)
                except Exception:
                    try:
                        tasks_admin.delete_task(tid)
                        cancelled_tasks.append(tid)
                    except Exception:
                        pass
        except Exception:
            pass
    ok = app_repositories.delete_app(aid)
    return {
        "deleted": bool(ok),
        "appId": aid,
        "app_id": aid,
        "name": existing.get("name"),
        "cancelled_task_ids": cancelled_tasks,
        "cancelled_task_count": len(cancelled_tasks),
    }


def publish_app(app_id: str) -> dict[str, Any]:
    aid = str(app_id or "").strip()
    if not aid:
        raise ValidationError("appId is required")
    existing = app_repositories.load_app(aid)
    if existing is None:
        raise NotFoundError(f"Application not found: {aid}")
    from evoflow.collab.workflow_validator import validate_app_definition

    validation = validate_app_definition(existing)
    if not validation.get("valid"):
        raise ValidationError("Workflow validation failed; cannot publish: " + "; ".join(str(e) for e in (validation.get("errors") or [])[:5]))
    existing["status"] = "published"
    existing["version"] = int(existing.get("version") or 1) + 1
    app_repositories.save_app(aid, existing)
    loaded = app_repositories.load_app(aid)
    if loaded is None:
        raise ValidationError("Failed to publish application")
    loaded["id"] = aid
    warnings = validation.get("warnings") or []
    out: dict[str, Any] = {"app": loaded, "appId": aid, "app_id": aid, "status": "published"}
    if warnings:
        out["warnings"] = warnings[:8]
    return out


def unpublish_app(app_id: str) -> dict[str, Any]:
    aid = str(app_id or "").strip()
    if not aid:
        raise ValidationError("appId is required")
    existing = app_repositories.load_app(aid)
    if existing is None:
        raise NotFoundError(f"Application not found: {aid}")
    existing["status"] = "draft"
    app_repositories.save_app(aid, existing)
    loaded = app_repositories.load_app(aid)
    if loaded is None:
        raise ValidationError("Failed to unpublish application")
    loaded["id"] = aid
    return {"app": loaded, "appId": aid, "app_id": aid, "status": "draft"}


def generate_app(
    *,
    name: str,
    goal: str,
    steps: list[dict[str, Any]] | None = None,
    description: str = "",
    icon: str = "📋",
    category: str = "general",
    execution_mode: str = "workflow",
    auto_run: bool = False,
    auto_extract: bool = True,
    max_params: int = 5,
    tags: list[str] | None = None,
    canvas: dict[str, Any] | None = None,
) -> dict[str, Any]:
    from evoflow.collab.app_generator import generate_app_from_plan

    title = str(name or "").strip()
    if not title:
        raise ValidationError("name is required")
    goal_text = str(goal or "").strip()
    if not goal_text:
        raise ValidationError("goal is required")
    app_doc = generate_app_from_plan(
        goal=goal_text,
        steps=steps or [],
        name=title,
        description=description,
        icon=icon,
        category=category,
        execution_mode=execution_mode,
        auto_run=auto_run,
        auto_extract=auto_extract,
        max_params=max_params,
        tags=tags,
    )
    if isinstance(canvas, dict) and canvas:
        app_doc["canvas"] = canvas
    app_id = str(app_doc.get("id") or _new_app_id())
    app_repositories.save_app(app_id, app_doc)
    loaded = app_repositories.load_app(app_id)
    if loaded is None:
        raise ValidationError("Failed to generate application")
    loaded["id"] = app_id
    return {"app": loaded, "appId": app_id, "app_id": app_id}


def duplicate_app(app_id: str, *, name: str | None = None) -> dict[str, Any]:
    aid = str(app_id or "").strip()
    if not aid:
        raise ValidationError("appId is required")
    existing = app_repositories.load_app(aid)
    if existing is None:
        raise NotFoundError(f"Application not found: {aid}")
    new_id = _new_app_id()
    cloned = copy.deepcopy(existing)
    cloned["name"] = str(name or "").strip() or f"{existing.get('name') or aid} (副本)"
    cloned["status"] = "draft"
    cloned["version"] = 1
    cloned["created_at"] = utc_now_iso_z()
    cloned["usage_count"] = 0
    cloned["last_used_at"] = None
    cloned["source"] = "duplicate"
    cloned["source_task_id"] = aid
    app_repositories.save_app(new_id, cloned)
    loaded = app_repositories.load_app(new_id)
    if loaded is None:
        raise ValidationError("Failed to duplicate application")
    loaded["id"] = new_id
    return {"app": loaded, "appId": new_id, "app_id": new_id, "sourceAppId": aid}


def list_app_runs(app_id: str, *, limit: int = 20, page: int = 1) -> dict[str, Any]:
    aid = str(app_id or "").strip()
    if not aid:
        raise ValidationError("appId is required")
    if app_repositories.load_app(aid) is None:
        raise NotFoundError(f"Application not found: {aid}")
    lim = max(1, min(int(limit or 20), 100))
    pg = max(1, int(page or 1))
    return {
        **app_repositories.list_runs_page(aid, page=pg, page_size=lim),
        "appId": aid,
    }


def resume_run(run_id: str) -> dict[str, Any]:
    rid = str(run_id or "").strip()
    if not rid:
        raise ValidationError("runId is required")
    existing = app_repositories.load_run(rid)
    if existing is None:
        raise NotFoundError(f"Run not found: {rid}")
    st = str(existing.get("status") or "").strip().lower()
    if st in {"cancelled", "canceled", "completed", "failed", "success", "error"}:
        raise ValidationError(
            f"Run '{rid}' is terminal (status={st}) and cannot be resumed; "
            f"use workflow.recover for failed/zombie runs, or start a new run"
        )
    ok = app_runner.resume_run(rid)
    if not ok:
        raise ValidationError(
            f"Run '{rid}' is not resumable (status={st}); only paused/interrupted runs can resume"
        )
    task_id = str(existing.get("task_id") or "").strip()
    out: dict[str, Any] = {"resumed": True, "runId": rid, "run_id": rid}
    if task_id:
        out["task_id"] = task_id
        out["taskId"] = task_id
    return out


def _await_coro(coro: Any) -> Any:
    """Run a coroutine from sync admin/CLI (safe if a loop is already running)."""
    import asyncio
    import concurrent.futures

    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro)
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        return pool.submit(asyncio.run, coro).result(timeout=600)


def _format_recover_result(report: dict[str, Any], *, run_id: str | None = None) -> dict[str, Any]:
    if not report.get("ok"):
        raise ValidationError(str(report.get("error") or "recover_failed"))
    out: dict[str, Any] = {
        "recovered": True,
        "taskId": report.get("taskId"),
        "action": report.get("action"),
        "healed": report.get("healed") or [],
        "report": report,
    }
    if run_id:
        out["runId"] = run_id
        out["run_id"] = run_id
    return out


def recover_run(run_id: str, *, reason: str = "manual") -> dict[str, Any]:
    """Crash / node-failure recover: heal DB zombies then retry_wave / start.

    Unlike ``resume_run`` (pause-only), this accepts running/failed/interrupted
    app runs and re-dispatches from broken steps using persisted DAG state.
    """
    rid = str(run_id or "").strip()
    if not rid:
        raise ValidationError("runId is required")
    existing = app_repositories.load_run(rid)
    if existing is None:
        raise NotFoundError(f"Run not found: {rid}")
    st = str(existing.get("status") or "").strip().lower()
    if st in {"cancelled", "canceled", "completed", "success"}:
        raise ValidationError(
            f"Run '{rid}' is finished (status={st}) and cannot be recovered; start a new run"
        )

    from evoflow.collab.workflow_reconciler import reconcile_run

    report = _await_coro(reconcile_run(rid, reason=str(reason or "manual")))
    return _format_recover_result(report, run_id=rid)


async def recover_run_async(run_id: str, *, reason: str = "manual") -> dict[str, Any]:
    """Async recover for gateway handlers."""
    rid = str(run_id or "").strip()
    if not rid:
        raise ValidationError("runId is required")
    existing = app_repositories.load_run(rid)
    if existing is None:
        raise NotFoundError(f"Run not found: {rid}")
    st = str(existing.get("status") or "").strip().lower()
    if st in {"cancelled", "canceled", "completed", "success"}:
        raise ValidationError(
            f"Run '{rid}' is finished (status={st}) and cannot be recovered; start a new run"
        )

    from evoflow.collab.workflow_reconciler import reconcile_run

    report = await reconcile_run(rid, reason=str(reason or "manual"))
    return _format_recover_result(report, run_id=rid)


def recover_task(task_id: str, *, reason: str = "manual") -> dict[str, Any]:
    """Recover by main task id (workflow-bound)."""
    tid = str(task_id or "").strip()
    if not tid:
        raise ValidationError("taskId is required")

    from evoflow.collab.workflow_reconciler import reconcile_task

    report = _await_coro(reconcile_task(tid, reason=str(reason or "manual")))
    return _format_recover_result(report)


async def recover_task_async(task_id: str, *, reason: str = "manual") -> dict[str, Any]:
    tid = str(task_id or "").strip()
    if not tid:
        raise ValidationError("taskId is required")
    from evoflow.collab.workflow_reconciler import reconcile_task

    report = await reconcile_task(tid, reason=str(reason or "manual"))
    return _format_recover_result(report)


def list_app_revisions(app_id: str, *, limit: int = 50) -> dict[str, Any]:
    aid = str(app_id or "").strip()
    if not aid:
        raise ValidationError("appId is required")
    if app_repositories.load_app(aid) is None:
        raise NotFoundError(f"Application not found: {aid}")
    lim = max(1, min(int(limit or 50), 200))
    items = app_repositories.list_revisions(aid, limit=lim)
    return {"items": items, "count": len(items), "appId": aid}


def restore_app_revision(app_id: str, version: int, *, as_draft: bool = True) -> dict[str, Any]:
    aid = str(app_id or "").strip()
    if not aid:
        raise ValidationError("appId is required")
    ver = int(version)
    if ver < 1:
        raise ValidationError("version must be >= 1")
    try:
        restored = app_repositories.restore_app_from_revision(aid, ver, as_draft=as_draft)
    except ValueError as exc:
        raise ValidationError(str(exc)) from exc
    restored["id"] = aid
    return {"app": restored, "appId": aid, "app_id": aid, "restoredVersion": ver}
