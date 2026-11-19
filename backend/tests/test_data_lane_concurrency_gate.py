"""DATA 车道并发闸：必须先证明「接上了」，再证明「不放大故障」。

【self-evolution-bot · 2026-11-19 · 第69轮 · 模型:deepseek-v4.1-flash-1017】

修的是一个**设计从未生效**的缺陷：`data_lane_slot()` 全仓零调用点，
而 `classify_path` 把所有未知 `/api/*` 默认落 DATA ⇒ 新接口既无并发上限
也无卸载，这是「莫名被调用把系统拖垮」的结构成因。

三条判据必须同时成立，缺一条都算没修好：
1. **接线**：中间件跑真实请求时必须真的进入闸门（只测函数＝没测接线）。
2. **有界**：槽位满了只能有界等待，**超时后放行**，绝不 503。
   前端 `gatewayProxyWithRetry` 对 503 会退避重试 3 次 ——
   对一个正在洪泛的路由卸载，等于把请求量放大 3 倍。
3. **不泄漏**：异常/取消路径必须归还槽位，否则闸门会永久缺额直到重启。
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest


@pytest.fixture(autouse=True)
def _reset(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.gateway import traffic_lanes as tl

    monkeypatch.setattr(tl, "_data_inflight", 0, raising=False)
    monkeypatch.setattr(tl, "_data_overflow", 0, raising=False)
    yield


def test_limit_is_bounded_and_configurable(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.gateway import traffic_lanes as tl

    monkeypatch.delenv("EVOFLOW_LANE_DATA_CONCURRENCY", raising=False)
    assert tl.data_lane_limit() == 6
    monkeypatch.setenv("EVOFLOW_LANE_DATA_CONCURRENCY", "12")
    assert tl.data_lane_limit() == 12
    # 防止误配成 0/负数导致闸门形同不存在或被当成「一律拒绝」
    monkeypatch.setenv("EVOFLOW_LANE_DATA_CONCURRENCY", "0")
    assert tl.data_lane_limit() >= 1


def test_enter_and_exit_balance() -> None:
    from app.gateway import traffic_lanes as tl

    async def run() -> None:
        for _ in range(tl.data_lane_limit()):
            assert await tl.enter_data_lane() is True
        assert tl.data_lane_snapshot()["inflight"] == tl.data_lane_limit()
        for _ in range(tl.data_lane_limit()):
            tl.exit_data_lane()
        assert tl.data_lane_snapshot()["inflight"] == 0

    asyncio.run(run())


def test_overflow_releases_instead_of_rejecting(monkeypatch: pytest.MonkeyPatch) -> None:
    """满了以后必须是「放行 + 记数」，不是拒绝。这是刻意选的语义。"""
    from app.gateway import traffic_lanes as tl

    monkeypatch.setenv("EVOFLOW_LANE_DATA_WAIT_MS", "30")

    async def run() -> None:
        for _ in range(tl.data_lane_limit()):
            await tl.enter_data_lane()
        held = await tl.enter_data_lane()
        assert held is False, "槽位已满却报告占到槽"
        snap = tl.data_lane_snapshot()
        assert snap["overflow"] == 1, f"溢出未计数: {snap}"
        assert snap["inflight"] == tl.data_lane_limit(), "溢出路径不得错改占用数"

    asyncio.run(run())


def test_waiter_gets_slot_when_released(monkeypatch: pytest.MonkeyPatch) -> None:
    """有界等待必须真的能等到，否则上限一满就永久走溢出分支。"""
    from app.gateway import traffic_lanes as tl

    monkeypatch.setenv("EVOFLOW_LANE_DATA_WAIT_MS", "800")

    async def run() -> None:
        for _ in range(tl.data_lane_limit()):
            await tl.enter_data_lane()

        async def release_soon() -> None:
            await asyncio.sleep(0.05)
            tl.exit_data_lane()

        asyncio.ensure_future(release_soon())
        held = await tl.enter_data_lane()
        assert held is True, "有人释放了槽，等待方却没拿到"
        tl.exit_data_lane()

    asyncio.run(run())


def test_wait_budget_is_capped(monkeypatch: pytest.MonkeyPatch) -> None:
    """预算是上限的从属参数，必须封顶，不能被环境变量调成无限排队。"""
    from app.gateway import traffic_lanes as tl

    monkeypatch.setenv("EVOFLOW_LANE_DATA_WAIT_MS", "999999")
    assert tl.data_lane_wait_s() <= 10.0
    monkeypatch.setenv("EVOFLOW_LANE_DATA_WAIT_MS", "-5")
    assert tl.data_lane_wait_s() >= 0.0


def _middleware(status: int = 200):
    from app.gateway.middleware import TrafficLaneMiddleware

    class _App:
        async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
            await send(
                {"type": "http.response.start", "status": status, "headers": []}
            )
            await send({"type": "http.response.body", "body": b"{}", "more_body": False})

    return TrafficLaneMiddleware(_App())


def _scope(path: str, method: str = "GET") -> dict[str, Any]:
    return {
        "type": "http",
        "method": method,
        "path": path,
        "query_string": b"",
        "headers": [(b"host", b"127.0.0.1:8382")],
        "scheme": "http",
        "server": ("127.0.0.1", 8382),
        "client": ("127.0.0.1", 1),
    }


def _run(mw, scope: dict[str, Any]) -> None:
    async def receive() -> dict[str, Any]:
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(_m: dict[str, Any]) -> None:
        return None

    asyncio.run(mw(scope, receive, send))


def test_middleware_actually_enters_the_gate(monkeypatch: pytest.MonkeyPatch) -> None:
    """接线测试：未知 /api/* 走真实中间件时，闸门必须真的被进入并归还。"""
    from app.gateway import traffic_lanes as tl

    seen: list[str] = []
    real_enter = tl.enter_data_lane
    real_exit = tl.exit_data_lane

    async def spy_enter() -> bool:
        seen.append("enter")
        return await real_enter()

    def spy_exit() -> None:
        seen.append("exit")
        real_exit()

    monkeypatch.setattr(tl, "enter_data_lane", spy_enter, raising=False)
    monkeypatch.setattr(tl, "exit_data_lane", spy_exit, raising=False)

    _run(_middleware(), _scope("/api/rogue/unknown-endpoint"))
    assert seen == ["enter", "exit"], f"闸门没接上或没归还: {seen}"
    assert tl.data_lane_snapshot()["inflight"] == 0, "槽位泄漏"


def test_stream_paths_bypass_data_gate(monkeypatch: pytest.MonkeyPatch) -> None:
    """流式长连接的槽位会被占几十分钟，绝不能用 DATA 的并发预算去卡它。"""
    from app.gateway import traffic_lanes as tl

    seen: list[str] = []
    monkeypatch.setattr(
        tl, "enter_data_lane", lambda: seen.append("enter"), raising=False
    )
    _run(_middleware(), _scope("/api/langgraph/threads/x/runs/stream"))
    assert seen == [], "流式请求进了 DATA 闸门"


def test_control_paths_bypass_data_gate(monkeypatch: pytest.MonkeyPatch) -> None:
    """/health、chat 发送属于 Control，不得被 DATA 的并发上限拖住。"""
    from app.gateway import traffic_lanes as tl

    seen: list[str] = []
    monkeypatch.setattr(
        tl, "enter_data_lane", lambda: seen.append("enter"), raising=False
    )
    _run(_middleware(), _scope("/health"))
    _run(_middleware(), _scope("/api/chat/sessions/abc/messages", method="POST"))
    assert seen == [], "Control 请求进了 DATA 闸门"


def test_slot_released_when_app_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    """下游抛异常也必须归还槽位，否则闸门缺额到重启才恢复。"""
    from app.gateway import traffic_lanes as tl
    from app.gateway.middleware import TrafficLaneMiddleware

    class _Boom:
        async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
            raise RuntimeError("downstream exploded")

    mw = TrafficLaneMiddleware(_Boom())
    with pytest.raises(RuntimeError):
        _run(mw, _scope("/api/rogue/boom"))
    assert tl.data_lane_snapshot()["inflight"] == 0, "异常路径泄漏了槽位"


# ---------------------------------------------------------------------------
# 【self-evolution-bot · 2026-11-19 · 第69轮 · 模型:deepseek-v4.1-flash-1017】
# 出口测试：`_data_overflow` 只存在进程内存里 = 没人能验收上限有没有真在削峰。
# 本岗反复踩「加了检测器不接出口」，所以闸门计数必须能在两处被读到：
#   ① gateway 日志 `[lane-clamp]`（节流告警）
#   ② `/api/debug/hang-diagnostics/traffic-lanes`（实时读数）+ hang dump
# ---------------------------------------------------------------------------


def test_overflow_emits_throttled_warning(monkeypatch: pytest.MonkeyPatch) -> None:
    """溢出必须留下可 grep 的日志，但一个洪泛时段不能刷爆日志（60s 节流）。"""
    from app.gateway import traffic_lanes as tl

    monkeypatch.setenv("EVOFLOW_LANE_DATA_WAIT_MS", "0")
    monkeypatch.setattr(tl, "_data_overflow_last_warn", 0.0, raising=False)

    seen: list[str] = []
    monkeypatch.setattr(
        tl, "logger", type("_L", (), {"warning": staticmethod(lambda fmt, *a: seen.append(fmt % a))})()
    )

    async def run() -> None:
        for _ in range(tl.data_lane_limit()):
            await tl.enter_data_lane()
        for _ in range(5):  # 连续 5 次溢出
            assert await tl.enter_data_lane() is False

    asyncio.run(run())
    assert len(seen) == 1, f"60s 节流失效，刷了 {len(seen)} 条"
    assert "[lane-clamp]" in seen[0]
    assert "NOT rejected" in seen[0], "告警必须写明「放行未拒绝」，否则看日志的人会误判"


def test_snapshot_is_readable_from_diagnostics_endpoint(monkeypatch: pytest.MonkeyPatch) -> None:
    """实时读数端点必须真的返回闸门状态（这是「上限在不在工作」的唯一验收口）。"""
    from app.gateway import traffic_lanes as tl
    from app.gateway.routers.hang_diagnostics import traffic_lane_snapshot

    monkeypatch.setenv("EVOFLOW_LANE_DATA_CONCURRENCY", "6")
    async def run() -> dict[str, Any]:
        for _ in range(6):
            await tl.enter_data_lane()
        tl._data_overflow = 3
        return await traffic_lane_snapshot()

    data = asyncio.run(run())
    assert data["ok"] is True
    assert data["inflight"] == 6
    assert data["limit"] == 6
    assert data["overflow"] == 3
    assert data["wait_ms"] > 0


def test_hang_dump_includes_traffic_lanes(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    """hang dump 的**落盘 JSON** 里必须有闸门计数。

    只测 `_traffic_lane_snapshot()` 这个 helper 是空转 —— helper 存在与否
    和它有没有被接进 payload 是两件事（本岗反复踩的「测函数不测接线」）。
    所以这里真跑一次 dump 并读回文件。
    """
    from pathlib import Path

    from app.gateway import hang_diagnostics as hd

    monkeypatch.setenv("EVOFLOW_GATEWAY_HANG_DIAGNOSTICS", "1")
    monkeypatch.setattr(hd, "_diagnostics_dir", lambda: Path(tmp_path), raising=False)
    monkeypatch.setattr(hd, "_last_dump_at", 0.0, raising=False)
    monkeypatch.setenv("EVOFLOW_GATEWAY_HANG_DUMP_MIN_INTERVAL_SECONDS", "1")

    path = hd.dump_gateway_diagnostics(reason="pytest")
    assert path is not None, "dump 没产出文件，测试无法验收"
    payload = json.loads(path.read_text(encoding="utf-8"))
    assert "traffic_lanes" in payload, f"dump JSON 缺 traffic_lanes 键: {sorted(payload)}"
    assert set(payload["traffic_lanes"]) == {"inflight", "limit", "overflow"}


def test_actual_concurrency_is_capped_end_to_end(monkeypatch: pytest.MonkeyPatch) -> None:
    """数字判据：穿过真实中间件的并发峰值必须被压在上限内。

    前面的测试只证明「进来了/归还了」，证明不了「限住了」。
    这里放 40 个并发请求（远超上限 6），采样每个请求进入下游时的
    真实并发数，峰值不得超过 limit。顺便验证溢出不是拒绝。
    """
    from app.gateway import traffic_lanes as tl
    from app.gateway.middleware import TrafficLaneMiddleware

    monkeypatch.setenv("EVOFLOW_LANE_DATA_CONCURRENCY", "3")
    monkeypatch.setenv("EVOFLOW_LANE_DATA_WAIT_MS", "200")
    monkeypatch.setattr(tl, "_data_inflight", 0, raising=False)
    monkeypatch.setattr(tl, "_data_overflow", 0, raising=False)

    # 下游**独立**计数：绝不能用闸门自己的 snapshot 来证明闸门在工作
    # （闸门拆掉时 inflight 恒为 0，判据会自动通过 —— 那是测自己）。
    live = 0
    peak = 0
    observed: list[int] = []

    class _Slow:
        async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
            nonlocal live, peak
            live += 1
            peak = max(peak, live)
            observed.append(live)
            try:
                await asyncio.sleep(0.01)
            finally:
                live -= 1
            await send({"type": "http.response.start", "status": 200, "headers": []})
            await send({"type": "http.response.body", "body": b"{}", "more_body": False})

    mw = TrafficLaneMiddleware(_Slow())

    async def receive() -> dict[str, Any]:
        return {"type": "http.request", "body": b"", "more_body": False}

    sent: list[int] = []

    async def send(_m: dict[str, Any]) -> None:
        if _m.get("type") == "http.response.start":
            sent.append(int(_m["status"]))

    async def run() -> None:
        await asyncio.gather(
            *(mw(_scope(f"/api/rogue/endpoint-{i}"), receive, send) for i in range(40))
        )

    asyncio.run(run())

    assert peak <= 3, f"下游观测到的并发峰值 {peak} 超过上限 3"
    assert len(observed) == 40, f"有请求没被放行: {len(observed)}/40"
    assert all(s == 200 for s in sent), "闸门不得拒绝请求（503 会触发前端重试放大）"
    snap = tl.data_lane_snapshot()
    assert snap["inflight"] == 0, f"槽位泄漏: {snap}"
    print(f"\n[gate] downstream_peak={peak} limit=3 overflow={snap['overflow']} passed=40/40")


# ---------------------------------------------------------------------------
# 双层闸门串联：自带专属槽的路径必须豁免通用 DATA 闸
# 【self-evolution-bot · 2026-11-19 · 第69轮 · 模型:deepseek-v4.1-flash-1017】
# `GET /api/chat/sessions` 落在 DATA 车道，但 handler 里已经有
# `sessions_list_slot`（上限 2，抢不到就等 3s 再 503）。若外面再套 DATA 闸，
# 同一条慢列表请求会在两个闸之间**同时**占位 —— 一条路径即可堵死整条 DATA 车道。
# 判据做成显式字段 own_slot_gate，不做成 reason 字符串里的暗示。
# ---------------------------------------------------------------------------


def test_own_slot_path_is_exempt_from_generic_data_gate() -> None:
    from app.gateway.traffic_lanes import classify_path

    d = classify_path("/api/chat/sessions", method="GET")
    assert d.lane.value == "data", "仍需留在 DATA 车道（它不是 Control）"
    assert d.own_slot_gate is True, "自带专属槽的路径必须置位 own_slot_gate"

    # 反向：其它 DATA 路径不得被顺手豁免，否则闸门等于没接
    assert classify_path("/api/rogue/unknown", method="GET").own_slot_gate is False


def test_middleware_skips_gate_for_own_slot_path(monkeypatch: pytest.MonkeyPatch) -> None:
    """接线判据：中间件必须真的读 own_slot_gate，而不是靠 reason 文字。"""
    from app.gateway import traffic_lanes as tl

    seen: list[str] = []
    real_enter = tl.enter_data_lane

    # 必须是 async spy：第二个断言会真正进闸并 await 它。
    async def spy_enter() -> bool:
        seen.append("enter")
        return await real_enter()

    monkeypatch.setattr(tl, "enter_data_lane", spy_enter, raising=False)

    _run(_middleware(), _scope("/api/chat/sessions"))
    assert seen == [], "自带专属槽的路径仍被通用 DATA 闸拦截（两层串联）"

    # 同一个中间件，普通 DATA 路径必须进闸 —— 证明豁免不是把闸整体关掉
    _run(_middleware(), _scope("/api/rogue/unknown"))
    assert seen == ["enter"], f"普通 DATA 路径没进闸: {seen}"
