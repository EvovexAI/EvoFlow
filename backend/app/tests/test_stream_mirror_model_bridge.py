"""Tests for model-callback AG-UI mirror bridge."""

from __future__ import annotations

from uuid import uuid4

import httpx

from app.gateway.streaming import stream_mirror_model_bridge as bridge


def test_on_llm_error_emits_text_message_end(monkeypatch):
    emitted: list[tuple[str, dict, str | None]] = []

    def fake_emit(thread_id: str, payload: dict, *, run_id: str | None, source: str) -> None:
        emitted.append((thread_id, payload, run_id))

    monkeypatch.setattr(bridge, "_emit_agui", fake_emit)
    monkeypatch.setattr(bridge, "_asgi_stream_active", lambda _tid: False)

    tid = "thread-abc"
    lg_run_id = "run-lg-1"
    bridge.set_mirror_model_ctx(
        thread_id=tid,
        session_key="sk1",
        run_id=lg_run_id,
        message_id=f"{tid}:live",
        stream_kind="text",
    )

    cb = bridge.MirrorStreamTokenCallback()
    run_id = uuid4()
    cb.on_llm_new_token("hello", run_id=run_id)
    cb.on_llm_error(httpx.ReadTimeout(""), run_id=run_id)

    types = [p["type"] for _, p, _ in emitted]
    assert types == ["TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END"]
    assert emitted[-1][1]["messageId"] == f"{tid}:live"
    assert emitted[-1][2] == lg_run_id


def test_on_llm_error_emits_reasoning_end(monkeypatch):
    emitted: list[tuple[str, dict, str | None]] = []

    def fake_emit(thread_id: str, payload: dict, *, run_id: str | None, source: str) -> None:
        emitted.append((thread_id, payload, run_id))

    monkeypatch.setattr(bridge, "_emit_agui", fake_emit)
    monkeypatch.setattr(bridge, "_asgi_stream_active", lambda _tid: False)

    tid = "thread-reason"
    bridge.set_mirror_model_ctx(
        thread_id=tid,
        run_id="run-r1",
        message_id=f"{tid}:live",
        stream_kind="reasoning",
    )

    cb = bridge.MirrorStreamTokenCallback()
    run_id = uuid4()
    cb.on_llm_new_token("think", run_id=run_id)
    cb.on_llm_error(httpx.ReadTimeout(""), run_id=run_id)

    types = [p["type"] for _, p, _ in emitted]
    assert types[-2:] == ["REASONING_MESSAGE_END", "REASONING_END"]
