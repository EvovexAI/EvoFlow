"""Tests for batched async stream mirror writes."""

from __future__ import annotations

import asyncio

import pytest

import app.gateway.streaming.stream_mirror as mirror


@pytest.fixture(autouse=True)
def _reset_mirror_state(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("EVOFLOW_STREAM_MIRROR", "1")
    mirror._wire_buffers.clear()
    mirror._last_touch_ms.clear()
    mirror._pending_batches.clear()
    mirror._main_loop = None
    yield
    mirror._wire_buffers.clear()
    mirror._last_touch_ms.clear()
    mirror._pending_batches.clear()
    mirror._main_loop = None


def _frame(event: str, data: str) -> str:
    return f"event: {event}\ndata: {data}\n\n"


def test_mirror_batches_until_max_frames(monkeypatch: pytest.MonkeyPatch) -> None:
    persisted: list[list[str]] = []

    def fake_persist(sk: str, tid: str, rid: str, frames: list[str], *, source: str = "mirror") -> None:
        persisted.append(list(frames))

    monkeypatch.setattr(mirror, "_persist_frames", fake_persist)
    monkeypatch.setattr(mirror, "_resolve_session_key", lambda _tid: "agent:main:test")
    monkeypatch.setattr(mirror, "_resolve_run_id", lambda _tid, run_id=None: "run-1")

    async def _run() -> None:
        for i in range(mirror._BATCH_MAX_FRAMES - 1):
            mirror.enqueue_wire_chunk_sync("tid-batch", _frame("messages", f'{{"i":{i}}}'), run_id="run-1")

        assert persisted == []
        assert "tid-batch" in mirror._pending_batches

        mirror.enqueue_wire_chunk_sync("tid-batch", _frame("messages", '{"last":true}'), run_id="run-1")
        await asyncio.sleep(0.05)

    asyncio.run(_run())
    assert len(persisted) == 1
    assert len(persisted[0]) == mirror._BATCH_MAX_FRAMES


def test_mirror_flushes_terminal_frame_immediately(monkeypatch: pytest.MonkeyPatch) -> None:
    persisted: list[list[str]] = []

    def fake_persist(sk: str, tid: str, rid: str, frames: list[str], *, source: str = "mirror") -> None:
        persisted.append(list(frames))

    monkeypatch.setattr(mirror, "_persist_frames", fake_persist)
    monkeypatch.setattr(mirror, "_resolve_session_key", lambda _tid: "agent:main:test")
    monkeypatch.setattr(mirror, "_resolve_run_id", lambda _tid, run_id=None: "run-1")

    async def _run() -> None:
        mirror.enqueue_wire_chunk_sync(
            "tid-terminal",
            _frame("evf", '{"type":"run_end","threadId":"tid-terminal"}'),
            run_id="run-1",
        )
        await asyncio.sleep(0.05)

    asyncio.run(_run())
    assert len(persisted) == 1
    assert any("run_end" in frame for frame in persisted[0])


def test_flush_mirror_batch_for_thread_drains_pending(monkeypatch: pytest.MonkeyPatch) -> None:
    persisted: list[list[str]] = []

    def fake_persist(sk: str, tid: str, rid: str, frames: list[str], *, source: str = "mirror") -> None:
        persisted.append(list(frames))

    monkeypatch.setattr(mirror, "_persist_frames", fake_persist)
    monkeypatch.setattr(mirror, "_resolve_session_key", lambda _tid: "agent:main:test")
    monkeypatch.setattr(mirror, "_resolve_run_id", lambda _tid, run_id=None: "run-1")

    async def _run() -> None:
        mirror.enqueue_wire_chunk_sync("tid-flush", _frame("messages", '{"x":1}'), run_id="run-1")
        assert persisted == []
        await mirror.flush_mirror_batch_for_thread("tid-flush", run_id="run-1")

    asyncio.run(_run())
    assert len(persisted) == 1
    assert persisted[0]
    assert "tid-flush" not in mirror._pending_batches


def test_enqueue_from_worker_thread_batches_until_full(monkeypatch: pytest.MonkeyPatch) -> None:
    persisted: list[list[str]] = []

    def fake_persist(sk: str, tid: str, rid: str, frames: list[str], *, source: str = "mirror") -> None:
        persisted.append(list(frames))

    monkeypatch.setattr(mirror, "_persist_frames", fake_persist)
    monkeypatch.setattr(mirror, "_resolve_session_key", lambda _tid: "agent:main:test")
    monkeypatch.setattr(mirror, "_resolve_run_id", lambda _tid, run_id=None: "run-1")
    monkeypatch.setattr(mirror, "_BATCH_MAX_FRAMES", 2)

    import concurrent.futures

    def worker() -> None:
        mirror.enqueue_wire_chunk_sync("tid-worker", _frame("messages", '{"a":1}'), run_id="run-1")
        mirror.enqueue_wire_chunk_sync("tid-worker", _frame("messages", '{"b":2}'), run_id="run-1")

    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        pool.submit(worker).result()

    assert len(persisted) == 1
    assert len(persisted[0]) == 2
