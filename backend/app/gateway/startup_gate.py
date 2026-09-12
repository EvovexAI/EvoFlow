"""Return structured 503 while Gateway routes / LangGraph are still starting."""

from __future__ import annotations

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse

_STARTUP_EXEMPT_PREFIXES = (
    "/health",
    "/docs",
    "/redoc",
    "/openapi.json",
)

_LANGGRAPH_PREFIX = "/api/langgraph"

# Registered in register_extended_routers (post-ready background task in packaged mode).
_EXTENDED_ROUTE_PREFIXES = (
    "/api/knowledge",
    "/api/memory",
    "/api/mcp",
    "/api/assets",
    "/api/observability",
    "/api/eval",
    "/api/channels",
    "/api/auth",
    "/api/webui",
    "/api/tools",
    "/api/sessions",
    "/api/proactive",
    "/api/apps",
    "/api/collab",
    "/api/automation",
    "/mcp",
    "/v1/tools",
    "/v1/openapi.json",
)


def _path(request: Request) -> str:
    return str(request.url.path or "")


def _is_exempt(path: str) -> bool:
    return any(path == p or path.startswith(f"{p}/") for p in _STARTUP_EXEMPT_PREFIXES)


def _needs_core_routers(path: str) -> bool:
    return path.startswith("/api/")


def _needs_langgraph_ready(path: str) -> bool:
    return path.startswith(_LANGGRAPH_PREFIX)


def _needs_extended_routers(path: str) -> bool:
    return any(path == p or path.startswith(f"{p}/") for p in _EXTENDED_ROUTE_PREFIXES)


def startup_not_ready_response(*, code: str, message: str, retry_after_ms: int = 500) -> JSONResponse:
    return JSONResponse(
        status_code=503,
        content={
            "error": code,
            "message": message,
            "retry_after_ms": retry_after_ms,
        },
        headers={"Retry-After": str(max(1, retry_after_ms // 1000))},
    )


class StartupGateMiddleware(BaseHTTPMiddleware):
    """Block /api traffic with 503 until routers (and LangGraph for /api/langgraph) are ready."""

    async def dispatch(self, request: Request, call_next):
        path = _path(request)
        if _is_exempt(path) or not _needs_core_routers(path):
            return await call_next(request)

        state = request.app.state
        if not bool(getattr(state, "routers_registered", False)):
            return startup_not_ready_response(
                code="starting_up",
                message="Gateway 正在注册 API 路由，请稍后重试",
                retry_after_ms=500,
            )

        if _needs_extended_routers(path) and not bool(
            getattr(state, "extended_routers_registered", True)
        ):
            return startup_not_ready_response(
                code="loading_extended",
                message="扩展模块仍在加载，请稍后重试",
                retry_after_ms=300,
            )

        if _needs_langgraph_ready(path) and getattr(state, "_lg_app", None) is None:
            return startup_not_ready_response(
                code="warming_up",
                message="Agent 引擎仍在加载，请稍后重试",
                retry_after_ms=800,
            )

        return await call_next(request)
