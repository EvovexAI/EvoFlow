"""List persisted media assets (SQLite index)."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Query, Request
from pydantic import BaseModel, Field

from evoflow.authz.http_guard import require_thread_visible, resolve_authz_from_request
from evoflow.persistence.media_assets import list_media_assets

router = APIRouter(prefix="/api/media", tags=["media"])


class MediaAssetItem(BaseModel):
    id: int
    thread_id: str | None = None
    tool_name: str
    media_kind: str
    provider: str | None = None
    task_id: str | None = None
    status: str
    remote_url: str | None = None
    local_path: str | None = None
    file_size_bytes: int | None = None
    meta: dict[str, Any] = Field(default_factory=dict)
    created_at: str
    updated_at: str


class MediaAssetsListResponse(BaseModel):
    items: list[MediaAssetItem] = Field(default_factory=list)
    count: int = 0


@router.get("/assets", response_model=MediaAssetsListResponse)
async def list_media_assets_api(
    request: Request,
    thread_id: str | None = Query(None, description="Filter by conversation thread id"),
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
) -> MediaAssetsListResponse:
    tid = str(thread_id or "").strip()
    if tid:
        require_thread_visible(request, tid)
        rows = list_media_assets(thread_id=tid, limit=limit, offset=offset)
    else:
        authz = resolve_authz_from_request(request)
        if authz.get("is_admin") or not str(authz.get("principal_id") or "").strip():
            rows = list_media_assets(thread_id=None, limit=limit, offset=offset)
        else:
            raw = list_media_assets(thread_id=None, limit=min(500, max(limit * 10, 100)), offset=0)
            rows = []
            for r in raw:
                rt = str((r or {}).get("thread_id") or "").strip()
                if not rt:
                    continue
                try:
                    require_thread_visible(request, rt)
                except Exception:
                    continue
                rows.append(r)
                if len(rows) >= limit:
                    break
    items = [MediaAssetItem.model_validate(r) for r in rows]
    return MediaAssetsListResponse(items=items, count=len(items))
