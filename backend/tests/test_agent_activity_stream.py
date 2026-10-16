"""agent_activity_stream panel:activity fallback（proactive/后台直连 run 的进度通路）。

背景：proactive 值班任务由 execution_bridge 用 langgraph_sdk 直连 LangGraph，
不经过 gateway runs/stream 代理 —— 既没有 middle layer 也没有 ASGI 流代理，
emit_agent_activity 的两条旧通路（schedule_inject / HTTP inject-evf）全部落空，
前端 spinner 只能显示默认「生成中」。新增第三条通路：EventBroadcaster
panel:activity 广播（进程内），跨进程时走 /api/events/internal/broadcast HTTP 中继。
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from unittest.mock import patch

BACKEND_ROOT = Path(__file__).resolve().parents[1]
for p in (str(BACKEND_ROOT), str(BACKEND_ROOT / "packages" / "harness")):
    if p not in sys.path:
        sys.path.insert(0, p)

from evoflow.observability import agent_activity_stream as aas  # noqa: E402


def _reset_dedup(thread_id: str) -> None:
    aas.clear_agent_activity(thread_id)


def test_emit_panel_activity_broadcasts_via_event_broadcaster_port():
    """panel:activity 经 runtime.ports.broadcast_event 广播（进程内通路）。"""
    seen: list[tuple[str, str, dict]] = []
    captured: dict = {}

    async def fake_broadcast_event(thread_id, event_type, data):
        seen.append((thread_id, event_type, data))
        return True

    def fake_schedule(coro, *, name=""):
        captured["coro"] = coro
        captured["name"] = name

    _reset_dedup("tid-broadcast-1")
    with (
        patch.object(aas, "_try_stream_writer", return_value=False),
        patch(
            "evoflow.runtime.ports.broadcast_event", side_effect=fake_broadcast_event
        ),
        patch(
            "evoflow.subagents.detached_poll_scheduler.schedule_detached_poll",
            side_effect=fake_schedule,
        ),
    ):
        aas.emit_panel_activity("tid-broadcast-1", kind="tools", detail="执行工具 web_search…")
        assert "coro" in captured
        asyncio.run(captured["coro"])

    assert seen, "panel:activity should be broadcast via broadcaster port"
    tid, event_type, data = seen[0]
    assert tid == "tid-broadcast-1"
    assert event_type == "panel:activity"
    assert data["kind"] == "tools"
    assert data["detail"] == "执行工具 web_search…"


def test_emit_panel_activity_falls_back_to_http_relay_off_process():
    """无 broadcaster 适配器（外部 LangGraph 进程）→ HTTP /internal/broadcast 中继。"""
    http_calls: list[dict] = []
    captured: dict = {}

    async def fake_broadcast_event(thread_id, event_type, data):
        return False

    async def fake_relay(thread_id, payload):
        http_calls.append({"thread_id": thread_id, "payload": payload})

    def fake_schedule(coro, *, name=""):
        captured["coro"] = coro

    _reset_dedup("tid-relay-1")
    with (
        patch.object(aas, "_try_stream_writer", return_value=False),
        patch(
            "evoflow.runtime.ports.broadcast_event", side_effect=fake_broadcast_event
        ),
        patch.object(aas, "_relay_panel_activity_http", side_effect=fake_relay),
        patch(
            "evoflow.subagents.detached_poll_scheduler.schedule_detached_poll",
            side_effect=fake_schedule,
        ),
    ):
        aas.emit_panel_activity("tid-relay-1", kind="system", detail="任务已接受")
        asyncio.run(captured["coro"])

    assert len(http_calls) == 1
    assert http_calls[0]["thread_id"] == "tid-relay-1"
    assert http_calls[0]["payload"]["detail"] == "任务已接受"


def test_emit_agent_activity_uncovered_thread_uses_panel_broadcast():
    """无 middle layer 且无 ASGI 流代理的 thread → panel:activity 广播（而非无效 inject-evf）。"""
    captured: dict = {}
    inject_calls: list = []

    def fake_schedule(coro, *, name=""):
        captured["coro"] = coro

    _reset_dedup("tid-uncovered-1")
    with (
        patch.object(aas, "_try_stream_writer", return_value=False),
        patch(
            "evoflow.runtime.ports.middle_layer_covers_thread", return_value=False
        ),
        patch("evoflow.runtime.ports.asgi_stream_active", return_value=False),
        patch(
            "evoflow.runtime.ports.schedule_inject_evf_frame",
            side_effect=lambda tid, payload: inject_calls.append((tid, payload)),
        ),
        patch(
            "evoflow.subagents.detached_poll_scheduler.schedule_detached_poll",
            side_effect=fake_schedule,
        ),
    ):
        aas.emit_agent_activity(
            "tid-uncovered-1", kind="pre_model", detail="准备中…"
        )
        assert "coro" in captured, "should schedule panel:activity broadcast"
        coro = captured["coro"]
        assert coro is not None
        coro.close()  # 广播协程不必在测试中真正执行

    assert not inject_calls, "uncovered thread must not rely on inject-evf"


def test_emit_agent_activity_middle_layer_path_unchanged():
    """有 middle layer 覆盖的 thread → 仍走 schedule_inject_evf_frame，不发 panel:activity。"""
    captured: dict = {}
    inject_calls: list = []

    def fake_schedule(coro, *, name=""):
        captured["coro"] = coro

    _reset_dedup("tid-covered-1")
    with (
        patch.object(aas, "_try_stream_writer", return_value=False),
        patch("evoflow.runtime.ports.middle_layer_covers_thread", return_value=True),
        patch(
            "evoflow.runtime.ports.schedule_inject_evf_frame",
            side_effect=lambda tid, payload: inject_calls.append((tid, payload)),
        ),
        patch(
            "evoflow.subagents.detached_poll_scheduler.schedule_detached_poll",
            side_effect=fake_schedule,
        ),
    ):
        aas.emit_agent_activity("tid-covered-1", kind="tools", detail="执行工具 x…")

    assert len(inject_calls) == 1
    assert "coro" not in captured, "covered thread should not broadcast panel:activity"


def test_proactive_queued_detail_builder():
    """排队/收尾阶段文案：任务已接受 · 正在唤醒 {role_name}。"""
    assert (
        aas.build_proactive_phase_detail("queued", "瑜伽节拍师")
        == "任务已接受 · 正在唤醒 瑜伽节拍师…"
    )
    assert aas.build_proactive_phase_detail("finished", "瑜伽节拍师") == "本回合执行已结束"
    assert "瑜伽节拍师" in aas.build_proactive_phase_detail("queued", "瑜伽节拍师")
