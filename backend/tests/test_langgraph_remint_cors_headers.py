"""remint 手工响应必须自带 CORS 头（WebView2 Failed to fetch 防护）。

LangGraphRouteLoggerMiddleware 经 ``add_middleware`` 注册于 CORSMiddleware
之后（Starlette 后注册者在外层），因此 404 remint 的 loopback re-dispatch
手工构造的 ``http.response.start`` **绕过了 CORSMiddleware**，缺
``access-control-allow-origin`` 等头：

- curl / 桌面 Rust 代理不校验 CORS → 一切正常（2026-11-18 实锤：curl 200 正常流）
- WebView2 fetch 强制校验 CORS → 响应拒收 → ``TypeError: Failed to fetch``
  → 部门群唤醒报「服务未启动或暂时不可用」
- 且 FE 读不到 ``x-evoflow-new-thread-id``（未进 expose-headers）→ 永远用旧
  thread id → 每次 404 → remint 死循环

修复：remint 响应显式带上与网关 CORSMiddleware 同语义的 CORS 头。
"""

import pytest

from app.gateway.langgraph_route_logger import _remint_cors_headers


def _scope(origin: str | None) -> dict:
    headers = []
    if origin is not None:
        headers.append((b"origin", origin.encode("latin-1")))
    return {"headers": headers}


def _as_dict(raw: list[tuple[bytes, bytes]]) -> dict[str, str]:
    return {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in raw}


def test_allowed_dev_origin_gets_full_cors_headers() -> None:
    hdrs = _as_dict(_remint_cors_headers(_scope("http://127.0.0.1:1521")))
    assert hdrs["access-control-allow-origin"] == "http://127.0.0.1:1521"
    assert hdrs["access-control-allow-credentials"] == "true"
    # FE 必须能读到 remint 新线程 id，否则 rebind 失败 → 404 remint 死循环
    assert "x-evoflow-new-thread-id" in hdrs["access-control-expose-headers"]
    assert "x-evoflow-old-thread-id" in hdrs["access-control-expose-headers"]
    assert hdrs["vary"] == "Origin"


def test_tauri_localhost_origin_allowed() -> None:
    hdrs = _as_dict(_remint_cors_headers(_scope("https://tauri.localhost")))
    assert hdrs["access-control-allow-origin"] == "https://tauri.localhost"


def test_disallowed_origin_gets_no_cors_headers() -> None:
    assert _remint_cors_headers(_scope("http://evil.example")) == []


def test_missing_origin_gets_no_cors_headers() -> None:
    assert _remint_cors_headers(_scope(None)) == []


@pytest.mark.parametrize("origin", ["http://localhost:1521", "http://tauri.localhost"])
def test_other_whitelisted_origins_allowed(origin: str) -> None:
    hdrs = _as_dict(_remint_cors_headers(_scope(origin)))
    assert hdrs["access-control-allow-origin"] == origin
