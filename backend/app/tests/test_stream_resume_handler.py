"""stream-resume: history-poll finish gates."""

import asyncio
from unittest.mock import AsyncMock, patch

from app.gateway.streaming.stream_resume_handler import (
    _history_sig,
    _live_idle_should_finish,
    _resume_should_finish,
    _resume_should_finish_async,
)


def test_resume_should_finish_only_when_terminal_and_run_idle() -> None:
    assert _resume_should_finish(terminal_seen=False, run_status="running") is False
    assert _resume_should_finish(terminal_seen=True, run_status="running") is False
    assert _resume_should_finish(terminal_seen=True, run_status="pending") is False
    assert _resume_should_finish(terminal_seen=True, run_status="idle") is True
    assert _resume_should_finish(terminal_seen=True, run_status="completed") is True


def test_history_sig_changes_with_message_growth() -> None:
    a = _history_sig({"runStatus": "running", "messages": [{"id": "1", "role": "assistant", "content": "hi"}]})
    b = _history_sig({"runStatus": "running", "messages": [{"id": "1", "role": "assistant", "content": "hi there"}]})
    assert a != b


def test_resume_should_finish_async_langgraph_still_active() -> None:
    async def _run() -> None:
        with (
            patch(
                "app.gateway.streaming.stream_resume_handler._probe_langgraph_active",
                new=AsyncMock(return_value=True),
            ) as probe,
            patch(
                "app.gateway.streaming.stream_resume_handler._heal_session_run_active_if_needed",
                new=AsyncMock(),
            ) as heal,
        ):
            ok = await _resume_should_finish_async(
                "agent:main:test",
                thread_id="thread-1",
                run_id="run-1",
                terminal_seen=True,
                run_status="idle",
            )
        assert ok is False
        probe.assert_awaited_once()
        heal.assert_awaited_once()

    asyncio.run(_run())


def test_resume_should_finish_async_langgraph_inactive() -> None:
    async def _run() -> None:
        with patch(
            "app.gateway.streaming.stream_resume_handler._probe_langgraph_active",
            new=AsyncMock(return_value=False),
        ):
            ok = await _resume_should_finish_async(
                "agent:main:test",
                thread_id="thread-1",
                run_id=None,
                terminal_seen=True,
                run_status="idle",
            )
        assert ok is True

    asyncio.run(_run())


def test_live_idle_should_finish_langgraph_active_keeps_tailing() -> None:
    async def _run() -> None:
        with (
            patch(
                "app.gateway.streaming.stream_resume_handler._probe_langgraph_active",
                new=AsyncMock(return_value=True),
            ),
            patch(
                "app.gateway.streaming.stream_resume_handler._heal_session_run_active_if_needed",
                new=AsyncMock(),
            ) as heal,
        ):
            ok = await _live_idle_should_finish(
                "agent:main:test",
                thread_id="thread-1",
                run_id="run-1",
            )
        assert ok is False
        heal.assert_awaited_once()

    asyncio.run(_run())


def test_resume_should_finish_async_langgraph_unreachable() -> None:
    async def _run() -> None:
        with patch(
            "app.gateway.streaming.stream_resume_handler._probe_langgraph_active",
            new=AsyncMock(return_value=None),
        ):
            ok = await _resume_should_finish_async(
                "agent:main:test",
                thread_id="thread-1",
                run_id="run-1",
                terminal_seen=True,
                run_status="idle",
            )
        # History-poll: DB already idle + LangGraph unreachable → finish.
        assert ok is True

    asyncio.run(_run())


def test_live_idle_should_finish_langgraph_unreachable_keeps_polling() -> None:
    async def _run() -> None:
        with patch(
            "app.gateway.streaming.stream_resume_handler._probe_langgraph_active",
            new=AsyncMock(return_value=None),
        ):
            ok = await _live_idle_should_finish(
                "agent:main:test",
                thread_id="thread-1",
                run_id="run-1",
            )
        assert ok is False

    asyncio.run(_run())


def test_mirror_writes_disabled_by_default() -> None:
    from app.gateway.streaming.stream_mirror import (
        langgraph_post_mirror_tee_enabled,
        stream_mirror_writes_enabled,
    )

    assert stream_mirror_writes_enabled() is False
    assert (
        langgraph_post_mirror_tee_enabled(
            method="POST",
            path="/api/langgraph/threads/t1/runs/stream",
            query="ui_sse=1",
        )
        is False
    )
