"""Register Gateway API routers (lazy imports — run after liveness bind)."""

from __future__ import annotations

import importlib
import logging
import os
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
    optional: bool = False,
    **include_kwargs: Any,
) -> bool:
    """Import one router module and mount it; log slow imports to STARTUP-TRACE.

    Returns True when the router was mounted. When ``optional`` is True, import
    / mount failures are logged and return False instead of aborting the rest of
    ``register_extended_routers`` (packaged builds must not brick employee /
    apps / automation behind a permanent ``loading_extended`` 503).
    """
    from app.gateway.startup_trace import startup_mark

    tag = label or module.rsplit(".", 1)[-1]
    t0 = time.perf_counter()
    try:
        mod = importlib.import_module(module)
        router = getattr(mod, "router")
        app.include_router(router, **include_kwargs)
        # v4 routes 模块附带独立前缀的 conversation_router（ZCode v4 wire，H3-C）。
        extra_router = getattr(mod, "conversation_router", None)
        if extra_router is not None:
            app.include_router(extra_router, **include_kwargs)
    except Exception:
        if optional:
            logger.exception("optional router %s (%s) failed to register — continuing", tag, module)
            return False
        raise
    ms = (time.perf_counter() - t0) * 1000.0
    if ms >= slow_ms:
        startup_mark(
            f"router.import.{tag}",
            phase="routers",
            extra={"import_ms": round(ms, 1)},
        )
    return True


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
    _include_module_router(app, "app.gateway.routers.ui_extensions", label="ui_extensions")
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
    _include_module_router(app, "app.gateway.routers.background_bash", label="background_bash")

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
    """Heavy routers: knowledge, observability, eval, WebUI static, etc.

    Each mount is best-effort (``optional=True``): one missing module in a
    frozen desktop build must not leave ``extended_routers_registered`` unset
    and 503 every employee / apps / automation / knowledge request forever.
    """

    from app.gateway.deps.license import require_premium
    from app.gateway.startup_trace import startup_mark

    startup_mark("register_extended_routers.begin", phase="routers")

    # Deferred from core: not needed for first chat paint; cuts core import time.
    _extended = (
        ("app.gateway.routers.automation_scheduler", "automation_scheduler", {}),
        ("app.gateway.routers.apps", "apps", {}),
        ("app.gateway.routers.organizations", "organizations", {}),
        ("app.gateway.routers.collab", "collab", {}),
        ("app.gateway.routers.mcp", "mcp", {}),
        ("app.gateway.routers.plugins", "plugins", {}),
        ("app.gateway.routers.browser_bridge", "browser_bridge", {}),
        ("app.gateway.routers.cua_bridge", "cua_bridge", {}),
        ("app.gateway.routers.memory", "memory", {}),
        ("app.gateway.routers.assets", "assets", {}),
        ("app.gateway.routers.knowledge_owned", "knowledge_owned", {}),
        ("app.gateway.routers.knowledge", "knowledge", {}),
        ("app.gateway.routers.browser_embed", "browser_embed", {}),
        ("app.gateway.routers.browser_snapshots", "browser_snapshots", {}),
        ("app.gateway.routers.browser_stream", "browser_stream", {}),
        ("app.gateway.routers.stage_news", "stage_news", {}),
        ("app.gateway.routers.auth", "auth", {}),
        ("app.gateway.routers.openai_compat_apps", "openai_compat_apps", {}),
        ("app.gateway.routers.tools", "tools", {}),
        ("app.gateway.routers.mcp_server", "mcp_server", {}),
        ("app.gateway.routers.webui", "webui", {}),
        ("app.gateway.routers.channels", "channels", {}),
        ("app.gateway.routers.platform_config", "platform_config", {}),
        ("app.gateway.routers.apps_debug", "apps_debug", {}),
        ("app.gateway.routers.task_memory", "task_memory", {}),
        ("app.gateway.routers.sessions", "sessions", {}),
        ("app.gateway.routers.a2a", "a2a", {}),
        ("app.gateway.routers.meetings", "meetings", {}),
        ("app.gateway.routers.eval", "eval", {}),
        # Packaged builds historically omitted app.gateway.v4 from hiddenimports.
        ("app.gateway.v4.routes", "v4_sessions", {"include_in_schema": False}),
        ("app.gateway.routers.client_trace", "client_trace", {"include_in_schema": False}),
        ("app.gateway.routers.client_presence", "client_presence", {"include_in_schema": False}),
        ("app.gateway.routers.runtime_paths", "runtime_paths", {}),
        ("app.gateway.routers.debug_agent_trace", "debug_agent_trace", {}),
        ("app.gateway.routers.hang_diagnostics", "hang_diagnostics", {}),
        ("app.gateway.routers.debug_stream_paint", "debug_stream_paint", {}),
        ("app.gateway.routers.observability", "observability", {}),
        ("app.gateway.routers.diagnostics", "diagnostics", {}),
        ("app.gateway.routers.platform", "platform", {}),
    )

    mounted = 0
    failed: list[str] = []
    for module, label, kwargs in _extended:
        if _include_module_router(app, module, label=label, optional=True, **kwargs):
            mounted += 1
        else:
            failed.append(label)

    try:
        from evoflow.proactive.router import router as proactive_router

        app.include_router(proactive_router, dependencies=[Depends(require_premium)])
        mounted += 1
    except Exception:
        logger.exception("failed to register proactive router (extended)")
        failed.append("proactive")

    try:
        client_trace = importlib.import_module("app.gateway.routers.client_trace")
        print(
            f"[gateway] client_trace routes: {[r.path for r in client_trace.router.routes]}",
            file=sys.stderr,
            flush=True,
        )
    except Exception:
        logger.debug("client_trace route dump skipped", exc_info=True)

    try:
        from evoflow.webui.auth import _load_webui_enabled
        from evoflow.webui.static import mount_evopanel_static

        _load_webui_enabled()
        mount_evopanel_static(app)
    except Exception:
        logger.warning("Failed to mount EvoPanel static files", exc_info=True)

    startup_mark(
        "register_extended_routers.done",
        phase="routers",
        extra={
            "route_count": len(app.routes),
            "mounted": mounted,
            "failed": failed,
        },
    )
    if failed:
        logger.warning(
            "Extended routers partially registered mounted=%s failed=%s",
            mounted,
            ",".join(failed),
        )


def register_v4_demo_router(app: FastAPI) -> None:
    """H1 demo: v4 protocol projection endpoints.

    仅在 ``EVOFLOW_V4_DEMO`` 环境变量开启时挂载；生产构建不会带。
    """
    if not bool(int(os.environ.get("EVOFLOW_V4_DEMO", "0"))):
        return
    _include_module_router(app, "app.gateway.v4_demo.routes", label="v4-demo")


def register_v4_conversation_router(app: FastAPI) -> None:
    """V4 conversation wire 协议路由（生产主聊天流式链路）。

    默认挂载（``EVOFLOW_V4_ROUTES=0`` 可关）：/api/v4/conversation/* 是
    AG-UI 镜像（``app.gateway.v4.agui_mirror``）的订阅面，客户端
    EvoFlowV4ChatPane 依赖它做双轨灰度。
    """
    if os.environ.get("EVOFLOW_V4_ROUTES", "1").strip().lower() in {"0", "false", "off", "no"}:
        return
    _include_module_router(app, "app.gateway.v4.routes", label="v4-conversation")


def register_gateway_routers(app: FastAPI) -> None:
    """Mount all API routers (dev / non-deferred startup)."""
    register_core_routers(app)
    register_extended_routers(app)
    register_v4_demo_router(app)
    register_v4_conversation_router(app)
