"""Middleware that must be registered before uvicorn startup (not in deferred router pass)."""

from __future__ import annotations

import logging
import os

from fastapi import FastAPI

logger = logging.getLogger(__name__)


def _desktop_stdio_mode() -> bool:
    return (os.environ.get("EVOFLOW_APP_SERVER_STDIO") or "").strip().lower() in (
        "1",
        "true",
        "yes",
        "on",
    )


def install_pre_start_middleware(app: FastAPI) -> None:
    """WebUI JWT + LangGraph route logger — Starlette forbids add_middleware after startup.

    Desktop stdio: skip importing ``evoflow.webui`` here (~2s cold import). Loopback
    Tauri does not need WebUI JWT on the Gateway; flag loads later if needed.
    """
    if _desktop_stdio_mode():
        app.state.webui_settings_need_load = True
        logger.info("desktop stdio: skip WebUI JWT middleware import during create_app")
    else:
        try:
            from evoflow.webui import create_webui_auth_middleware

            app.add_middleware(create_webui_auth_middleware())
            app.state.webui_settings_need_load = True
        except Exception:
            logger.warning("Failed to initialize WebUI auth middleware", exc_info=True)
            app.state.webui_settings_need_load = False

    from app.gateway.langgraph_route_logger import install_langgraph_route_logger

    install_langgraph_route_logger(app)


async def load_webui_settings_deferred(app: FastAPI) -> None:
    """Best-effort load of WebUI enabled flag after the HTTP server is accepting."""
    if not bool(getattr(app.state, "webui_settings_need_load", False)):
        return
    app.state.webui_settings_need_load = False
    try:
        import asyncio

        from evoflow.webui.auth import _load_webui_enabled, is_webui_enabled

        await asyncio.to_thread(_load_webui_enabled)
        if is_webui_enabled():
            logger.info("WebUI remote access is enabled — JWT auth middleware active")
    except Exception:
        logger.debug("Deferred WebUI settings load failed (non-fatal)", exc_info=True)
