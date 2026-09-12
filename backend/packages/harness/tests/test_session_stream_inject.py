"""Session stream inject merges subtask custom after UI normalize."""

from __future__ import annotations

import asyncio

from app.gateway.streaming.session_stream_inject import (
    _bundle_tail_should_stay_open,
    _has_pending_collab_subtasks,
    begin_thread_inject,
    end_thread_inject,
    inject_langgraph_custom,
    merge_normalized_with_inject,
)


async def _collect(agen):
    return [c async for c in agen]


def test_merge_normalized_does_not_split_upstream_frames() -> None:
    async def normalized():
        yield b"event: evf\ndata: {\"type\":\"delta\",\"text\":\"hel\"}\n\n"
        yield b"event: evf\ndata: {\"type\":\"delta\",\"text\":\"lo\"}\n\n"
        yield b"event: evf\ndata: {\"type\":\"run_end\",\"text\":\"hello\"}\n\n"

    begin_thread_inject("t1")
    try:
        out = asyncio.run(_collect(merge_normalized_with_inject(normalized(), "t1", poll_seconds=0.01)))
    finally:
        end_thread_inject("t1")

    text = b"".join(out).decode("utf-8")
    assert "delta" in text
    assert "hello" in text
    assert text.index("hel") < text.index("run_end")


def test_inject_yields_evf_custom_after_normalize() -> None:
    async def normalized():
        await asyncio.sleep(0.02)
        yield b"event: evf\ndata: {\"type\":\"run_end\",\"text\":\"\"}\n\n"

    begin_thread_inject("t2")

    async def run() -> None:
        await inject_langgraph_custom(
            "t2",
            {"type": "task_running", "collab_subtask_id": "Sub_1", "task_id": "Sub_1"},
        )
        out = await _collect(merge_normalized_with_inject(normalized(), "t2", poll_seconds=0.01))
        end_thread_inject("t2")
        return out

    out = asyncio.run(run())
    joined = b"".join(out).decode("utf-8")
    assert "task_running" in joined
    assert "Sub_1" in joined
    assert "event: evf" in joined


def test_bundle_tail_stays_open_for_in_flight_subtask() -> None:
    bundle = {
        "status": "executing",
        "tasks": [{"subtasks": [{"status": "in_progress"}]}],
    }
    assert _bundle_tail_should_stay_open(bundle) is True


def test_bundle_tail_closes_when_phase_stale_and_subtasks_terminal() -> None:
    bundle = {
        "status": "executing",
        "tasks": [{"subtasks": [{"status": "completed"}, {"status": "failed"}]}],
    }
    assert _bundle_tail_should_stay_open(bundle) is False


def test_bundle_tail_stays_open_for_claimable_pending_wave() -> None:
    bundle = {
        "status": "executing",
        "tasks": [{"subtasks": [{"status": "completed"}, {"status": "pending"}]}],
    }
    assert _bundle_tail_should_stay_open(bundle) is True


def test_has_pending_collab_subtasks_false_without_active_phase(monkeypatch) -> None:
    class _State:
        collab_phase = type("P", (), {"value": "idle"})()
        bound_task_id = "task-1"

    monkeypatch.setattr(
        "evoflow.collab.thread_collab.load_thread_collab_state",
        lambda _paths, _tid: _State(),
    )
    assert _has_pending_collab_subtasks("thread-1") is False


def test_merge_waits_through_slow_upstream_without_aborting_normalize() -> None:
    """Regression: wait_for on __anext__ cancelled normalize before first yield."""

    async def normalized():
        await asyncio.sleep(0.12)
        yield b"event: evf\ndata: {\"type\":\"delta\",\"text\":\"hi\"}\n\n"
        yield b"event: evf\ndata: {\"type\":\"run_end\",\"text\":\"hi\"}\n\n"

    begin_thread_inject("t3")
    try:
        out = asyncio.run(_collect(merge_normalized_with_inject(normalized(), "t3", poll_seconds=0.05)))
    finally:
        end_thread_inject("t3")

    text = b"".join(out).decode("utf-8")
    assert "delta" in text
    assert "run_end" in text


def test_tail_max_configurable_via_env(monkeypatch) -> None:
    import importlib

    import app.gateway.streaming.session_stream_inject as mod

    monkeypatch.setenv("EVOFLOW_STREAM_INJECT_TAIL_MAX_S", "180")
    importlib.reload(mod)
    try:
        assert mod._TAIL_PHASE_MAX_S == 180.0
    finally:
        monkeypatch.delenv("EVOFLOW_STREAM_INJECT_TAIL_MAX_S", raising=False)
        importlib.reload(mod)
