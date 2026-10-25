"""Application management and execution endpoints."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field

from app.gateway.deps.license import require_premium
from evoflow.collab.app_runner import (
    get_run_status,
    pause_run,
    resume_run,
    run_app,
)
from evoflow.persistence import app_repositories

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/api/apps",
    tags=["apps"],
    dependencies=[Depends(require_premium)],
)


# ───────────────────────────────── Request Models ─────────────────────────────────


class CreateAppRequest(BaseModel):
    name: str
    description: str = ""
    icon: str = ""
    category: str = "general"
    parameters: list[dict] = Field(default_factory=list)
    steps: list[dict] = Field(default_factory=list)
    goal_template: str = ""
    validation_template: list[str] = Field(default_factory=list)
    flowchart_mermaid: str = ""
    execution_mode: str = "workflow"
    auto_run: bool = False
    source: str = "generated"
    source_task_id: str | None = None
    tags: list[str] = Field(default_factory=list)
    # Dual-track layout: nodes / edges / viewport (visual truth; runner ignores)
    canvas: dict | None = None
    # Frontend sends a unified ``plan`` object {goal, steps, canvas}; we split it into
    # goal_template + steps + canvas for storage.  Kept optional for backward compat.
    plan: dict | None = None


class GenerateAppRequest(BaseModel):
    """Generate an App from a model-produced plan (goal + steps)."""

    name: str
    description: str = ""
    goal: str
    steps: list[dict] = Field(default_factory=list)
    icon: str = "📋"
    category: str = "general"
    execution_mode: str = "workflow"
    auto_run: bool = False
    auto_extract: bool = True
    max_params: int = 5
    tags: list[str] = Field(default_factory=list)
    canvas: dict | None = None


class UpdateAppRequest(BaseModel):
    name: str | None = None
    description: str | None = None
    icon: str | None = None
    category: str | None = None
    parameters: list[dict] | None = None
    steps: list[dict] | None = None
    goal_template: str | None = None
    validation_template: list[str] | None = None
    flowchart_mermaid: str | None = None
    execution_mode: str | None = None
    auto_run: bool | None = None
    status: str | None = None
    tags: list[str] | None = None
    canvas: dict | None = None
    plan: dict | None = None


class RunAppRequest(BaseModel):
    parameters: dict[str, str] = Field(default_factory=dict)
    execution_mode: str | None = None  # override app default
    thread_id: str | None = None  # required for lead_supervised
    run_kind: str | None = Field(
        default="production",
        description="debug | production | scheduled — Task Center run-mode tag (F-4: manual runs default to production)",
    )
    trigger_kind: str | None = Field(
        default="manual",
        description="manual | api | schedule — how the run was started",
    )


class DryRunAppRequest(BaseModel):
    """Render a run preview without creating anything (F-4 dry-run)."""

    parameters: dict[str, str] = Field(default_factory=dict)


class CreateAppKeyRequest(BaseModel):
    """Mint an app-scoped API key (plaintext returned only once)."""

    name: str = Field(default="default", description="Human-readable label for the key.")


class SaveAsAppRequest(BaseModel):
    """Convert an existing task to a reusable application (used in tasks router)."""

    name: str
    description: str = ""
    execution_mode: str = "workflow"
    auto_extract: bool = True  # Auto-extract parameter placeholders from plan content


# ─────────────────────────────── App Management Endpoints ─────────────────────────────


def _normalize_plan_for_storage(document: dict[str, Any]) -> dict[str, Any]:
    """Split a frontend ``plan`` object into goal_template + steps + canvas for storage.

    Frontend sends ``{ plan: { goal, steps, canvas } }``; the DB stores
    ``goal_template``, ``steps_json``, and ``canvas_json`` separately.
    """
    plan = document.pop("plan", None)
    if isinstance(plan, dict):
        if plan.get("goal"):
            document["goal_template"] = plan["goal"]
        if plan.get("steps") is not None:
            document["steps"] = plan["steps"]
        if plan.get("canvas") is not None:
            document["canvas"] = plan["canvas"]
        if "answer_from_ref" in plan:
            document["answer_from_ref"] = plan.get("answer_from_ref")
    return document


def _decorate_app_response(app: dict[str, Any], *, total_runs_override: int | None = None) -> dict[str, Any]:
    """Synthesise a unified ``plan`` object + ``total_runs`` for the frontend.

    The DB stores ``goal_template``, ``steps_json``, and ``canvas_json`` separately;
    the frontend expects ``app.plan = { goal, steps, canvas }`` and ``app.total_runs``.
    """
    if app is None:
        return app
    canvas = app.get("canvas") if isinstance(app.get("canvas"), dict) else {}
    steps = app.get("steps") if isinstance(app.get("steps"), list) else []
    parameters = app.get("parameters") if isinstance(app.get("parameters"), list) else []
    app["canvas"] = canvas
    app["steps"] = steps
    app["parameters"] = parameters
    app["step_count"] = len(steps)
    app["parameter_count"] = len(parameters)
    app.setdefault("plan", {})
    app["plan"]["goal"] = app.get("goal_template", "")
    app["plan"]["steps"] = steps
    app["plan"]["canvas"] = canvas
    app["plan"]["answer_from_ref"] = app.get("answer_from_ref") or ""
    # total_runs — cheap query, only when we have a valid app_id
    if total_runs_override is not None:
        app["total_runs"] = int(total_runs_override or 0)
    else:
        app_id = app.get("id")
        if app_id:
            try:
                app["total_runs"] = app_repositories.count_runs(app_id)
            except Exception:
                app["total_runs"] = app.get("usage_count", 0)
        else:
            app["total_runs"] = app.get("usage_count", 0)
    return app


@router.get("")
def list_apps_endpoint(
    request: Request,
    status: str | None = None,
    category: str | None = None,
    search: str | None = None,
    limit: int = Query(100, ge=1, le=500),
    summary: bool = Query(
        True,
        description="Omit canvas and heavy step text; use false only when full definitions are required.",
    ),
) -> list[dict[str, Any]]:
    """List applications with ownership isolation."""
    apps = app_repositories.list_apps(
        status=status,
        category=category,
        search=search,
        limit=limit,
        summary=summary,
    )
    try:
        from evoflow.authz.context import resolve_request_authz
        from evoflow.authz.scope import org_scope, personal_scope

        ctx = resolve_request_authz(request)
        p = ctx.get("principal") or {}
        pid = str(p.get("principal_id") or "")
        is_admin = bool(ctx.get("is_org_admin"))
        p_scope = personal_scope(pid) if pid else None
        o_scope = org_scope(str(ctx.get("org_id") or "local"))
        apps = [
            a
            for a in apps
            if isinstance(a, dict)
            and app_repositories.app_visible_to_principal(
                str(a.get("id") or ""),
                pid,
                is_admin=is_admin,
                personal_scope=p_scope,
                org_scope=o_scope,
                principal=p,
                owner_scope_id=a.get("owner_scope_id"),
            )
        ]
    except Exception:
        pass
    run_counts = app_repositories.count_runs_batch([a.get("id") for a in apps if a])
    for a in apps:
        if not isinstance(a, dict):
            continue
        _decorate_app_response(a, total_runs_override=run_counts.get(str(a.get("id")), 0))
    return apps


@router.get("/{app_id}")
def get_app_endpoint(request: Request, app_id: str) -> dict[str, Any]:
    """Get a single application definition."""
    from evoflow.authz.http_guard import require_app_visible

    require_app_visible(request, app_id)
    app = app_repositories.load_app(app_id)
    if app is None:
        raise HTTPException(status_code=404, detail=f"Application not found: {app_id}")
    return _decorate_app_response(app)


@router.post("")
def create_app_endpoint(request: Request, body: CreateAppRequest) -> dict[str, Any]:
    """Create a new application definition."""
    import uuid

    from evoflow.timeutil import utc_now_iso_z

    ts = utc_now_iso_z().replace(":", "").replace("-", "").replace("T", "").split(".")[0]
    app_id = f"App_{ts}_{uuid.uuid4().hex[:6]}"

    document = body.model_dump()
    document = _normalize_plan_for_storage(document)
    document["created_at"] = utc_now_iso_z()
    document["status"] = "draft"

    app_repositories.save_app(app_id, document)
    try:
        from evoflow.authz.resource_visibility import stamp_new_app_from_request

        stamp_new_app_from_request(request, app_id)
    except Exception:
        logger.exception("failed to stamp ownership for new app %s", app_id)
        raise HTTPException(
            status_code=500,
            detail="Failed to assign workflow ownership; please retry",
        ) from None

    created = app_repositories.load_app(app_id)
    if created is None:
        raise HTTPException(status_code=500, detail="Failed to create application")
    return _decorate_app_response(created)


@router.post("/generate")
def generate_app_endpoint(http_request: Request, request: GenerateAppRequest) -> dict[str, Any]:
    """Generate an App from a model-produced plan (goal + steps).

    Runs parameter extraction to identify variable content, replaces with
    {{param}} placeholders, and saves as a new App definition.
    """
    from evoflow.collab.app_generator import generate_app_from_plan

    app_doc = generate_app_from_plan(
        goal=request.goal,
        steps=request.steps,
        name=request.name,
        description=request.description,
        icon=request.icon,
        category=request.category,
        execution_mode=request.execution_mode,
        auto_run=request.auto_run,
        auto_extract=request.auto_extract,
        max_params=request.max_params,
        tags=request.tags,
    )

    app_id = app_doc["id"]
    app_repositories.save_app(app_id, app_doc)
    try:
        from evoflow.authz.resource_visibility import stamp_new_app_from_request

        stamp_new_app_from_request(http_request, app_id)
    except Exception:
        logger.exception("failed to stamp ownership for generated app %s", app_id)
        raise HTTPException(
            status_code=500,
            detail="Failed to assign workflow ownership; please retry",
        ) from None

    created = app_repositories.load_app(app_id)
    if created is None:
        raise HTTPException(status_code=500, detail="Failed to generate application")
    return _decorate_app_response(created)


@router.put("/{app_id}")
def update_app_endpoint(http_request: Request, app_id: str, request: UpdateAppRequest) -> dict[str, Any]:
    """Update an application definition.

    Version increments ONLY when structural fields change (steps, parameters,
    canvas, goal_template, execution_mode, validation_template). Cosmetic
    changes (name, description, icon, tags) do NOT bump version, avoiding
    noise in revision history (O1).
    """
    from evoflow.authz.http_guard import require_app_visible

    require_app_visible(http_request, app_id)
    existing = app_repositories.load_app(app_id)
    if existing is None:
        raise HTTPException(status_code=404, detail=f"Application not found: {app_id}")

    # Merge update with existing
    updated = dict(existing)
    update_data = request.model_dump(exclude_none=True)
    update_data = _normalize_plan_for_storage(update_data)

    # Detect structural changes that warrant a version bump
    _STRUCTURAL_FIELDS = frozenset(
        {
            "steps",
            "parameters",
            "canvas",
            "goal_template",
            "execution_mode",
            "validation_template",
            "flowchart_mermaid",
        }
    )
    has_structural_change = any(key in update_data and update_data[key] != existing.get(key) for key in _STRUCTURAL_FIELDS)

    for key, value in update_data.items():
        updated[key] = value

    if has_structural_change:
        updated["version"] = existing.get("version", 1) + 1
    else:
        updated["version"] = existing.get("version", 1)

    app_repositories.save_app(app_id, updated)

    result = app_repositories.load_app(app_id)
    if result is None:
        raise HTTPException(status_code=500, detail="Failed to update application")
    return _decorate_app_response(result)


@router.delete("/{app_id}")
def delete_app_endpoint(request: Request, app_id: str) -> dict[str, bool]:
    """Delete an application and its associated run history."""
    from evoflow.authz.http_guard import require_app_visible

    require_app_visible(request, app_id)
    success = app_repositories.delete_app(app_id)
    return {"success": success}


@router.post("/{app_id}/publish")
def publish_app_endpoint(request: Request, app_id: str) -> dict[str, Any]:
    """Mark an application as published (from draft status).

    P0.5-4: Runs static validation before publishing. If validation finds
    blocking errors (circular deps, dangling references), the publish is
    rejected with a 422. Warnings are logged but don't block.
    """
    from evoflow.authz.http_guard import require_app_visible

    require_app_visible(request, app_id)
    existing = app_repositories.load_app(app_id)
    if existing is None:
        raise HTTPException(status_code=404, detail=f"Application not found: {app_id}")

    # P0.5-4: Pre-publish static validation
    from evoflow.collab.workflow_validator import validate_app_definition

    validation = validate_app_definition(existing)
    if not validation["valid"]:
        raise HTTPException(
            status_code=422,
            detail={
                "message": "Workflow validation failed; cannot publish",
                "errors": validation["errors"],
                "warnings": validation["warnings"],
            },
        )

    existing["status"] = "published"
    existing["version"] = existing.get("version", 1) + 1
    app_repositories.save_app(app_id, existing)

    result = app_repositories.load_app(app_id)
    if result is None:
        raise HTTPException(status_code=500, detail="Failed to publish application")
    return _decorate_app_response(result)


# ─────────────────────────────── App API Keys (OpenAPI) ───────────────────────────────


@router.get("/{app_id}/keys")
def list_app_keys_endpoint(request: Request, app_id: str) -> dict[str, Any]:
    """List API keys bound to this application (plaintext never included)."""
    from evoflow.authz.http_guard import require_app_visible

    require_app_visible(request, app_id)
    if app_repositories.load_app(app_id) is None:
        raise HTTPException(status_code=404, detail=f"Application not found: {app_id}")
    from evoflow.persistence.auth_repositories import token_repository

    tokens = token_repository.list_tokens_for_identity("app", app_id, include_revoked=False)
    return {"keys": tokens, "count": len(tokens)}


@router.post("/{app_id}/keys", status_code=201)
def create_app_key_endpoint(http_request: Request, app_id: str, request: CreateAppKeyRequest) -> dict[str, Any]:
    """Mint an app-scoped API key (``ef-…``). Plaintext is returned only once.

    Requires ``status=published``. Draft apps must be published first.
    """
    from evoflow.authz.http_guard import require_app_visible

    require_app_visible(http_request, app_id)
    app = app_repositories.load_app(app_id)
    if app is None:
        raise HTTPException(status_code=404, detail=f"Application not found: {app_id}")
    if str(app.get("status") or "").strip().lower() != "published":
        raise HTTPException(
            status_code=403,
            detail="Publish the application before creating API keys.",
        )
    from evoflow.persistence.auth_repositories import token_repository

    name = (request.name or "default").strip() or "default"
    pinned_version = int(app.get("version") or 1)
    plaintext = token_repository.create_app_token(name=name, app_id=app_id, pinned_version=pinned_version)
    record = token_repository.verify_token(plaintext)
    if record is None:
        raise HTTPException(status_code=500, detail="Failed to create API key")
    return {
        "token": plaintext,
        "token_hash": record["token_hash"],
        "name": record["name"],
        "identity_type": record["identity_type"],
        "identity_id": record["identity_id"],
        "created_at": record["created_at"],
        "pinned_version": record.get("pinned_version") if record.get("pinned_version") is not None else pinned_version,
    }


@router.delete("/{app_id}/keys/{token_hash}")
def revoke_app_key_endpoint(request: Request, app_id: str, token_hash: str) -> dict[str, Any]:
    """Revoke an API key bound to this application."""
    from evoflow.authz.http_guard import require_app_visible

    require_app_visible(request, app_id)
    if app_repositories.load_app(app_id) is None:
        raise HTTPException(status_code=404, detail=f"Application not found: {app_id}")
    from evoflow.persistence.auth_repositories import token_repository

    tokens = token_repository.list_tokens_for_identity("app", app_id, include_revoked=True)
    match = next((t for t in tokens if t.get("token_hash") == token_hash), None)
    if match is None:
        raise HTTPException(status_code=404, detail="API key not found for this application")
    revoked = token_repository.revoke_token(token_hash)
    return {"revoked": revoked, "token_hash": token_hash}


# ─────────────────────────────── App Execution Endpoints ─────────────────────────────


@router.post("/{app_id}/run")
async def run_app_endpoint(http_request: Request, app_id: str, request: RunAppRequest) -> dict[str, Any]:
    """Run an application (creates a run instance and task center task).

    - workflow mode: Creates standalone task, auto-authorized, DAG auto-executes
    - lead_supervised mode: Binds to thread and advances to plan_ready (user confirms)

    One click = one Task Center row; workflow nodes are nested steps, not separate tasks.
    """
    from evoflow.authz.http_guard import require_app_visible

    require_app_visible(http_request, app_id)
    try:
        from evoflow.authz.agent_actor import resolve_invoker_stamp
        from evoflow.authz.context import resolve_request_principal
        from evoflow.authz.runtime_identity import set_current_principal_id

        # Bind request user into ambient identity, then stamp from runtime (not hard-coded).
        try:
            principal = resolve_request_principal(http_request)
            set_current_principal_id(str((principal or {}).get("principal_id") or "").strip())
        except Exception:
            set_current_principal_id("")
        invoker = resolve_invoker_stamp()
        # E-5: setup (bundle create + subtask sync + authorize) runs in a worker
        # thread; the wave-1 DAG dispatch is awaited on the gateway event loop
        # instead of spinning a throwaway asyncio.run loop inside the thread.
        result = await asyncio.to_thread(
            run_app,
            app_id=app_id,
            parameters=request.parameters,
            execution_mode=request.execution_mode,
            thread_id=request.thread_id,
            run_kind=request.run_kind or "debug",
            trigger_kind=request.trigger_kind or "manual",
            raised_by=invoker.get("raised_by"),
            created_by=invoker.get("created_by"),
            principal_id=invoker.get("principal_id"),
            operator_label=invoker.get("operator_label"),
            defer_dispatch=True,
        )
        if isinstance(result, dict) and str(result.get("execution_mode") or "") == "workflow":
            from evoflow.collab.app_runner import apply_workflow_dispatch_async

            result = await apply_workflow_dispatch_async(result)
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.post("/{app_id}/dry-run")
def dry_run_app_endpoint(request: Request, app_id: str, body: DryRunAppRequest) -> dict[str, Any]:
    """Preview a run: render the parameterized plan without creating anything (F-4).

    No task, no run row, no dispatch — returns the rendered goal + steps,
    template-node previews (params resolved, upstream refs verbatim), missing
    parameters, and publish-validation summary so the user sees the final
    shape before clicking「运行」.
    """
    from evoflow.authz.http_guard import require_app_visible

    require_app_visible(request, app_id)
    app = app_repositories.load_app(app_id)
    if app is None:
        raise HTTPException(status_code=404, detail=f"Application not found: {app_id}")

    from evoflow.collab.app_engine import render_plan, validate_parameters
    from evoflow.collab.workflow_validator import validate_app_definition

    params_valid, missing, undefined = validate_parameters(app, body.parameters)
    plan = render_plan(app, body.parameters)

    steps_preview: list[dict[str, Any]] = []
    for idx, step in enumerate(plan.get("steps") or []):
        row: dict[str, Any] = {
            "ref": step.get("ref"),
            "name": step.get("name"),
            "executor": str(step.get("executor") or "llm"),
            "depends_on": step.get("depends_on") or [],
        }
        if row["executor"] == "template":
            try:
                from evoflow.collab.template_node import render_template

                rendered, unresolved = render_template(
                    str(step.get("template") or ""),
                    params=body.parameters,
                    subtasks=[],
                )
                row["template_preview"] = rendered[:2000]
                if unresolved:
                    row["template_unresolved"] = unresolved[:20]
            except Exception as exc:
                row["template_preview"] = f"（渲染失败：{exc}）"
        steps_preview.append(row)

    validation = validate_app_definition(app)
    return {
        "app_id": app_id,
        "parameters_valid": params_valid,
        "missing_parameters": missing,
        "undefined_parameters": undefined,
        "goal": plan.get("goal") or "",
        "steps": steps_preview,
        "validation": {
            "valid": validation.get("valid"),
            "errors": validation.get("errors") or [],
            "warnings": (validation.get("warnings") or [])[:10],
        },
    }


@router.get("/{app_id}/revisions")
def list_app_revisions_endpoint(request: Request, app_id: str, limit: int = Query(50, ge=1, le=200)) -> list[dict[str, Any]]:
    """List immutable App definition snapshots (newest version first)."""
    from evoflow.authz.http_guard import require_app_visible

    require_app_visible(request, app_id)
    if app_repositories.load_app(app_id) is None:
        raise HTTPException(status_code=404, detail=f"Application not found: {app_id}")
    return app_repositories.list_revisions(app_id, limit=limit)


@router.get("/{app_id}/revisions/{version}")
def get_app_revision_endpoint(request: Request, app_id: str, version: int) -> dict[str, Any]:
    """Load a specific App definition snapshot by version."""
    from evoflow.authz.http_guard import require_app_visible

    require_app_visible(request, app_id)
    rev = app_repositories.load_revision(app_id, version)
    if rev is None:
        raise HTTPException(status_code=404, detail=f"Revision not found: {app_id}@v{version}")
    return rev


@router.post("/{app_id}/revisions/{version}/restore")
def restore_app_revision_endpoint(request: Request, app_id: str, version: int) -> dict[str, Any]:
    """Restore definition fields from a revision into a new current version (old snapshots stay)."""
    from evoflow.authz.http_guard import require_app_visible

    require_app_visible(request, app_id)
    try:
        restored = app_repositories.restore_app_from_revision(app_id, version, as_draft=True)
    except ValueError as e:
        msg = str(e)
        code = 404 if "not found" in msg.lower() else 400
        raise HTTPException(status_code=code, detail=msg) from e
    return _decorate_app_response(restored)


@router.get("/{app_id}/runs")
def list_app_runs_endpoint(
    request: Request,
    app_id: str,
    limit: int = Query(20, ge=1, le=100, description="Page size (alias of page_size)"),
    page_size: int | None = Query(None, ge=1, le=100),
    page: int = Query(1, ge=1),
    offset: int | None = Query(None, ge=0, description="Optional raw offset; overrides page when set"),
) -> dict[str, Any]:
    """Paginated run history for an application (most recent first)."""
    from evoflow.authz.http_guard import require_app_visible

    require_app_visible(request, app_id)
    size = int(page_size or limit or 20)
    if offset is not None:
        items = app_repositories.list_runs(app_id, limit=size, offset=int(offset))
        total = app_repositories.count_runs(app_id)
        off = int(offset)
        return {
            "items": items,
            "total": total,
            "page": (off // size) + 1 if size else 1,
            "page_size": size,
            "offset": off,
            "has_more": off + len(items) < total,
        }
    return app_repositories.list_runs_page(app_id, page=page, page_size=size)


@router.get("/runs/{run_id}")
def get_run_status_endpoint(run_id: str) -> dict[str, Any]:
    """Get current execution status of a run (aggregates with task center status)."""
    result = get_run_status(run_id)
    if result is None:
        raise HTTPException(status_code=404, detail=f"Run not found: {run_id}")
    return result


@router.post("/runs/{run_id}/cancel")
async def cancel_run_endpoint(run_id: str, reason: str = "User cancelled") -> dict[str, bool]:
    """Cancel a running application instance (deep cancel, E-2).

    Same depth as Task Center cancel: status flip + authorization revoke +
    cooperative flags + stream worker / LangGraph run / supervisor monitor
    interrupts — not just the status-field flip of the old ``cancel_run``.
    """
    from app.gateway.task_cancel_support import cancel_app_run_deep

    success = await cancel_app_run_deep(run_id, reason)
    if not success:
        raise HTTPException(status_code=404, detail=f"Run not found: {run_id}")
    return {"success": success}


@router.post("/runs/{run_id}/pause")
def pause_run_endpoint(run_id: str, reason: str = "User paused") -> dict[str, bool]:
    """Pause a running application instance."""
    success = pause_run(run_id, reason)
    if not success:
        raise HTTPException(status_code=404, detail=f"Run not found: {run_id}")
    return {"success": success}


@router.post("/runs/{run_id}/resume")
def resume_run_endpoint(run_id: str) -> dict[str, bool]:
    """Resume a paused application instance."""
    success = resume_run(run_id)
    if not success:
        raise HTTPException(status_code=404, detail=f"Run not found: {run_id}")
    return {"success": success}


@router.post("/runs/{run_id}/recover")
async def recover_run_endpoint(run_id: str, reason: str = "api") -> dict:
    """Recover a crashed / failed-node app run from persisted DAG state.

    Heals zombie ``executing`` rows (lease/epoch) and requeues failed steps under
    auto-retry budget, then calls WorkflowRuntime ``retry_wave`` / ``start``.
    Distinct from ``/resume`` (pause-only).
    """
    from evoflow.admin import apps as apps_admin
    from evoflow.admin.errors import NotFoundError, ValidationError

    try:
        return await apps_admin.recover_run_async(run_id, reason=reason or "api")
    except NotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except ValidationError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
