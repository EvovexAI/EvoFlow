import logging

from fastapi import Request, APIRouter, HTTPException
from evoflow.authz.http_guard import require_thread_visible
from pydantic import BaseModel

from evoflow.config.paths import Paths, get_paths

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/threads", tags=["threads"])


class ThreadDeleteResponse(BaseModel):
    """Response model for thread cleanup."""

    success: bool
    message: str


def _delete_thread_data(thread_id: str, paths: Paths | None = None) -> ThreadDeleteResponse:
    """Delete local persisted filesystem data for a thread."""
    path_manager = paths or get_paths()
    try:
        path_manager.delete_thread_dir(thread_id)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("Failed to delete thread data for %s", thread_id)
        raise HTTPException(status_code=500, detail="Failed to delete local thread data.") from exc

    logger.info("Deleted local thread data for %s", thread_id)
    return ThreadDeleteResponse(success=True, message=f"Deleted local thread data for {thread_id}")


@router.get("/{thread_id}/tool-timeline")
async def get_thread_tool_timeline(request: Request, 
    thread_id: str,
    query: str | None = None,
    tool_name: str | None = None,
    status: str | None = None,
    limit: int = 20,
) -> dict:
    """Recent tool invocations for a thread (observability SQLite or JSONL fallback)."""
    require_thread_visible(request, thread_id)
    from evoflow.context.tool_timeline import search_tool_timeline

    return search_tool_timeline(
        thread_id,
        query=query,
        tool_name=tool_name,
        status=status,
        limit=min(100, max(1, limit)),
    )


@router.delete("/{thread_id}", response_model=ThreadDeleteResponse)
async def delete_thread_data(request: Request, thread_id: str) -> ThreadDeleteResponse:
    """Delete local persisted filesystem data for a thread.

    This endpoint only cleans EvoFlow-managed thread directories. LangGraph
    thread state deletion remains handled by the LangGraph API.
    """
    require_thread_visible(request, thread_id)
    return _delete_thread_data(thread_id)
