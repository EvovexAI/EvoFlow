"""Serve persisted browser screenshot PNGs (UI only; not sent to the model)."""

from __future__ import annotations

import logging

from fastapi import Request, APIRouter, HTTPException
from evoflow.authz.http_guard import require_thread_visible
from fastapi.responses import FileResponse

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/threads", tags=["browser-snapshots"])


@router.get(
    "/{thread_id}/browser-snapshots/{screenshot_id}",
    summary="Get browser screenshot PNG",
)
async def get_browser_screenshot(request: Request, thread_id: str, screenshot_id: str) -> FileResponse:
    require_thread_visible(request, thread_id)
    from evoflow.tools.builtins.browser_screenshot_store import resolve_screenshot_file

    path = resolve_screenshot_file(thread_id, screenshot_id)
    if path is None:
        raise HTTPException(status_code=404, detail="Screenshot not found")
    return FileResponse(path, media_type="image/png", filename=f"{screenshot_id}.png")
