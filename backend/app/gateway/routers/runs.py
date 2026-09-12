"""Gateway router for run management."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from evoflow.authz.http_guard import require_org_admin
from pydantic import BaseModel

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/langgraph/runs", tags=["runs"])


class RunInfo(BaseModel):
    run_id: str
    thread_id: str
    assistant_id: str
    status: str  # pending, running, success, failed
    created_at: str
    updated_at: str | None = None
    model_name: str | None = None
    is_plan_mode: bool | None = None
    subagent_enabled: bool | None = None


class ListRunsResponse(BaseModel):
    runs: list[RunInfo]
    total: int
    pending: int
    running: int


class CancelRunsRequest(BaseModel):
    status: str | None = None


@router.get("/", response_model=ListRunsResponse)
async def list_runs(
    request: Request,
    status: str | None = None,
    limit: int = 100,
) -> ListRunsResponse:
    require_org_admin(request)
    """List all runs with optional status filtering.

    Args:
        status: Filter by status (pending, running, success, failed)
        limit: Maximum number of runs to return

    Returns:
        List of runs with their status and metadata
    """
    from evoflow.agents.checkpointer.provider import get_checkpointer

    try:
        get_checkpointer()

        # Get all runs from checkpointer
        # Note: This is a simplified implementation
        # In production, you might want to query the database directly
        runs = []

        # For now, return empty list
        # Real implementation would query the checkpointer database
        pending_count = 0
        running_count = 0

        return ListRunsResponse(
            runs=runs,
            total=len(runs),
            pending=pending_count,
            running=running_count,
        )
    except Exception as e:
        logger.error(f"Failed to list runs: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/cancel")
async def cancel_all_runs(request: Request, body: CancelRunsRequest | None = None) -> dict[str, Any]:
    require_org_admin(request)
    """Cancel all pending and running runs across all sessions (best-effort).

    Iterates over every session marked running/pending in SQLite and calls
    ``stop_session_execution`` to cancel the underlying LangGraph run, mark
    the DB idle, persist partial output, and reset collab state.

    This replaces the previous no-op stub so that global cancel (triggered by
    the frontend on startup or user action) actually takes effect.
    """
    _ = body
    try:
        from evoflow.persistence.session_run_state import list_all_active_sessions
        from evoflow.session_execution import stop_session_execution

        rows = list_all_active_sessions(limit=500)

        # Cancel all sessions concurrently (each stop_session_execution does a
        # LangGraph sweep that can take up to 4s; serial would be O(n*4s)).
        # A semaphore caps concurrency to avoid flooding LangGraph with
        # simultaneous cancel requests.
        _MAX_CONCURRENT = 10
        sem = asyncio.Semaphore(_MAX_CONCURRENT)
        cancelled_run_ids: list[str] = []
        cancelled_sessions: list[str] = []
        errors: list[str] = []

        async def _cancel_one(row: dict[str, Any]) -> None:
            sk = str(row.get("session_key") or "").strip()
            if not sk:
                return
            async with sem:
                try:
                    result = await stop_session_execution(sk, user_initiated=True, reason="global_cancel")
                    if result.cancelled_run_ids:
                        cancelled_run_ids.extend(result.cancelled_run_ids)
                    cancelled_sessions.append(sk)
                except Exception as e:
                    logger.warning("cancel_all_runs: failed session=%s: %s", sk, e)
                    errors.append(sk)

        await asyncio.gather(*(_cancel_one(r) for r in rows))

        logger.info(
            "cancel_all_runs: sessions=%d cancelled=%d run_ids=%d errors=%d",
            len(rows),
            len(cancelled_sessions),
            len(cancelled_run_ids),
            len(errors),
        )
        return {
            "ok": True,
            "success": True,
            "cancelled": len(cancelled_run_ids) > 0,
            "cancelled_count": len(cancelled_run_ids),
            "cancelled_sessions": cancelled_sessions,
            "errors": errors,
            "message": (
                f"Cancelled {len(cancelled_run_ids)} run(s) across "
                f"{len(cancelled_sessions)} session(s)."
            ),
        }
    except Exception as e:
        logger.error("Failed to cancel runs: %s", e)
        raise HTTPException(status_code=500, detail=str(e)) from e
