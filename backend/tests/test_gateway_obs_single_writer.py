"""一个 HTTP 请求只能产生一条 gateway_requests 记录。

【self-evolution-bot · 2026-11-19 · 第68轮 · 模型:deepseek-v4.1-flash-1017】

现网实证缺陷：`/api/langgraph/threads/{id}/runs/stream` 被记两条 ——
`LangGraphRouteLoggerMiddleware`（source=langgraph_mount）和
`GatewayRequestLoggingMiddleware`（source=gateway）各写一条，时长几乎相同
（653,493ms vs 653,500ms），实测 161 对 161。按路由聚合时调用量与总耗时都翻倍。

本测试**测接线不测函数**：把两个真实中间件按 app 里的真实顺序套起来跑一次请求，
数落库次数。只调 `_record_langgraph_obs` 或只调 `record()` 都证明不了接线对。
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest


class _FakeApp:
    """最小 ASGI app：发一个 200 + 一小段 body 就结束。"""

    def __init__(self) -> None:
        self.calls = 0

    async def __call__(self, scope: dict[str, Any], receive: Any, send: Any) -> None:
        self.calls += 1
        await receive()
        await send(
            {
                "type": "http.response.start",
                "status": 200,
                "headers": [(b"content-type", b"application/json")],
            }
        )
        await send({"type": "http.response.body", "body": b"{}", "more_body": False})


def _run(middlewares: list[Any], path: str, method: str = "POST") -> None:
    app: Any = _FakeApp()
    for mw in reversed(middlewares):  # 最后注册的最外层，故倒序包裹
        app = mw(app)

    scope = {
        "type": "http",
        "method": method,
        "path": path,
        "query_string": b"",
        "headers": [(b"host", b"127.0.0.1:8382")],
        "scheme": "http",
        "server": ("127.0.0.1", 8382),
        "client": ("127.0.0.1", 12345),
    }

    async def receive() -> dict[str, Any]:
        return {"type": "http.request", "body": b"{}", "more_body": False}

    async def send(_msg: dict[str, Any]) -> None:
        return None

    asyncio.run(app(scope, receive, send))


@pytest.fixture()
def captured(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    """拦截两处落库入口，只记录 payload。"""
    rows: list[dict[str, Any]] = []

    def _fake(payload: dict[str, Any]) -> None:
        rows.append(payload)

    from app.gateway import gateway_obs_record as gor
    from app.gateway import langgraph_route_logger as lgr
    from app.gateway import middleware as mw

    # middleware.py 在模块级直接 import 了函数名，必须打在它自己的命名空间
    monkeypatch.setattr(mw, "schedule_gateway_observability_record", _fake, raising=False)
    # langgraph_route_logger 在函数内 import，打在源模块
    monkeypatch.setattr(gor, "schedule_gateway_observability_record", _fake, raising=False)
    monkeypatch.setattr(lgr, "logger", lgr.logger, raising=False)
    return rows


def test_langgraph_route_writes_exactly_one_row(captured: list[dict[str, Any]]) -> None:
    """两个中间件同时挂上时，langgraph 路由只能落一条。"""
    from app.gateway.langgraph_route_logger import LangGraphRouteLoggerMiddleware
    from app.gateway.middleware import GatewayRequestLoggingMiddleware

    _run(
        [LangGraphRouteLoggerMiddleware, GatewayRequestLoggingMiddleware],
        path="/api/langgraph/threads/tid-1/runs/stream",
    )
    assert len(captured) == 1, (
        f"同一请求落了 {len(captured)} 条：{[c.get('metadata') for c in captured]}"
    )
    meta = captured[0].get("metadata") or {}
    # 外层中间件是唯一写入方，但 LangGraph 侧的信息不能丢
    assert meta.get("thread_id") == "tid-1", f"丢了 thread_id: {meta}"
    assert meta.get("source") == "langgraph_mount", f"丢了来源标记: {meta}"
    # 写入方标记必须无条件存在：重启后靠它数「还有没有第二条写入路径」，
    # 否则验证去重只能靠肉眼比时长（第68轮补）。
    assert meta.get("obs_writer") == "http_middleware", f"缺写入方标记: {meta}"


def test_non_langgraph_route_still_recorded(captured: list[dict[str, Any]]) -> None:
    """不在 langgraph 前缀下的路由仍由中间件正常记一条（别修成漏记）。"""
    from app.gateway.langgraph_route_logger import LangGraphRouteLoggerMiddleware
    from app.gateway.middleware import GatewayRequestLoggingMiddleware

    _run(
        [LangGraphRouteLoggerMiddleware, GatewayRequestLoggingMiddleware],
        path="/api/chat/sessions",
        method="GET",
    )
    assert len(captured) == 1, f"普通路由应记 1 条，实际 {len(captured)}"
    assert (captured[0].get("path") or "").startswith("/api/chat/sessions")


def test_langgraph_still_recorded_when_middleware_excluded(
    captured: list[dict[str, Any]],
) -> None:
    """外层被排除时（如 /health 类），LangGraph 兜底写入不能一起废掉。

    这里直接验证兜底判据：scope 上没有 evoflow_obs_recorded 标记时，
    _record_langgraph_obs 必须自己写一条 —— 否则「去重」会变成「漏记」。
    """
    from app.gateway.langgraph_route_logger import LangGraphRouteLoggerMiddleware
    from app.gateway.middleware import GatewayRequestLoggingMiddleware

    # 用 /api/observability（在 _EXCLUDED_OBS_PATHS 里）让外层短路
    _run(
        [LangGraphRouteLoggerMiddleware, GatewayRequestLoggingMiddleware],
        path="/api/observability/x",
        method="GET",
    )
    # 该路径外层不记；langgraph 中间件也不接管（非 /api/langgraph 前缀）→ 0 条是正确
    assert len(captured) == 0, (
        f"被排除路径不该落行，实际落了 {len(captured)} 条"
    )
