"""Health probes — registered first so liveness is available before heavy API routers."""

from __future__ import annotations

import os

from fastapi import FastAPI, Request
from starlette.responses import JSONResponse


def register_health_routes(app: FastAPI) -> None:
    @app.get("/health", tags=["health"])
    async def health_check() -> dict:
        try:
            from app.gateway.hang_diagnostics import (
                get_event_loop_lag_seconds,
                is_event_loop_overloaded,
                is_listen_socket_broken,
                listen_socket_broken_detail,
            )

            if is_listen_socket_broken():
                return {
                    "status": "unhealthy",
                    "service": "evo-flow-gateway",
                    "reason": "listen_socket_broken",
                    "detail": listen_socket_broken_detail(),
                }
            if is_event_loop_overloaded():
                return {
                    "status": "degraded",
                    "service": "evo-flow-gateway",
                    "reason": "event_loop_overloaded",
                    "event_loop_lag_seconds": round(get_event_loop_lag_seconds(), 3),
                }
        except Exception:
            pass
        return {"status": "healthy", "service": "evo-flow-gateway"}

    @app.get("/health/liveness", tags=["health"])
    def liveness_check() -> dict:
        # Sync def → threadpool: still answer when the asyncio loop is briefly busy.
        # Guardian must treat process-alive separately; this only helps under GIL stalls.
        body: dict = {"status": "alive", "service": "evo-flow-gateway", "pid": os.getpid()}
        try:
            from app.gateway.hang_diagnostics import get_event_loop_lag_seconds, is_event_loop_overloaded

            lag = get_event_loop_lag_seconds()
            body["event_loop_lag_seconds"] = round(lag, 3)
            if is_event_loop_overloaded():
                body["degraded"] = True
                body["reason"] = "event_loop_overloaded"
        except Exception:
            pass
        return body

    @app.get("/health/app-server", tags=["health"])
    async def app_server_health(request: Request) -> dict:
        port = getattr(request.app.state, "app_server_port", None)
        err = getattr(request.app.state, "app_server_error", None)
        return {
            "status": "listening" if port else "unavailable",
            "port": port,
            "host": "127.0.0.1",
            "error": err,
        }

    @app.get("/health/ready", tags=["health"], response_model=None)
    async def readiness_check(request: Request) -> dict | JSONResponse:
        # Codex-style: ready means core control plane can serve API (routers mounted),
        # not merely that the listen socket is up (that is /health/liveness).
        ready = bool(getattr(request.app.state, "startup_ready", False))
        phase = str(getattr(request.app.state, "startup_phase", "unknown") or "unknown")
        extended = bool(getattr(request.app.state, "extended_routers_registered", False))
        routers = bool(getattr(request.app.state, "routers_registered", False))
        langgraph = bool(getattr(request.app.state, "langgraph_ready", False))
        if ready:
            return {
                "status": "ready" if langgraph else "warming_up",
                "service": "evo-flow-gateway",
                "phase": phase,
                "core_routers": routers,
                "extended_routers": extended,
                "langgraph": langgraph,
            }
        err = getattr(request.app.state, "startup_error", None)
        body: dict = {
            "status": "not_ready",
            "service": "evo-flow-gateway",
            "phase": phase,
            "core_routers": routers,
            "extended_routers": extended,
        }
        if err:
            body["error"] = str(err)
        return JSONResponse(status_code=503, content=body)

    @app.get("/health/proc", tags=["health"])
    def proc_liveness_check() -> dict:
        return {"status": "alive", "service": "evo-flow-gateway", "pid": os.getpid()}

    @app.post("/health/soft-reload", tags=["health"], include_in_schema=False, response_model=None)
    async def soft_reload_caches() -> dict | JSONResponse:
        """In-process config cache refresh (desktop preferred over kill+spawn).

        Always available on the health surface so the panel can soft-reload
        before extended routers mount. Local / unauthenticated callers are
        treated as admin elsewhere; this route intentionally has no auth gate.
        """
        try:
            from evoflow.config.app_config import reload_app_config
            from evoflow.config.extensions_config import reload_extensions_config
            from evoflow.config.paths import reset_paths_cache

            reset_paths_cache()
            reload_app_config()
            reload_extensions_config()
            models_reloaded = False
            try:
                from evoflow.config import reload_models_from_db

                reload_models_from_db()
                models_reloaded = True
            except Exception:
                pass
            return {
                "status": "ok",
                "mode": "soft",
                "models_reloaded": models_reloaded,
            }
        except Exception as exc:
            return JSONResponse(
                status_code=500,
                content={"status": "error", "mode": "soft", "error": str(exc)},
            )

    @app.get("/health/startup", tags=["health"], include_in_schema=False)
    async def startup_timeline(request: Request) -> dict:
        """Cold-start timeline for post-install diagnostics (always 200 — check ``status`` field)."""
        from app.gateway.startup_trace import get_startup_report

        report = get_startup_report()
        report["live"] = {
            "startup_phase": str(getattr(request.app.state, "startup_phase", "unknown") or "unknown"),
            "startup_ready": bool(getattr(request.app.state, "startup_ready", False)),
            "routers_registered": bool(getattr(request.app.state, "routers_registered", False)),
            "extended_routers_registered": bool(getattr(request.app.state, "extended_routers_registered", False)),
            "startup_error": getattr(request.app.state, "startup_error", None),
        }
        return report
