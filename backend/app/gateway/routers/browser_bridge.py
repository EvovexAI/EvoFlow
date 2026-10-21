"""Browser bridge HTTP surface — exposes the EvoFlow browser engine to the
node-repl-host kernel bridge (browser-use plugin's ``control-browser`` skill).

Commands use the ZCode browser command contract verbatim (``method`` + payload
fields, see :mod:`evoflow.tools.builtins.browser_contract`); the engine already
implements it. Single-webview model: ``/api/browser/tabs`` reports the one
shared page as a single-element tab list.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from evoflow.authz.http_guard import require_org_admin

logger = logging.getLogger(__name__)

_BRIDGE_THREAD_ID = "evoflow-node-repl-bridge"
_ENGINE_TIMEOUT_SEC = 60.0


def _org_admin_guard(request: Request) -> None:
    require_org_admin(request)


def _bridge_token_guard(request: Request) -> None:
    """内核桥命令面共享令牌校验（bridge_auth）。

    面板控制走 Tauri 命令、日志走 /api/browser/log，都不经过这些端点；唯一预期
    调用方是 node-repl 内核桥（env 注入 token）。缺失/不匹配 → 403。
    """
    from evoflow.plugins.bridge_auth import verify_bridge_token

    if not verify_bridge_token(request):
        raise HTTPException(status_code=403, detail="browser bridge token required")


router = APIRouter(prefix="/api/browser", tags=["browser-bridge"], dependencies=[Depends(_org_admin_guard)])


class BrowserExecuteRequest(BaseModel):
    command: dict[str, Any] = Field(..., description="EvoFlow browser command (method + payload fields)")
    threadId: str | None = Field(default=None, description="Optional engine session key")


class BrowserLogEntry(BaseModel):
    ts: str | None = Field(default=None, description="Frontend timestamp (ISO or epoch ms)")
    level: str = Field(default="info", description="info | warn | error")
    msg: str = Field(..., description="One log line")


class BrowserLogBatch(BaseModel):
    source: str = Field(default="web", description="Marker for the emitting surface, e.g. web")
    entries: list[BrowserLogEntry] = Field(default_factory=list)


@router.post("/log")
async def append_browser_log(batch: BrowserLogBatch) -> dict[str, Any]:
    """前端浏览器日志统一落盘到 logs/plugin-control.log（三端汇聚，见 browser_debug_log）。"""
    from evoflow.tools.builtins.browser_debug_log import browser_debug_log, install_browser_debug_mirror

    # LangGraph lifespan 的 dictConfig 会摘掉 root 上的镜像 handler；每次浏览器
    # 请求幂等重挂（自愈），保证引擎日志持续进统一文件。
    install_browser_debug_mirror()
    source = str(batch.source or "web").strip() or "web"
    for entry in batch.entries:
        msg = str(entry.msg or "").replace("\n", " ")[:2000]
        level = str(entry.level or "info")
        prefix = f"{level}:{entry.ts} " if (entry.ts and level != "info") else (entry.ts or "")
        browser_debug_log(source, f"{prefix}{msg}".strip())
    return {"ok": True, "count": len(batch.entries)}


def _get_engine():
    from evoflow.tools.builtins.browser_engine import get_browser_engine

    return get_browser_engine()


@router.post(
    "/execute",
    dependencies=[Depends(_bridge_token_guard)],
)
async def execute_command(payload: BrowserExecuteRequest) -> dict[str, Any]:
    """Run one ZCode-style browser command through the browser engine."""
    from evoflow.tools.builtins.browser_debug_log import install_browser_debug_mirror

    install_browser_debug_mirror()
    engine = _get_engine()
    thread_id = payload.threadId or _BRIDGE_THREAD_ID
    result = await asyncio.to_thread(engine.execute, thread_id, payload.command, _ENGINE_TIMEOUT_SEC)
    return result


@router.get(
    "/transport",
    dependencies=[Depends(_bridge_token_guard)],
)
async def get_transport() -> dict[str, Any]:
    """当前浏览器传输通道。只有 webview2（内置面板）可被工具驱动；edge 会被拒绝。"""
    import os

    from evoflow.tools.builtins.browser_engine import _EVOFLOW_DIR

    transport = "unknown"
    port: int | None = None
    transport_file = os.path.join(_EVOFLOW_DIR, "browser-cdp-transport")
    port_file = os.path.join(_EVOFLOW_DIR, "browser-cdp-http-port")
    try:
        if os.path.isfile(transport_file):
            transport = open(transport_file, encoding="utf-8").read().strip().lower() or "unknown"
    except OSError:
        pass
    try:
        if os.path.isfile(port_file):
            raw = open(port_file, encoding="utf-8").read().strip()
            digits = "".join(ch for ch in raw if ch.isdigit())
            port = int(digits) if digits else None
    except (OSError, ValueError):
        port = None
    return {"transport": transport, "httpPort": port}


@router.get(
    "/tabs",
    dependencies=[Depends(_bridge_token_guard)],
)
async def list_tabs() -> dict[str, Any]:
    """Tab list in the browser-client ``BrowserTabSummary`` shape (single webview model)."""
    engine = _get_engine()
    state = await asyncio.to_thread(engine.execute, _BRIDGE_THREAD_ID, {"method": "getState"}, 30.0)
    page_state = state.get("state") or {}
    tab = {
        "tabId": "primary",
        "url": str(page_state.get("url") or "about:blank"),
        "title": str(page_state.get("title") or ""),
        "viewport": page_state.get("viewport") or {"width": 1280, "height": 720},
        "active": True,
    }
    return {"tabs": [tab], "activeTabId": "primary"}
