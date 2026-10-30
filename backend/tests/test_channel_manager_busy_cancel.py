"""IM thread-busy: cancel stale LangGraph runs then retry."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from langgraph_sdk.errors import ConflictError

from app.channels.manager import (
    ChannelManager,
    _is_thread_busy_error,
    _is_transient_stream_error,
)


def test_is_thread_busy_error_detects_conflict() -> None:
    class _Busy(ConflictError):
        def __init__(self) -> None:  # noqa: D107
            Exception.__init__(self, "already running a task")

    assert _is_thread_busy_error(_Busy())
    assert _is_thread_busy_error(RuntimeError("Thread already running a task"))
    assert not _is_thread_busy_error(RuntimeError("timeout"))


def test_is_transient_stream_error_detects_timeouts() -> None:
    class ReadTimeout(Exception):
        pass

    assert _is_transient_stream_error(ReadTimeout("httpx.ReadTimeout"))
    assert _is_transient_stream_error(RuntimeError("The read operation timed out"))
    assert _is_transient_stream_error(RuntimeError("server disconnected without sending a response"))
    assert not _is_transient_stream_error(RuntimeError("already running a task"))
    assert not _is_transient_stream_error(None)


@pytest.mark.asyncio
async def test_cancel_pending_runs_on_thread_cancels_active_only() -> None:
    mgr = object.__new__(ChannelManager)
    client = SimpleNamespace(
        runs=SimpleNamespace(
            list=AsyncMock(
                return_value=[
                    {"run_id": "r1", "status": "running"},
                    {"run_id": "r2", "status": "pending"},
                    {"run_id": "r3", "status": "success"},
                    {"id": "r4", "status": "running"},
                ]
            ),
            cancel=AsyncMock(),
        )
    )
    n = await mgr._cancel_pending_runs_on_thread(client, "thread-abc")
    assert n == 3
    called = []
    for c in client.runs.cancel.await_args_list:
        if c.kwargs.get("run_id"):
            called.append(c.kwargs["run_id"])
        elif len(c.args) >= 2:
            called.append(c.args[1])
    assert sorted(called) == ["r1", "r2", "r4"]


@pytest.mark.asyncio
async def test_cancel_pending_runs_empty_thread() -> None:
    mgr = object.__new__(ChannelManager)
    client = SimpleNamespace(runs=SimpleNamespace(list=AsyncMock(), cancel=AsyncMock()))
    assert await mgr._cancel_pending_runs_on_thread(client, "") == 0
    client.runs.list.assert_not_awaited()
