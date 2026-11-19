"""「同一个接口一直错 / 一直慢」必须被点名，而不只是「调用频率高」。

【self-evolution-bot · 2026-11-19 · 第69轮 · 模型:deepseek-v4.1-flash-1017】

现网实证（2026-11-19，gateway access log）：
    5,685 次 `GET /api/chat/sessions/c57b6608-…/execution/state` → 全部 404，
    时间跨度 01:29:28 → 06:22:06（**4 小时 53 分**），速率 ~19 次/分钟。

为什么现有两层都没抓到：
- `_maybe_log_request_spike` 阈值 30 次/60s → 19 次/分钟**永远够不着**；
- 慢日志只看单次 ≥1s → 404 本身 6ms，**不慢**。

⇒ 必须有第三个信号：按**占比**判「一直错（失败率≥50%）」与「一直慢（≥5 次 3s+）」。
"""

from __future__ import annotations

import logging

import pytest


@pytest.fixture(autouse=True)
def _clean(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.gateway import gateway_obs_record as gor

    gor._outcome_buckets.clear()
    gor._outcome_warned.clear()
    monkeypatch.setattr(gor, "_OUTCOME_MIN_CALLS", 10, raising=False)


def _hit(path: str, *, status: int = 200, ms: float = 5.0, times: int = 1) -> None:
    from app.gateway import gateway_obs_record as gor

    for _ in range(times):
        gor.note_gateway_outcome(
            method="GET", path=path, status_code=status, duration_ms=ms
        )


def _warns(caplog: pytest.LogCaptureFixture) -> list[str]:
    return [r.getMessage() for r in caplog.records if "route degraded" in r.getMessage()]


def test_stale_session_404_storm_is_reported(caplog: pytest.LogCaptureFixture) -> None:
    """场景复现：同一会话 key 被反复轮询且一直 404（速率远低于 spike 阈值）。"""
    with caplog.at_level(logging.WARNING):
        _hit("/api/chat/sessions/c57b6608-looks-dead/execution/state", status=404, times=20)

    hits = _warns(caplog)
    assert hits, "20 次连续 404 没有告警 —— 这就是 4 小时 53 分死轮询漏报的原因"
    msg = hits[0]
    assert "errors=" in msg and "100%" in msg, f"告警未给出失败率: {msg}"
    assert "a stale client keeps retrying" in msg, f"告警没指路: {msg}"
    # 归一化会把 UUID 折成 {id}，光看 key 指不出「哪个死会话」；
    # 必须带原始 path 样本，否则照样得回去 grep 日志。
    assert "sample=/api/chat/sessions/c57b6608" in msg, f"告警没给出原始 path: {msg}"


def test_healthy_route_is_silent(caplog: pytest.LogCaptureFixture) -> None:
    """反向：200 且快的路由绝不能被误报（否则告警一响就被无视）。"""
    with caplog.at_level(logging.WARNING):
        _hit("/api/chat/sessions", status=200, ms=5.0, times=30)
    assert not _warns(caplog), f"健康路由被误报: {caplog.records}"


def test_repeated_slow_calls_are_reported(caplog: pytest.LogCaptureFixture) -> None:
    """一直慢：单次未超慢日志阈值也可能慢，5 次 3s+ 必须点名。"""
    with caplog.at_level(logging.WARNING):
        _hit("/api/browser/execute", status=200, ms=16_000.0, times=6)
    hits = _warns(caplog)
    assert hits, "同一 POST 已 6 次 16 秒，没有任何告警"
    assert "[slow]" in hits[0], f"应标为慢而非错: {hits[0]}"


def test_low_sample_is_not_reported(caplog: pytest.LogCaptureFixture) -> None:
    """样本太少不下结论：偶发 2 次失败不该报警。"""
    with caplog.at_level(logging.WARNING):
        _hit("/api/assets/tree", status=500, times=2)
    assert not _warns(caplog), "2 次失败就报警 = 噪音，等于没告警"


def test_warned_once_per_window(caplog: pytest.LogCaptureFixture) -> None:
    """同一路由同一窗口只报一次，否则告警自己把日志刷爆。"""
    with caplog.at_level(logging.WARNING):
        _hit("/api/goal/settings", status=404, times=40)
    assert len(_warns(caplog)) == 1, f"同窗口重复告警 {len(_warns(caplog))} 次"


def test_buckets_are_bounded(monkeypatch: pytest.MonkeyPatch) -> None:
    """随机 path 刷不出内存泄漏（与 spike 字典同一类风险）。"""
    from app.gateway import gateway_obs_record as gor

    monkeypatch.setattr(gor, "_OUTCOME_MAX_KEYS", 20, raising=False)
    for i in range(200):
        gor.note_gateway_outcome(
            method="GET", path=f"/api/rogue/{i}", status_code=200, duration_ms=1.0
        )
    assert len(gor._outcome_buckets) <= 20, f"字典无界: {len(gor._outcome_buckets)}"


def test_middleware_actually_wires_it(monkeypatch: pytest.MonkeyPatch) -> None:
    """接线测试：中间件跑真实请求时必须调用检测器（只测函数等于没测接线）。"""
    import asyncio
    from typing import Any

    from app.gateway import gateway_obs_record as gor
    from app.gateway import middleware as mw

    calls: list[tuple[int | None, float]] = []

    monkeypatch.setattr(
        gor,
        "note_gateway_outcome",
        lambda **kw: calls.append((kw.get("status_code"), kw.get("duration_ms"))),
        raising=False,
    )

    class _App:
        async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
            await receive()
            await send(
                {
                    "type": "http.response.start",
                    "status": 404,
                    "headers": [(b"content-type", b"application/json")],
                }
            )
            await send({"type": "http.response.body", "body": b"{}", "more_body": False})

    monkeypatch.setattr(mw, "schedule_gateway_observability_record", lambda _p: None, raising=False)
    app = mw.GatewayRequestLoggingMiddleware(_App())
    scope = {
        "type": "http",
        "method": "GET",
        "path": "/api/chat/sessions/dead-key/execution/state",
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

    asyncio.run(app(scope, receive, send))
    assert calls, "中间件没有调用 note_gateway_outcome —— 检测器是死代码"
    assert calls[0][0] == 404, f"状态码没透传: {calls[0]}"


# ---------------------------------------------------------------------------
# 【self-evolution-bot · 2026-11-19 · 第69轮 · 模型:deepseek-v4.1-flash-1017】
# 现网实证的误报：panel-stream 是 text/event-stream SSE 长连接，
# 平均挂 13.8s、最长 562s、错误率 0%。检测器把它当「持续慢」，
# 今天下午 16:46~17:25 每 5 分钟误报一次，共 8 条。
# 判据：按响应 content-type 排除事件流，不靠路径猜。
# ---------------------------------------------------------------------------


def test_event_stream_is_not_reported_as_slow(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.gateway import gateway_obs_record as g

    monkeypatch.setattr(g, "_outcome_buckets", {}, raising=False)
    monkeypatch.setattr(g, "_outcome_warned", {}, raising=False)
    warned: list[str] = []
    monkeypatch.setattr(
        g, "logger", type("_L", (), {"warning": staticmethod(lambda fmt, *a: warned.append(fmt % a))})()
    )

    # 20 次都是 60 秒的 SSE 连接 —— 真实场景就是这样
    for _ in range(20):
        g.note_gateway_outcome(
            method="GET",
            path="/api/events/threads/abc/panel-stream",
            status_code=200,
            duration_ms=60_000.0,
            response_content_type="text/event-stream; charset=utf-8",
        )
    assert warned == [], f"SSE 长连接被误报成持续慢: {warned}"
    # 且不应留下桶（否则换个 content-type 的请求会继承旧计数）
    assert not any("panel-stream" in str(k) for k in g._outcome_buckets), "SSE 仍被计入桶"


def test_plain_slow_route_still_reported(monkeypatch: pytest.MonkeyPatch) -> None:
    """排除 SSE 不能把普通慢接口一起放过 —— 这是修复误报时的最大风险。"""
    from app.gateway import gateway_obs_record as g

    monkeypatch.setattr(g, "_outcome_buckets", {}, raising=False)
    monkeypatch.setattr(g, "_outcome_warned", {}, raising=False)
    warned: list[str] = []
    monkeypatch.setattr(
        g, "logger", type("_L", (), {"warning": staticmethod(lambda fmt, *a: warned.append(fmt % a))})()
    )

    for _ in range(6):
        g.note_gateway_outcome(
            method="GET",
            path="/api/goal/settings-by-key/x",
            status_code=200,
            duration_ms=16_000.0,
            response_content_type="application/json",
        )
    assert len(warned) == 1, f"普通慢接口没被报出来: {warned}"
    assert "slow" in warned[0]
