import asyncio
import logging
import os
import sys
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

# HF mirror before any import that may load huggingface_hub.
try:
    from evoflow.knowledge.embedding.hf_env import ensure_hf_hub_env

    ensure_hf_hub_env()
except Exception:
    os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")

from fastapi import FastAPI

from app.gateway.hang_diagnostics import start_gateway_hang_diagnostics
from app.gateway.logging_setup import configure_gateway_file_logging
from app.gateway.middleware import setup_middleware

try:
    from evoflow.utils.bundled_tools import apply_agent_browser_to_path, apply_evoflow_cli_to_path

    apply_evoflow_cli_to_path()
    apply_agent_browser_to_path()
except Exception:
    pass


# File + console logging under ``logs/`` (see ``logging_setup.resolve_gateway_logs_dir``).
# In-process SSE fan-out is only valid in this uvicorn process (not LangGraph CLI).
os.environ["EVOFLOW_GATEWAY_PROCESS"] = "1"

# Windows: set Selector policy before uvicorn creates the loop (import-time).
# Also muffles benign SSE disconnect ERROR from Proactor leftovers.
try:
    from evoflow.platform.asyncio_windows import apply_windows_langgraph_runtime_fixes

    apply_windows_langgraph_runtime_fixes()
except Exception:
    pass

logger = logging.getLogger(__name__)

from app.gateway.startup_trace import startup_mark  # noqa: E402

startup_mark("app.module_imports_done", phase="import")

