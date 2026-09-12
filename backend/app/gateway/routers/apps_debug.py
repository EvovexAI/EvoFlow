"""Debug endpoints for workflow applications.

Provides single-step debug execution, run-from-step, and step trace inspection.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from app.gateway.deps.license import require_premium
from evoflow.collab.debug_runner import debug_run_from_step, debug_run_step, get_step_trace
from evoflow.authz.http_guard import require_app_visible, require_task_visible
from evoflow.persistence import app_repositories

router = APIRouter(
    prefix="/api/apps",
    tags=["apps-debug"],
    dependencies=[Depends(require_premium)],
)


# ───────────────────────────────── Request Models ─────────────────────────────────


class DebugRunStepRequest(BaseModel):
    """Request body for single-step debug execution."""

    step_ref: str = Field(..., description="Step ref to execute (e.g. '2')")
    parameters: dict[str, str] = Field(default_factory=dict)
    mock_inputs: dict[str, dict[str, Any]] | None = Field(
        default=None,
        description="Mock upstream outputs: {step_ref: {output: {...}, summary: '...'}}",
    )
    execution_mode: str = "workflow"


class DebugRunFromRequest(BaseModel):
    """Request body for run-from-step (re-run from a specific node)."""

    from_step_ref: str = Field(..., description="Step ref to start re-running from")
    base_run_id: str | None = Field(
        default=None,
        description="Previous run ID to reuse upstream results from",
    )
    parameters: dict[str, str] = Field(default_factory=dict)


# ───────────────────────────────── Endpoints ──────────────────────────────────────


@router.post("/{app_id}/debug/run-step")
def debug_run_step_endpoint(http_request: Request, app_id: str, request: DebugRunStepRequest) -> dict[str, Any]:
    """Execute a single step in debug mode.

    Does not create a full run. Uses mock upstream inputs (if provided) to
    resolve input_bindings, builds the prompt, and executes via subagent.
    """
    require_app_visible(http_request, app_id)
    if app_repositories.load_app(app_id) is None:
        raise HTTPException(status_code=404, detail=f"Application not found: {app_id}")

    try:
        result = debug_run_step(
            app_id,
            request.step_ref,
            parameters=request.parameters,
            mock_inputs=request.mock_inputs,
            execution_mode=request.execution_mode,
        )
        if result.get("status") == "error":
            raise HTTPException(status_code=400, detail=result.get("error", "Debug execution failed"))
        return result
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Debug run-step failed: {e}") from e


@router.post("/{app_id}/debug/run-from")
def debug_run_from_endpoint(http_request: Request, app_id: str, request: DebugRunFromRequest) -> dict[str, Any]:
    """Re-run a workflow from a specific step, reusing upstream results.

    Creates a new run, copies upstream subtask results from the base run,
    and dispatches only the target step and its downstream dependencies.
    """
    require_app_visible(http_request, app_id)
    if app_repositories.load_app(app_id) is None:
        raise HTTPException(status_code=404, detail=f"Application not found: {app_id}")

    try:
        result = debug_run_from_step(
            app_id,
            request.from_step_ref,
            base_run_id=request.base_run_id,
            parameters=request.parameters,
        )
        if result.get("error"):
            raise HTTPException(status_code=400, detail=result["error"])
        return result
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Debug run-from failed: {e}") from e


@router.get("/runs/{run_id}/steps/{step_ref}/trace")
def get_step_trace_endpoint(http_request: Request, run_id: str, step_ref: str) -> dict[str, Any]:
    """Retrieve trace data for a completed step in a run.

    Returns actual inputs (resolved bindings), model response, structured
    output, and schema validation status.
    """
    run = app_repositories.load_run(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail=f"Run not found: {run_id}")
    app_id = str(run.get("app_id") or "").strip()
    if app_id:
        require_app_visible(http_request, app_id)
    else:
        tid = str(run.get("task_id") or "").strip()
        if tid:
            require_task_visible(http_request, tid)
    try:
        result = get_step_trace(run_id, step_ref)
        if result.get("error"):
            raise HTTPException(status_code=404, detail=result["error"])
        return result
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to get step trace: {e}") from e
