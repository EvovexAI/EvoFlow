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
    async def liveness_check() -> dict:
        return {"status": "alive", "service": "evo-flow-gateway"}

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
        ready = bool(getattr(request.app.state, "startup_ready", False))
        phase = str(getattr(request.app.state, "startup_phase", "unknown") or "unknown")
        if ready:
            return {"status": "ready", "service": "evo-flow-gateway", "phase": phase}
        err = getattr(request.app.state, "startup_error", None)
        body: dict = {
            "status": "not_ready",
            "service": "evo-flow-gateway",
            "phase": phase,
        }
        if err:
            body["error"] = str(err)
        return JSONResponse(status_code=503, content=body)

    @app.get("/health/proc", tags=["health"])
    def proc_liveness_check() -> dict:
        return {"status": "alive", "service": "evo-flow-gateway", "pid": os.getpid()}

    @app.get("/health/startup", tags=["health"], include_in_schema=False)
    async def startup_timeline(request: Request) -> dict:
        """Cold-start timeline for post-install diagnostics (always 200 — check ``status`` field)."""
        from app.gateway.startup_trace import get_startup_report

        report = get_startup_report()
        report["live"] = {
            "startup_phase": str(getattr(request.app.state, "startup_phase", "unknown") or "unknown"),
            "startup_ready": bool(getattr(request.app.state, "startup_ready", False)),
            "routers_registered": bool(getattr(request.app.state, "routers_registered", False)),
            "startup_error": getattr(request.app.state, "startup_error", None),
        }
        return report
