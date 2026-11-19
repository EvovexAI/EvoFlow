"""被排除出落库的路径，仍然必须让高频洪泛可见。

【self-evolution-bot · 2026-11-19 · 第68轮 · 模型:deepseek-v4.1-flash-1017】

用户实证症状：「莫名其妙被一些没被统计到的接口频繁调用，把整个系统拖垮了」。

根因链路：
1. `_EXCLUDED_OBS_PATHS`（/api/observability、/health、/api/session-notifications…）
   在 `GatewayRequestLoggingMiddleware.__call__` 里**先 return**；
2. 而洪泛告警 `_maybe_log_request_spike` 原本只在
   `schedule_gateway_observability_record` 里调用（即已经决定要落行之后），
3. ⇒ 这些路径既不入库、也不告警，**完全不可见**。

修法：把「到达计数 + 洪泛告警」提前到排除判断之前（`note_gateway_request_arrival`）。

判据：走真实中间件跑 N 次被排除路径，告警必须触发；且**不落行**（不产生反馈环）。
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

import pytest


class _FakeApp:
    async def __call__(self, scope: dict[str, Any], receive: Any, send: Any) -> None:
        await receive()
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"{}", "more_body": False})


def _run(path: str, times: int = 1) -> None:
    from app.gateway.middleware import GatewayRequestLoggingMiddleware

    app = GatewayRequestLoggingMiddleware(_FakeApp())

    async def _go() -> None:
        for _ in range(times):
            scope = {
                "type": "http",
                "method": "GET",
                "path": path,
                "query_string": b"",
                "headers": [(b"host", b"127.0.0.1:8382")],
                "scheme": "http",
                "server": ("127.0.0.1", 8382),
                "client": ("127.0.0.1", 1),
            }

            async def receive() -> dict[str, Any]:
                return {"type": "http.request", "body": b"", "more_body": False}

            async def send(_m: dict[str, Any]) -> None:
                return None

            await app(scope, receive, send)

    asyncio.run(_go())


@pytest.fixture(autouse=True)
def _reset_spike_state(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.gateway import gateway_obs_record as gor

    gor._spike_buckets.clear()
    gor._spike_warned.clear()
    # 把阈值压低，避免测试要打 30 次
    monkeypatch.setattr(gor, "_SPIKE_WARN_THRESHOLD", 3, raising=False)


@pytest.fixture()
def rows(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    from app.gateway import gateway_obs_record as gor
    from app.gateway import middleware as mw

    captured: list[dict[str, Any]] = []
    monkeypatch.setattr(mw, "schedule_gateway_observability_record", captured.append, raising=False)
    monkeypatch.setattr(gor, "schedule_gateway_observability_record", captured.append, raising=False)
    return captured


def test_excluded_path_flood_is_warned(
    rows: list[dict[str, Any]], caplog: pytest.LogCaptureFixture
) -> None:
    """被排除路径被打爆时必须点名 —— 这是「没被统计的接口」的兜底可见性。"""
    with caplog.at_level(logging.WARNING):
        _run("/api/observability/dashboard", times=5)

    hits = [r for r in caplog.records if "gateway request spike" in str(r.message)]
    assert hits, "被排除路径刷了 5 次却没有告警，用户仍然看不到是谁在打"
    # 告警里必须带 inflight，否则分不清「它自己刷」还是「它把别人堵死」
    assert "inflight=" in hits[0].getMessage(), f"告警缺少 inflight: {hits[0].getMessage()}"


def test_excluded_path_still_not_persisted(rows: list[dict[str, Any]]) -> None:
    """可见 ≠ 落行：被排除路径绝不能入库，否则 /api/observability 自查询造成反馈环。"""
    _run("/api/observability/dashboard", times=5)
    assert rows == [], f"被排除路径竟然落库了：{rows[:2]}"


def test_normal_path_counted_once_and_persisted(rows: list[dict[str, Any]]) -> None:
    """反向：普通路径要正常记 1 条（别为了排除路径把正常统计改坏）。"""
    _run("/api/chat/sessions", times=1)
    assert len(rows) == 1, f"普通路径应落 1 条，实际 {len(rows)}"


def test_health_flood_also_visible(rows: list[dict[str, Any]], caplog: pytest.LogCaptureFixture) -> None:
    """/health 同样在排除表里；探活被重复调度时也必须看得见。"""
    with caplog.at_level(logging.WARNING):
        _run("/health", times=5)
    hits = [r for r in caplog.records if "gateway request spike" in str(r.message)]
    assert hits, "/health 高频调用没有告警"


def test_spike_bucket_dict_is_bounded(monkeypatch: pytest.MonkeyPatch) -> None:
    """告警字典必须有上限 —— 现在每个到达请求都进这里。

    【self-evolution-bot · 2026-11-19 · 第68轮】
    若某客户端用带随机 id 的 URL 刷，键会无界增长，光内存就能把进程吃掉，
    正好是用户报的「被频繁调用拖垮」。这条钉住封顶逻辑真的接线了。
    """
    from app.gateway import gateway_obs_record as gor

    monkeypatch.setattr(gor, "_SPIKE_MAX_KEYS", 20, raising=False)
    for i in range(200):
        gor.note_gateway_request_arrival(method="GET", path=f"/api/rogue/{i}")

    assert len(gor._spike_buckets) <= 20, (
        f"告警字典无界增长：{len(gor._spike_buckets)} 个键（上限 20）"
    )
