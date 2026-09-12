"""EvoPanel embedded WebView2 — per-thread CDP registration for agent-browser."""

from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/threads", tags=["browser-embed"])


class BrowserEmbedCdpBody(BaseModel):
    cdp_url: str = Field(..., min_length=8, description="Chrome DevTools Protocol WebSocket URL")


@router.put("/{thread_id}/browser-embed/cdp")
async def put_browser_embed_cdp(thread_id: str, body: BrowserEmbedCdpBody) -> dict[str, object]:
    from evoflow.tools.builtins.browser_embed_cdp import set_thread_cdp_url

    url = str(body.cdp_url or "").strip()
    if not url.startswith(("ws://", "wss://")):
        raise HTTPException(status_code=400, detail="cdp_url must be a WebSocket URL")
    await asyncio.to_thread(set_thread_cdp_url, thread_id, url)
    logger.info("browser embed cdp stored thread=%s", thread_id)
    return {"thread_id": thread_id, "cdp_url": url, "embed": True}


@router.delete("/{thread_id}/browser-embed/cdp")
async def delete_browser_embed_cdp(thread_id: str) -> dict[str, object]:
    from evoflow.tools.builtins.browser_embed_cdp import clear_thread_cdp_url

    await asyncio.to_thread(clear_thread_cdp_url, thread_id)
    return {"thread_id": thread_id, "cleared": True}


@router.get("/{thread_id}/browser-embed/cdp")
async def get_browser_embed_cdp(thread_id: str) -> dict[str, object]:
    from evoflow.tools.builtins.browser_embed_cdp import get_thread_cdp_url

    url = await asyncio.to_thread(get_thread_cdp_url, thread_id)
    if not url:
        raise HTTPException(status_code=404, detail="No embedded browser CDP for this thread")
    return {"thread_id": thread_id, "cdp_url": url, "embed": True}