_app_singleton: FastAPI | None = None


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    """Application lifespan: yield early for liveness; heavy init runs in background."""

    import time as _st

    from app.gateway.background_startup import (
        init_startup_state,
        run_background_startup,
        run_post_ready_warmups,
        shutdown_gateway_background,
    )

    from app.gateway.startup_trace import startup_mark, startup_set_meta, startup_write_summary

    _st0 = _st.perf_counter()

    def _st_log(tag: str) -> None:
        ms = (_st.perf_counter() - _st0) * 1000
        startup_mark(tag, phase="background")
        print(f"[STARTUP] {tag} @ {ms:.0f}ms", file=sys.stderr, flush=True)

    init_startup_state(app)
    startup_mark("lifespan.enter", phase="lifespan")
    _st_log("lifespan enter")
    configure_gateway_file_logging(force=True)
    stop_hang_diagnostics = None
    try:
        from evoflow.platform.asyncio_windows import (
            apply_windows_langgraph_runtime_fixes,
            install_asyncio_benign_disconnect_handler,
        )

        apply_windows_langgraph_runtime_fixes()
        install_asyncio_benign_disconnect_handler()
    except Exception:
        logger.debug("Windows asyncio disconnect handler skipped", exc_info=True)
    stop_hang_diagnostics = start_gateway_hang_diagnostics()
    try:
        from app.gateway.hang_diagnostics import install_gateway_listen_socket_failure_handler

        install_gateway_listen_socket_failure_handler()
    except Exception:
        logger.debug("Gateway listen-socket failure handler skipped", exc_info=True)
    try:
        from evoflow.utils.bundled_tools import apply_agent_browser_to_path, apply_evoflow_cli_to_path

        apply_evoflow_cli_to_path()
        apply_agent_browser_to_path()
    except Exception:
        logger.debug("evoflow CLI PATH setup skipped", exc_info=True)

    async def _background_wrapper() -> None:
        try:
            from app.gateway.cold_start_prewarm import mark_core_routers_ready
            from app.gateway.router_registry import register_core_routers, register_extended_routers

            # CRITICAL: never register FastAPI routes via asyncio.to_thread, and never
            # do first-time schema/fat imports on the live loop (GIL starves HTTP).
            # gateway_entry prewarms before asyncio.run; mount here should be fast.
            await asyncio.sleep(0)  # let lifespan yield + /health/liveness answer first
            app.state.startup_phase = "registering_core_routes"
            _t_core = _st.perf_counter()
            register_core_routers(app)
            await asyncio.sleep(0)
            app.state.routers_registered = True
            app.state.extended_routers_registered = False
            mark_core_routers_ready()
            _st_log(
                f"core routers registered ({(_st.perf_counter() - _t_core) * 1000:.0f}ms)"
            )

            # Flip /health/ready as soon as core API routes exist.
            app.state.startup_ready = True
            app.state.startup_phase = "ready"
            app.state.startup_ready_event.set()
            _st_log("ready to serve")
            startup_write_summary(status="ready")

            try:
                from app.gateway.gateway_shell import load_webui_settings_deferred

                asyncio.create_task(load_webui_settings_deferred(app))
            except Exception:
                logger.debug("Deferred WebUI settings schedule skipped", exc_info=True)

            async def _heavy_and_extended() -> None:
                try:
                    app.state.startup_phase = "initializing"
                    await run_background_startup(app, _st_log, _st)
                    app.state.startup_phase = "ready"
                    _st_log("background init complete")
                except Exception:
                    logger.exception("Gateway background startup failed (heavy)")
                    app.state.startup_error = "background_startup_failed"
                try:
                    app.state.startup_phase = "registering_extended_routes"
                    # Same rule: register on the event loop, not a worker thread.
                    register_extended_routers(app)
                    await asyncio.sleep(0)
                    app.state.extended_routers_registered = True
                    app.state.startup_phase = "ready"
                    _st_log("extended routers registered")
                except Exception:
                    logger.exception("Extended router registration failed (non-fatal)")
                    app.state.startup_phase = "ready"

            heavy_task = asyncio.create_task(_heavy_and_extended())
            warm_task = asyncio.create_task(run_post_ready_warmups(app, _st_log, _st))
            app.state.startup_background_tasks.extend([heavy_task, warm_task])
            logger.info("Post-ready heavy init + KB/vault warmups scheduled (background)")
        except Exception as exc:
            app.state.startup_error = str(exc)
            app.state.startup_phase = "failed"
            startup_write_summary(status="failed", error=str(exc))
            logger.exception("Gateway background startup failed")
            try:
                from app.gateway.cold_start_prewarm import mark_core_routers_ready

                mark_core_routers_ready()
            except Exception:
                pass

    bg_task = asyncio.create_task(_background_wrapper())
    app.state.startup_background_task = bg_task

    startup_mark("lifespan.early_ready", phase="lifespan")
    _st_log("early ready (liveness)")

    # native-style: desktop Tauri owns app-server as a stdio child. Gateway embed is
    # opt-in for debugging only (EVOFLOW_EMBED_APP_SERVER=1).
    embed_on = str(os.environ.get("EVOFLOW_EMBED_APP_SERVER") or "").strip().lower() in (
        "1",
        "true",
        "yes",
        "on",
    )
    if embed_on:
        try:
            from evoflow.app_server.embed import start_embedded_app_server

            app.state.app_server_task = asyncio.create_task(start_embedded_app_server(app))
            _st_log("app-server embed scheduled (EVOFLOW_EMBED_APP_SERVER)")
        except Exception:
            logger.exception("Failed to schedule embedded app-server")
    else:
        _st_log("app-server embed skipped (desktop owns stdio child)")

    try:
        yield
    finally:
        if embed_on:
            try:
                from evoflow.app_server.embed import stop_embedded_app_server

                await stop_embedded_app_server(app)
            except Exception:
                logger.debug("Embedded app-server shutdown failed", exc_info=True)
        try:
            from app.gateway.startup_trace import note_gateway_exit

            note_gateway_exit("lifespan_shutdown", detail="uvicorn/FastAPI lifespan exiting")
        except Exception:
            pass
        await shutdown_gateway_background(app, bg_task, stop_hang_diagnostics)


