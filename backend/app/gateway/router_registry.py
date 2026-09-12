"""Register Gateway API routers (lazy imports — run after liveness bind)."""

from __future__ import annotations

import importlib
import logging
import sys
import time
from typing import Any

from fastapi import Depends, FastAPI

logger = logging.getLogger(__name__)

_SLOW_ROUTER_IMPORT_MS = 300.0


def _include_module_router(
    app: FastAPI,
    module: str,
    *,
    label: str = "",
    slow_ms: float = _SLOW_ROUTER_IMPORT_MS,
    **include_kwargs: Any,
) -> None:
    """Import one router module and mount it; log slow imports to STARTUP-TRACE."""
    from app.gateway.startup_trace import startup_mark

    tag = label or module.rsplit(".", 1)[-1]
    t0 = time.perf_counter()
    mod = importlib.import_module(module)
    router = getattr(mod, "router")
    app.include_router(router, **include_kwargs)
    ms = (time.perf_counter() - t0) * 1000.0
    if ms >= slow_ms:
        startup_mark(
            f"router.import.{tag}",
            phase="routers",
            extra={"import_ms": round(ms, 1)},
        )


def register_core_routers(app: FastAPI) -> None:
    """Fast path: home, chat shell, tasks, settings — avoid heavy KB/obs imports."""
    from app.gateway.startup_trace import startup_mark

    startup_mark("register_core_routers.begin", phase="routers")
    t_imports = time.perf_counter()

    from app.gateway.lazy_langgraph import LazyLangGraphMount, install_external_langgraph_proxy
    from evoflow.langgraph_deployment import is_external_langgraph_mode

    startup_mark(
        "register_core_routers.bootstrap_imports",
        phase="routers",
        extra={"import_ms": round((time.perf_counter() - t_imports) * 1000.0, 1)},
    )

    _include_module_router(app, "app.gateway.routers.models", label="models")
    _include_module_router(app, "app.gateway.routers.agents", label="agents")
    _include_module_router(app, "app.gateway.routers.skills", label="skills")
    _include_module_router(app, "app.gateway.routers.artifacts", label="artifacts")
    _include_module_router(app, "app.gateway.routers.uploads", label="uploads")
    _include_module_router(app, "app.gateway.routers.threads", label="threads")
    _include_module_router(app, "app.gateway.routers.workspaces", label="workspaces")
    _include_module_router(app, "app.gateway.routers.suggestions", label="suggestions")
    _include_module_router(app, "app.gateway.routers.goal", label="goal")
    _include_module_router(app, "app.gateway.routers.license", label="license")
    _include_module_router(app, "app.gateway.routers.tasks", label="tasks")
    _include_module_router(app, "app.gateway.routers.items", label="items")
    _include_module_router(app, "app.gateway.routers.events", label="events")
    _include_module_router(app, "app.gateway.routers.stream_resume", label="stream_resume")
    _include_module_router(app, "app.gateway.routers.chat_sessions", label="chat_sessions")
    _include_module_router(app, "app.gateway.routers.share", label="share")
    _include_module_router(app, "app.gateway.routers.speech", label="speech")
    _include_module_router(app, "app.gateway.routers.panel_settings", label="panel_settings")
    _include_module_router(app, "app.gateway.routers.usage", label="usage")
    _include_module_router(app, "app.gateway.routers.identity", label="identity")
    _include_module_router(app, "app.gateway.routers.session_notifications", label="session_notifications")
    _include_module_router(app, "app.gateway.routers.custom_env_settings", label="custom_env_settings")
    _include_module_router(app, "app.gateway.routers.media_settings", label="media_settings")
    _include_module_router(app, "app.gateway.routers.media_assets", label="media_assets")
    _include_module_router(app, "app.gateway.routers.web_search_settings", label="web_search_settings")
    _include_module_router(app, "app.gateway.routers.tool_approval_settings", label="tool_approval_settings")
    _include_module_router(app, "app.gateway.routers.security_settings", label="security_settings")
    _include_module_router(app, "app.gateway.routers.plans", label="plans")
    _include_module_router(app, "app.gateway.routers.runs", label="runs")

    langgraph_proxy = importlib.import_module("app.gateway.routers.langgraph_proxy")
    app.include_router(langgraph_proxy.router, include_in_schema=False)
    print(
        f"[gateway] langgraph_proxy routes: {[r.path for r in langgraph_proxy.router.routes]}",
        file=sys.stderr,
        flush=True,
    )

    if is_external_langgraph_mode():
        install_external_langgraph_proxy(app)
    else:
        app.state._lg_external = False

    app.mount("/api/langgraph", LazyLangGraphMount(app))
    mode = "external proxy" if is_external_langgraph_mode() else "deferred in-process"
    print(f"[gateway] LangGraph mount at /api/langgraph ({mode})", file=sys.stderr, flush=True)
    logger.info("[gateway] LangGraph mount at /api/langgraph (%s)", mode)

    startup_mark("register_core_routers.done", phase="routers", extra={"route_count": len(app.routes)})


