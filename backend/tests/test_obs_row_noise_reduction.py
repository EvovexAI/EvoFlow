"""观测表体积噪音：CORS 预检与 headers 两列默认不落库。

【self-evolution-bot · 2026-11-19 · 第69轮 · 模型:deepseek-v4.1-flash-1017】

现网实证（2026-11-19 13:41 复算，245,000+ 行）：
- `OPTIONS` 预检 **52,969 行 = 21.3% ≈ 54MB**，全是 CORS 噪音，一天 5 万条；
- `request_headers_json` + `response_headers_json` = **193MB ≈ 表的 79%**，
  且经 512 字节截断后抽样 5,000 行里 **4,600 行（92%）是非法 JSON**，
  面板 `parseMaybeJsonField` 必然解析失败 —— 既占体积又读不出内容。

判据：默认不落、开关打开照旧落、且**到达计数不受影响**（洪泛仍可见）。
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest


class _FakeApp:
    def __init__(self, status: int = 200) -> None:
        self.status = status

    async def __call__(self, scope: dict[str, Any], receive: Any, send: Any) -> None:
        await receive()
        await send(
            {
                "type": "http.response.start",
                "status": self.status,
                "headers": [(b"content-type", b"application/json")],
            }
        )
        await send({"type": "http.response.body", "body": b"{}", "more_body": False})


def _run(path: str, method: str = "GET") -> None:
    from app.gateway.middleware import GatewayRequestLoggingMiddleware

    app = GatewayRequestLoggingMiddleware(_FakeApp())
    scope = {
        "type": "http",
        "method": method,
        "path": path,
        "query_string": b"",
        "headers": [
            (b"host", b"127.0.0.1:8382"),
            (b"user-agent", b"pytest-agent"),
            (b"authorization", b"Bearer secret-should-be-dropped"),
        ],
        "scheme": "http",
        "server": ("127.0.0.1", 8382),
        "client": ("127.0.0.1", 1),
    }

    async def receive() -> dict[str, Any]:
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(_m: dict[str, Any]) -> None:
        return None

    asyncio.run(app(scope, receive, send))


@pytest.fixture()
def rows(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    from app.gateway import middleware as mw

    captured: list[dict[str, Any]] = []
    monkeypatch.setattr(mw, "schedule_gateway_observability_record", captured.append, raising=False)
    return captured


@pytest.fixture()
def arrivals(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, str]]:
    """记录到达计数调用 —— 证明「不落行」不等于「不可见」。"""
    from app.gateway import gateway_obs_record as gor

    seen: list[tuple[str, str]] = []
    monkeypatch.setattr(
        gor,
        "note_gateway_request_arrival",
        lambda *, method, path: seen.append((method, path)),
        raising=False,
    )
    return seen


def test_options_not_persisted_by_default(
    rows: list[dict[str, Any]], arrivals: list[tuple[str, str]]
) -> None:
    """CORS 预检默认不落库 —— 省掉 21.3% 的行。"""
    _run("/api/v4/conversation/rows_range", method="OPTIONS")
    assert rows == [], f"OPTIONS 仍然落库: {rows[:1]}"


def test_options_still_counted_for_flood(
    rows: list[dict[str, Any]], arrivals: list[tuple[str, str]]
) -> None:
    """但到达计数必须照常 —— 否则「预检被刷爆」又变成盲区。"""
    _run("/api/v4/conversation/rows_range", method="OPTIONS")
    assert arrivals, "OPTIONS 没有进到达计数，等于把可见性又挖掉了"


def test_options_persisted_when_enabled(
    rows: list[dict[str, Any]], monkeypatch: pytest.MonkeyPatch
) -> None:
    """开关打开时必须恢复落库（排查 CORS 问题要用）。"""
    monkeypatch.setenv("EVOFLOW_OBS_LOG_OPTIONS", "1")
    _run("/api/v4/conversation/rows_range", method="OPTIONS")
    assert len(rows) == 1, f"开关打开却没落库: {len(rows)}"


def test_get_still_persisted(rows: list[dict[str, Any]]) -> None:
    """反向：普通 GET 一条都不能少。"""
    _run("/api/chat/sessions")
    assert len(rows) == 1, f"普通 GET 漏记: {len(rows)}"


def test_headers_dropped_by_default(rows: list[dict[str, Any]]) -> None:
    """headers 默认不落：193MB 里 92% 是截断后的非法 JSON，存了也读不出。"""
    _run("/api/chat/sessions")
    assert len(rows) == 1
    assert rows[0]["request_headers"] is None, "request_headers 仍然落库"
    assert rows[0]["response_headers"] is None, "response_headers 仍然落库"


def test_headers_persisted_when_enabled(
    rows: list[dict[str, Any]], monkeypatch: pytest.MonkeyPatch
) -> None:
    """开关打开时照旧落库（要排查具体请求头时用）。"""
    monkeypatch.setenv("EVOFLOW_OBS_LOG_HEADERS", "1")
    _run("/api/chat/sessions")
    assert len(rows) == 1
    assert rows[0]["request_headers"] is not None, "开关打开却丢了 headers"


def test_duration_still_reported(rows: list[dict[str, Any]]) -> None:
    """削体积不能削掉耗时数字 —— 否则等于把观测本身废了。"""
    _run("/api/chat/sessions")
    assert isinstance(rows[0]["duration_ms"], float), f"duration 丢了: {rows[0].get('duration_ms')}"
    assert rows[0]["status_code"] == 200