def create_app(*, defer_routers: bool = True) -> FastAPI:
    """Create and configure the FastAPI application.

    When ``defer_routers`` is True (packaged gateway), only health routes are
    registered so uvicorn can bind quickly; the lifespan background task mounts
    the rest. Dev ``uvicorn app.gateway.app:app`` uses ``defer_routers=False``.
    """
    from app.gateway.startup_trace import startup_mark, startup_set_meta

    startup_mark("create_app.begin", phase="create_app")
    configure_gateway_file_logging(force=True)
    startup_mark("create_app.logging_ok", phase="create_app")
    startup_set_meta(defer_routers=defer_routers, frozen=bool(getattr(sys, "frozen", False)))

    app = FastAPI(
        title="EvoFlow API Gateway",
        description="""
## EvoFlow API Gateway

Control-plane API for EvoFlow — a native Agent Runtime for long-running Agent Teams
(plan → execute → recover → deliver) with sandboxed tools and observability.

### Features

- **Models Management**: Query and retrieve available AI models
- **MCP Configuration**: Manage Model Context Protocol (MCP) server configurations
- **Memory Management**: Access and manage global memory data for personalized conversations
- **Skills Management**: Query and manage skills and their enabled status
- **Artifacts**: Access thread artifacts and generated files
- **Health Monitoring**: System health check endpoints

### Architecture

LangGraph is mounted in-process under ``/api/langgraph`` (single uvicorn process).
This gateway provides custom endpoints for models, MCP configuration, skills, artifacts, and more.
        """,
        version="1.0.0",
        lifespan=lifespan,
        docs_url="/docs",
        redoc_url="/redoc",
        openapi_url="/openapi.json",
        openapi_tags=[
            {
                "name": "models",
                "description": "Operations for querying available AI models and their configurations",
            },
            {
                "name": "mcp",
                "description": "Manage Model Context Protocol (MCP) server configurations",
            },
            {
                "name": "memory",
                "description": "Access and manage global memory data for personalized conversations",
            },
            {
                "name": "skills",
                "description": "Manage skills and their configurations",
            },
            {
                "name": "artifacts",
                "description": "Access and download thread artifacts and generated files",
            },
            {
                "name": "uploads",
                "description": "Upload and manage user files for threads",
            },
            {
                "name": "threads",
                "description": "Manage EvoFlow thread-local filesystem data",
            },
            {
                "name": "agents",
                "description": "Create and manage custom agents with per-agent config and prompts",
            },
            {
                "name": "suggestions",
                "description": "Generate follow-up question suggestions for conversations",
            },
            {
                "name": "channels",
                "description": "Manage IM channel integrations (Feishu, Slack, Telegram)",
            },
            {
                "name": "tasks",
                "description": "Manage tasks within projects",
            },
            {
                "name": "task-detail",
                "description": "Access task execution details and extracted facts",
            },
            {
                "name": "events",
                "description": "Real-time SSE events for project monitoring",
            },
            {
                "name": "collab",
                "description": "Per-thread collaboration phase and bound task/project ids",
            },
            {
                "name": "health",
                "description": "Health check and system status endpoints",
            },
            {
                "name": "sessions",
                "description": "Search and manage conversation sessions with full-text search",
            },
            {
                "name": "goal",
                "description": "Manage goal mode (目标模式) execution sessions",
            },
        ],
    )
    startup_mark("create_app.fastapi_ok", phase="create_app")

    # CORS middleware (required for direct desktop/Tauri access)
    setup_middleware(app)
    startup_mark("create_app.middleware_ok", phase="create_app")

    # Debug: print route table at startup
    print("[gateway] app.routes at create_app time:", file=sys.stderr, flush=True)
    for _r in app.routes:
        _rtype = type(_r).__name__
        _rpath = getattr(_r, 'path', getattr(_r, 'prefix', ''))
        _rmethods = getattr(_r, 'methods', '')
        print(f"  {_rtype} {_rpath} {_rmethods}", file=sys.stderr, flush=True)

    from app.gateway.health_routes import register_health_routes

    register_health_routes(app)
    startup_mark("create_app.health_ok", phase="create_app")

    app.state.routers_registered = False
    app.state._lg_app = None
    app.state._lg_mount_lock = asyncio.Lock()

    from app.gateway.gateway_shell import install_pre_start_middleware

    install_pre_start_middleware(app)
    startup_mark("create_app.pre_start_mw_ok", phase="create_app")

    if not defer_routers:
        from app.gateway.router_registry import register_gateway_routers

        register_gateway_routers(app)
        app.state.routers_registered = True
        app.state.extended_routers_registered = True

    startup_mark("create_app.done", phase="create_app", extra={"route_count": len(app.routes)})
    return app


def __getattr__(name: str) -> FastAPI:
    """Lazy singleton for ``uvicorn app.gateway.app:app`` without import-time ``create_app()``."""
    global _app_singleton
    if name == "app":
        if _app_singleton is None:
            _app_singleton = create_app(defer_routers=True)
        return _app_singleton
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
