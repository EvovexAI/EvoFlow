"""Gateway router for session search."""

import logging
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

from evoflow.authz.http_guard import require_org_admin, require_session_visible, resolve_authz_from_request
from evoflow.persistence import session_repositories as sess_repo

router = APIRouter(prefix="/api/sessions", tags=["sessions"])

def _filter_search_hits(http_request: Request, results: list[dict]) -> list[dict]:
    authz = resolve_authz_from_request(http_request)
    if authz.get("is_admin") or not str(authz.get("principal_id") or "").strip():
        return results
    out = []
    for r in results:
        tid = str(r.get("thread_id") or "").strip()
        if not tid:
            continue
        sk = sess_repo.find_session_key_by_thread_id(tid)
        if not sk:
            continue
        try:
            require_session_visible(http_request, sk)
        except Exception:
            continue
        out.append(r)
    return out



class SessionSearchRequest(BaseModel):
    """Request model for session search."""

    query: str = Field(..., description="Search query string")
    limit: int = Field(default=10, ge=1, le=100, description="Maximum number of results")
    offset: int = Field(default=0, ge=0, description="Offset for pagination")
    assistant_id: str | None = Field(default=None, description="Filter by assistant ID")
    date_from: str | None = Field(default=None, description="Filter by date range (ISO format, start)")
    date_to: str | None = Field(default=None, description="Filter by date range (ISO format, end)")
    search_in: str = Field(default="all", description="Where to search: 'user', 'assistant', or 'all'")


class SessionSearchResult(BaseModel):
    """Single search result."""

    thread_id: str = Field(..., description="Thread/session ID")
    assistant_id: str | None = Field(None, description="Assistant ID")
    created_at: str = Field(..., description="Session creation time")
    updated_at: str = Field(..., description="Session last update time")
    message_count: int = Field(..., description="Number of messages in session")
    rank: float = Field(..., description="Search relevance rank (lower is better)")
    snippet: str | None = Field(None, description="Highlighted snippet")
    user_content_preview: str | None = Field(None, description="User content preview")
    assistant_content_preview: str | None = Field(None, description="Assistant content preview")


class SessionSearchResponse(BaseModel):
    """Response model for session search."""

    results: list[SessionSearchResult]
    total: int = Field(..., description="Total number of matching sessions")
    query: str = Field(..., description="Original search query")
    limit: int = Field(..., description="Results limit")
    offset: int = Field(..., description="Results offset")


@router.post("/search", response_model=SessionSearchResponse, summary="Search Sessions", description="Search conversation sessions using full-text search (FTS5). Supports filtering by assistant, date range, and content type.")
async def search_sessions(http_request: Request, request: SessionSearchRequest) -> SessionSearchResponse:
    """Search conversation sessions.

    Args:
        request: Search request with query and optional filters

    Returns:
        Search results with metadata
    """
    try:
        from evoflow.agents.checkpointer.session_search import get_session_search

        search = get_session_search()

        # Perform search
        results = search.search(query=request.query, limit=request.limit, offset=request.offset, assistant_id=request.assistant_id, date_from=request.date_from, date_to=request.date_to, search_in=request.search_in)

        # Get total count
        total = search.get_session_count(assistant_id=request.assistant_id, date_from=request.date_from, date_to=request.date_to)

        filtered = _filter_search_hits(http_request, results)
        return SessionSearchResponse(results=[SessionSearchResult(**r) for r in filtered], total=len(filtered) if filtered != results else total, query=request.query, limit=request.limit, offset=request.offset)

    except Exception as e:
        logger.error(f"Failed to search sessions: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"搜索失败: {str(e)}")


@router.get("/search", response_model=SessionSearchResponse, summary="Search Sessions (GET)", description="Search conversation sessions using GET method with query parameters.")
async def search_sessions_get(
    http_request: Request,
    query: str = Query(..., description="Search query string"),
    limit: int = Query(default=10, ge=1, le=100, description="Maximum number of results"),
    offset: int = Query(default=0, ge=0, description="Offset for pagination"),
    assistant_id: str | None = Query(default=None, description="Filter by assistant ID"),
    date_from: str | None = Query(default=None, description="Filter by date range (start)"),
    date_to: str | None = Query(default=None, description="Filter by date range (end)"),
    search_in: str = Query(default="all", description="Where to search: 'user', 'assistant', or 'all'"),
) -> SessionSearchResponse:
    """Search conversation sessions using GET method.

    This endpoint is convenient for browser testing and simple integrations.
    """
    request = SessionSearchRequest(query=query, limit=limit, offset=offset, assistant_id=assistant_id, date_from=date_from, date_to=date_to, search_in=search_in)
    return await search_sessions(http_request, request)


@router.post("/rebuild-index", summary="Rebuild Search Index", description="Rebuild the FTS5 search index from scratch. Use this after bulk data changes.")
async def rebuild_search_index(http_request: Request) -> dict[str, Any]:
    require_org_admin(http_request)
    """Rebuild the FTS5 search index.

    This is useful after bulk data changes or if the index becomes corrupted.
    """
    try:
        from evoflow.agents.checkpointer.session_search import get_session_search

        search = get_session_search()
        count = search.rebuild_index()

        return {"success": True, "message": "搜索索引重建成功", "indexed_sessions": count}

    except Exception as e:
        logger.error(f"Failed to rebuild search index: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"重建索引失败: {str(e)}")


@router.get("/stats", summary="Session Statistics", description="Get statistics about indexed sessions.")
async def get_session_stats(http_request: Request) -> dict[str, Any]:
    require_org_admin(http_request)
    """Get session statistics.

    Returns:
        Statistics about indexed sessions
    """
    try:
        from evoflow.agents.checkpointer.session_search import get_session_search

        search = get_session_search()
        total = search.get_session_count()

        return {"total_sessions": total, "index_initialized": search._initialized}

    except Exception as e:
        logger.error(f"Failed to get session stats: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"获取统计信息失败: {str(e)}")
