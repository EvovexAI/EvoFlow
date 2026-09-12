"""Tests for background mirror writer helpers."""

from __future__ import annotations

import pytest

from app.gateway.streaming.post_stream_ui_normalize import PostStreamUiTransform


def test_post_stream_metadata_sets_run_id(monkeypatch: pytest.MonkeyPatch) -> None:
    enqueued: list[str | None] = []

    def fake_enqueue(thread_id: str, chunk: bytes | str, *, run_id=None, session_key=None, source=None, **_kw) -> None:
        enqueued.append(run_id)

    monkeypatch.setattr(
        "app.gateway.streaming.stream_mirror.enqueue_wire_chunk_sync",
        fake_enqueue,
    )

    transform = PostStreamUiTransform(
        thread_id="tid-meta",
        body=b"",
        stream_format="agui",
        run_id=None,
        mirror_enabled=True,
    )
    transform.feed_upstream_for_mirror(
        b'event: metadata\ndata: {"run_id":"run-from-meta"}\n\n'
        b'event: messages\ndata: {"type":"ai","content":"hi"}\n\n'
    )
    transform.finish_upstream_for_mirror()

    assert transform.run_id == "run-from-meta"
    assert "run-from-meta" in enqueued

@pytest.mark.asyncio
async def test_background_mirror_writer_is_disabled() -> None:
    from app.gateway.streaming.stream_mirror_background import run_background_mirror_writer

    await run_background_mirror_writer(
        thread_id="tid-disabled",
        run_id="run-disabled",
        session_key="agent:main:test",
    )


@pytest.mark.asyncio
async def test_launch_mirror_tail_is_disabled() -> None:
    from app.gateway.streaming.stream_resume_langgraph_tail import launch_mirror_tail_on_disconnect

    assert launch_mirror_tail_on_disconnect(thread_id="tid-disabled", run_id="run-disabled") is None


def test_middle_layer_run_active_ignores_stale_db_when_langgraph_inactive(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import asyncio

    from app.gateway.streaming.stream_mirror_background import (
        is_run_still_active,
        is_run_still_active_for_middle_layer,
    )

    async def lg_inconclusive(*args, **kwargs):  # noqa: ANN002, ANN003
        return None

    def stale_db(*args, **kwargs):  # noqa: ANN002, ANN003
        return "stale-run-id"

    monkeypatch.setattr(
        "app.gateway.run_status_reconcile._langgraph_has_active_run",
        lg_inconclusive,
    )
    monkeypatch.setattr(
        "evoflow.persistence.session_run_state.peek_current_run_id",
        stale_db,
    )

    assert asyncio.run(is_run_still_active(thread_id="tid-stale", run_id="run-1")) is True
    assert asyncio.run(is_run_still_active_for_middle_layer(thread_id="tid-stale", run_id="run-1")) is False
