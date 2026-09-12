"""Cold-start prewarm — run BEFORE the asyncio event loop accepts HTTP.

CPython: fat imports + ``ensure_app_schema`` hold the GIL. Doing that work on any
thread (including ``asyncio.to_thread``) starves the event loop → listen socket
accepts but never answers (CLOSE_WAIT storm, 「引擎加载中」).

Call :func:`prewarm_gateway_before_event_loop` from ``gateway_entry`` before
``asyncio.run`` / uvicorn so the first liveness probe after bind succeeds.
"""

from __future__ import annotations

import importlib
import logging
import os
import threading
import time
from typing import Iterable

logger = logging.getLogger(__name__)

# Set when core routers are mounted and /health/ready can flip true.
_CORE_ROUTERS_READY = threading.Event()

# Modules imported during register_core_routers (keep in sync with router_registry).
_CORE_ROUTER_MODULES: tuple[str, ...] = (
    "app.gateway.lazy_langgraph",
    "evoflow.langgraph_deployment",
    "app.gateway.routers.models",
    "app.gateway.routers.agents",
    "app.gateway.routers.skills",
    "app.gateway.routers.artifacts",
    "app.gateway.routers.uploads",
    "app.gateway.routers.threads",
    "app.gateway.routers.workspaces",
    "app.gateway.routers.suggestions",
    "app.gateway.routers.goal",
    "app.gateway.routers.license",
    "app.gateway.routers.tasks",
    "app.gateway.routers.items",
    "app.gateway.routers.events",
    "app.gateway.routers.stream_resume",
    "app.gateway.routers.chat_sessions",
    "app.gateway.routers.share",
    "app.gateway.routers.speech",
    "app.gateway.routers.panel_settings",
    "app.gateway.routers.usage",
    "app.gateway.routers.identity",
    "app.gateway.routers.session_notifications",
    "app.gateway.routers.custom_env_settings",
    "app.gateway.routers.media_settings",
    "app.gateway.routers.media_assets",
    "app.gateway.routers.web_search_settings",
    "app.gateway.routers.tool_approval_settings",
    "app.gateway.routers.security_settings",
    "app.gateway.routers.plans",
    "app.gateway.routers.runs",
    "app.gateway.routers.langgraph_proxy",
)


def mark_core_routers_ready() -> None:
    _CORE_ROUTERS_READY.set()


def wait_core_routers_ready(timeout: float = 180.0) -> bool:
    return _CORE_ROUTERS_READY.wait(timeout=timeout)


def core_routers_ready() -> bool:
    return _CORE_ROUTERS_READY.is_set()


def _env_skip_prewarm() -> bool:
    return str(os.environ.get("EVOFLOW_SKIP_GATEWAY_PREWARM") or "").strip().lower() in (
        "1",
        "true",
        "yes",
        "on",
    )


def _import_modules(modules: Iterable[str], *, phase: str) -> None:
    from app.gateway.startup_trace import startup_mark

    for name in modules:
        t0 = time.perf_counter()
        importlib.import_module(name)
        ms = (time.perf_counter() - t0) * 1000.0
        if ms >= 300.0:
            tag = name.rsplit(".", 1)[-1]
            startup_mark(
                f"prewarm.import.{tag}",
                phase=phase,
                extra={"import_ms": round(ms, 1), "module": name},
            )


def prewarm_gateway_before_event_loop() -> None:
    """Open SQLite (schema) + import core routers while no event loop is running."""
    if _env_skip_prewarm():
        logger.info("Gateway prewarm skipped (EVOFLOW_SKIP_GATEWAY_PREWARM)")
        return

    from app.gateway.startup_trace import startup_mark

    startup_mark("prewarm.begin", phase="prewarm")
    t0 = time.perf_counter()

    try:
        from evoflow.persistence.db import get_db

        t_db = time.perf_counter()
        get_db()
        startup_mark(
            "prewarm.db_schema",
            phase="prewarm",
            extra={"ms": round((time.perf_counter() - t_db) * 1000.0, 1)},
        )
    except Exception:
        logger.exception("Gateway prewarm: get_db/schema failed (continuing)")
        startup_mark("prewarm.db_schema_failed", phase="prewarm")

    try:
        # First get_app_config often pulls DB overlays; do it off the future event loop.
        from evoflow.config.app_config import get_app_config

        t_cfg = time.perf_counter()
        get_app_config()
        startup_mark(
            "prewarm.app_config",
            phase="prewarm",
            extra={"ms": round((time.perf_counter() - t_cfg) * 1000.0, 1)},
        )
    except Exception:
        logger.exception("Gateway prewarm: get_app_config failed (continuing)")

    try:
        _import_modules(_CORE_ROUTER_MODULES, phase="prewarm")
        startup_mark("prewarm.core_imports_done", phase="prewarm")
    except Exception:
        logger.exception("Gateway prewarm: core router imports failed (continuing)")
        startup_mark("prewarm.core_imports_failed", phase="prewarm")

    total_ms = (time.perf_counter() - t0) * 1000.0
    startup_mark("prewarm.done", phase="prewarm", extra={"ms": round(total_ms, 1)})
    logger.info("Gateway prewarm done in %.0fms (before event loop)", total_ms)
    print(f"[STARTUP] prewarm done @ {total_ms:.0f}ms (before event loop)", flush=True)
