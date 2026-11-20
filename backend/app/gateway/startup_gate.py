"""Return structured 503 while Gateway routes / LangGraph are still starting."""

from __future__ import annotations

import logging

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse

logger = logging.getLogger(__name__)

_STARTUP_EXEMPT_PREFIXES = (
    "/health",
    "/docs",
    "/redoc",
    "/openapi.json",
)

_LANGGRAPH_PREFIX = "/api/langgraph"

# Registered in register_extended_routers (post-ready background task in packaged mode).
# NOTE: every prefix mounted by ``register_extended_routers`` MUST be listed here.
# Otherwise the middleware lets the request through while the router is not mounted
# yet and Starlette answers a bare ``{"detail": "Not Found"}`` 404 — which the panel
# surfaces as an opaque "Not Found" failure instead of the retryable 503 below.
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
    # Deferred routers added later — keep in sync with register_extended_routers.
    # NOTE: do NOT list prefixes that core routers also serve (e.g. "/api/threads"
    # is owned by core routers/threads.py and only partially extended by
    # browser_embed/browser_snapshots/browser_stream) — gating those would 503
    # working core routes during the extended-loading window.
    "/api/platform",
    "/api/config",
    "/api/stage/news",
    # 【self-evolution-bot · 2026-11-20 · 第87轮 · 模型:deepseek-v4.1-flash-1017】
    # 新增 /api/stage/right-stage/kinds（右栏契约）。它与 stage/news 同属
    # register_extended_routers 懒挂载，漏登记的话启动窗口内前端预取会拿到裸 404，
    # 契约退回内置兜底表 → 后端新增的 kind 前端看不见。测试
    # test_startup_gate_prefix_coverage 已把我这次遗漏抓出来。
    "/api/stage/right-stage",
    "/api/meetings",
    "/api/organizations",
    "/api/resource-market",
    "/api/task-detail",
    "/api/runtime",
    "/api/debug",
    "/api/diagnostics",
    "/api/trace",
    "/api/client",
    "/api/a2a",
    # A2A 的公开发现端点不在 /api 下（routers/a2a.py:77）。漏掉的话启动窗口内
    # 外部 agent 打 /.well-known/agent.json 拿到裸 404 → 判定「本机不支持 A2A」，
    # 而不是「还在启动」。现网 0 次调用（无外部 agent 常连），但判据由测试兜住。
    "/.well-known",
    # 【self-evolution-bot · 2026-11-19 · 第69轮 · 模型:deepseek-v4.1-flash-1017】
    # 以下 5 个前缀在 register_extended_routers 里懒挂载，但本名单漏了它们，
    # 于是「已 bind 端口、路由还没挂完」的那个窗口里，请求会穿透本闸门被
    # Starlette 直接回裸 404（实测耗时 0.4~1.7ms，无 response body），
    # 面板把它当「接口不存在」而不是「正在启动」。
    # 现网实证（2026-11-19，全天 404 里成簇出现在每次进程启动后 0~10 秒）：
    #   /api/browser/log            76 次（16:18:57 / 19:09:09 / 19:35:52 / 20:52:40 / 22:53:27 / 23:38:02）
    #   /api/cua/glow-status        56 次（同时刻簇）
    #   /api/plugins/*              —
    #   /api/audit/actions          —
    #   /openai/v1/*                —
    # 同一路径在窗口过后均返回 200（实测 23:38:10 起 /api/browser/log 连续 200），
    # 证明不是「前端调了不存在的端点」，而是启动竞态。
    # 判据不是「现在 curl 一下没问题」——窗口只有几秒，永远碰不上；
    # 判据是「本名单 ⊇ register_extended_routers 实际挂载的每个前缀」，
    # 由 tests/test_startup_gate_prefix_coverage.py 常驻校验。
    "/api/browser",
    "/api/cua",
    "/api/plugins",
    "/api/audit",
    # 注意：/api/v4 与 /api/threads **刻意不列**。
    #   /api/v4/*     —— core 阶段（pre-ready）已挂载，实测 89 次 404 耗时 2.4~3.0ms
    #                    且集中在 22:33（最近一次重启前 20 分钟），是 handler 内的
    #                    业务 404（session/turn row 不存在），不是裸路由 404。
    #                    列进来会对正常工作的 v4 聊天链路回 503，属于制造故障。
    #   /api/threads/* —— core threads.py 拥有，extended 只补了几条子路径；
    #                    屏蔽会 503 掉本来能用的 core 路由。
    "/openai/v1",
    "/mcp",
    "/v1",
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


def _cors_headers() -> dict[str, str]:
    try:
        from app.gateway.config import get_gateway_config

        origins = get_gateway_config().cors_origins
    except Exception:
        origins = ["http://127.0.0.1:1521", "http://localhost:1521", "http://localhost:3000"]
    return {
        "Access-Control-Allow-Origin": ", ".join(origins),
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, PATCH, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Requested-With",
        "Access-Control-Allow-Credentials": "true",
    }


def startup_not_ready_response(*, code: str, message: str, retry_after_ms: int = 500) -> JSONResponse:
    return JSONResponse(
        status_code=503,
        content={
            "error": code,
            "message": message,
            "retry_after_ms": retry_after_ms,
        },
        headers={
            "Retry-After": str(max(1, retry_after_ms // 1000)),
            **_cors_headers(),
        },
    )


class StartupGateMiddleware(BaseHTTPMiddleware):
    """Block /api traffic with 503 until routers (and LangGraph for /api/langgraph) are ready."""

    async def dispatch(self, request: Request, call_next):
        path = _path(request)
        if _is_exempt(path) or not _needs_core_routers(path):
            return await call_next(request)

        state = request.app.state
        # A mounted LangGraph child app does not carry the parent Gateway's
        # startup state. It is already behind the parent route gate, so do not
        # interpret its missing state as "Gateway is starting up".
        is_gateway_app = bool(getattr(state, "_is_evoflow_gateway_app", False))
        if not is_gateway_app:
            return await call_next(request)

        routers_registered = bool(getattr(state, "routers_registered", False))
        langgraph_mounted = getattr(state, "_lg_app", None) is not None
        if not routers_registered and not (_needs_langgraph_ready(path) and langgraph_mounted):
            logger.warning(
                "Startup gate rejected request path=%s phase=%s startup_ready=%s routers_registered=%s extended=%s lg_app=%s",
                path,
                getattr(state, "startup_phase", "unknown"),
                bool(getattr(state, "startup_ready", False)),
                routers_registered,
                bool(getattr(state, "extended_routers_registered", False)),
                langgraph_mounted,
            )
            return startup_not_ready_response(
                code="starting_up",
                message="Gateway 正在注册 API 路由，请稍后重试",
                retry_after_ms=500,
            )

        if _needs_extended_routers(path) and not bool(getattr(state, "extended_routers_registered", False)):
            # 2s (not 300ms): desktop panels poll many extended prefixes in parallel;
            # aggressive retries exhaust Windows SelectorEventLoop select() FDs (~512).
            return startup_not_ready_response(
                code="loading_extended",
                message="扩展模块仍在加载，请稍后重试",
                retry_after_ms=2000,
            )

        if _needs_langgraph_ready(path) and getattr(state, "_lg_app", None) is None:
            return startup_not_ready_response(
                code="warming_up",
                message="Agent 引擎仍在加载，请稍后重试",
                retry_after_ms=800,
            )

        return await call_next(request)