def register_extended_routers(app: FastAPI) -> None:
    """Heavy routers: knowledge, observability, eval, WebUI static, etc."""
    from fastapi import Depends

    from app.gateway.deps.license import require_premium
    from app.gateway.startup_trace import startup_mark

    startup_mark("register_extended_routers.begin", phase="routers")

    # Deferred from core: not needed for first chat paint; cuts core import time.
    _include_module_router(app, "app.gateway.routers.automation_scheduler", label="automation_scheduler")
    _include_module_router(app, "app.gateway.routers.apps", label="apps")
    _include_module_router(app, "app.gateway.routers.organizations", label="organizations")
    _include_module_router(app, "app.gateway.routers.collab", label="collab")
    try:
        from evoflow.proactive.router import router as proactive_router

        app.include_router(proactive_router, dependencies=[Depends(require_premium)])
    except Exception:
        logger.exception("failed to register proactive router (extended)")

    _include_module_router(app, "app.gateway.routers.mcp", label="mcp")
    _include_module_router(app, "app.gateway.routers.memory", label="memory")
    _include_module_router(app, "app.gateway.routers.assets", label="assets")
    _include_module_router(app, "app.gateway.routers.knowledge_vaults", label="knowledge_vaults")
    _include_module_router(app, "app.gateway.routers.knowledge_owned", label="knowledge_owned")
    _include_module_router(app, "app.gateway.routers.knowledge", label="knowledge")
    _include_module_router(app, "app.gateway.routers.browser_embed", label="browser_embed")
    _include_module_router(app, "app.gateway.routers.browser_snapshots", label="browser_snapshots")
    _include_module_router(app, "app.gateway.routers.browser_stream", label="browser_stream")
    _include_module_router(app, "app.gateway.routers.stage_news", label="stage_news")
    _include_module_router(app, "app.gateway.routers.auth", label="auth")
    _include_module_router(app, "app.gateway.routers.openai_compat_apps", label="openai_compat_apps")
    _include_module_router(app, "app.gateway.routers.tools", label="tools")
    _include_module_router(app, "app.gateway.routers.mcp_server", label="mcp_server")
    _include_module_router(app, "app.gateway.routers.webui", label="webui")
    _include_module_router(app, "app.gateway.routers.channels", label="channels")
    _include_module_router(app, "app.gateway.routers.platform_config", label="platform_config")
    _include_module_router(app, "app.gateway.routers.apps_debug", label="apps_debug")
    _include_module_router(app, "app.gateway.routers.task_memory", label="task_memory")
    _include_module_router(app, "app.gateway.routers.sessions", label="sessions")
    _include_module_router(app, "app.gateway.routers.a2a", label="a2a")
    _include_module_router(app, "app.gateway.routers.meetings", label="meetings")
    _include_module_router(app, "app.gateway.routers.eval", label="eval")
    _include_module_router(
        app,
        "app.gateway.routers.client_trace",
        label="client_trace",
        include_in_schema=False,
    )
    _include_module_router(
        app,
        "app.gateway.routers.client_presence",
        label="client_presence",
        include_in_schema=False,
    )

    client_trace = importlib.import_module("app.gateway.routers.client_trace")
    print(
        f"[gateway] client_trace routes: {[r.path for r in client_trace.router.routes]}",
        file=sys.stderr,
        flush=True,
    )

    _include_module_router(app, "app.gateway.routers.runtime_paths", label="runtime_paths")
    _include_module_router(app, "app.gateway.routers.debug_agent_trace", label="debug_agent_trace")
    _include_module_router(app, "app.gateway.routers.hang_diagnostics", label="hang_diagnostics")
    _include_module_router(app, "app.gateway.routers.observability", label="observability")
    _include_module_router(app, "app.gateway.routers.diagnostics", label="diagnostics")
    _include_module_router(app, "app.gateway.routers.platform", label="platform")

    try:
        from evoflow.webui.auth import _load_webui_enabled
        from evoflow.webui.static import mount_evopanel_static

        _load_webui_enabled()
        mount_evopanel_static(app)
    except Exception:
        logger.warning("Failed to mount EvoPanel static files", exc_info=True)

    startup_mark("register_extended_routers.done", phase="routers", extra={"route_count": len(app.routes)})


def register_gateway_routers(app: FastAPI) -> None:
    """Mount all API routers (dev / non-deferred startup)."""
    register_core_routers(app)
    register_extended_routers(app)
