"""live_run_snapshot 调度侧节流 + 单飞。

2026-11-15 01:10 hang dump：schedule_snapshot_from_normalizer 每 SSE 帧调一次，
原实现每帧先全量构建 payload（长回复 O(N²)）再 spawn to_thread、进去才撞 3s
节流门；VACUUM 锁库期间十几个 worker 全堵在 live_run 读写上。现在节流门与
单飞都在 loop 调度侧，被挡的帧零成本。
"""

from __future__ import annotations

import asyncio
import time

import pytest

import app.gateway.streaming.live_run_snapshot as lrs


@pytest.fixture()
def clean_state(monkeypatch: pytest.MonkeyPatch):
    lrs._last_flush_ms.clear()
    lrs._session_key_cache.clear()
    lrs._inflight_threads.clear()
    calls: dict[str, list] = {"payload": [], "upsert": []}

    monkeypatch.setattr(
        lrs,
        "snapshot_from_normalizer_payload",
        lambda tid, normalizer: calls["payload"].append(tid)
        or {
            "thread_id": tid,
            "partial_text": "hello",
            "partial_tools": [],
            "partial_display_segments": [],
        },
    )

    def _fake_upsert(tid, **kwargs):
        calls["upsert"].append((tid, kwargs.get("force", False)))

    monkeypatch.setattr(lrs, "maybe_upsert_gateway_live_snapshot", _fake_upsert)
    yield calls
    lrs._last_flush_ms.clear()
    lrs._session_key_cache.clear()
    lrs._inflight_threads.clear()


def test_gate_at_schedule_time_skips_payload_build(clean_state, monkeypatch: pytest.MonkeyPatch) -> None:
    """节流窗口内重复帧：payload 不构建、任务不 spawn、upsert 不发生。"""
    tid = "thread-gate"
    lrs._last_flush_ms[tid] = (time.time() * 1000) - 500  # 3s 窗口内

    async def main() -> None:
        lrs.schedule_snapshot_from_normalizer(tid, object())
        await asyncio.sleep(0.02)

    asyncio.run(main())
    assert clean_state["payload"] == []
    assert clean_state["upsert"] == []


def test_single_flight_skips_while_inflight(clean_state) -> None:
    """同一线程已有写入在途：后续帧不构建 payload、不 spawn。"""
    tid = "thread-single"
    lrs._inflight_threads.add(tid)

    async def main() -> None:
        lrs.schedule_snapshot_from_normalizer(tid, object())
        await asyncio.sleep(0.02)

    asyncio.run(main())
    assert clean_state["payload"] == []
    assert clean_state["upsert"] == []
    # 手工塞的 inflight 标记不被清掉（属于模拟的在途任务）
    assert tid in lrs._inflight_threads


def test_schedule_runs_and_clears_inflight(clean_state) -> None:
    tid = "thread-run"

    async def main() -> None:
        lrs.schedule_snapshot_from_normalizer(tid, object())
        assert tid in lrs._inflight_threads, "调度后、完成前必须占住单飞位"
        await asyncio.sleep(0.05)

    asyncio.run(main())
    assert clean_state["payload"] == [tid]
    assert clean_state["upsert"] == [(tid, False)]
    assert tid not in lrs._inflight_threads, "完成后必须释放单飞位，否则后续帧永远进不来"


def test_force_bypasses_gate_and_inflight(clean_state) -> None:
    tid = "thread-force"
    lrs._last_flush_ms[tid] = time.time() * 1000
    lrs._inflight_threads.add(tid)

    async def main() -> None:
        lrs.schedule_snapshot_from_normalizer(tid, object(), force=True)
        await asyncio.sleep(0.05)

    asyncio.run(main())
    assert clean_state["upsert"] == [(tid, True)]


def test_empty_payload_releases_inflight(clean_state, monkeypatch: pytest.MonkeyPatch) -> None:
    """payload 为空（无正文/工具）：不写库，但要释放单飞位，别把线程卡死。"""
    tid = "thread-empty"
    monkeypatch.setattr(
        lrs,
        "snapshot_from_normalizer_payload",
        lambda tid_, normalizer: None,
    )

    async def main() -> None:
        lrs.schedule_snapshot_from_normalizer(tid, object())
        await asyncio.sleep(0.02)

    asyncio.run(main())
    assert clean_state["upsert"] == []
    assert tid not in lrs._inflight_threads
