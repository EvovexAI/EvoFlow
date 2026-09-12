"""Collab subtask stream inject from harness to gateway main chat runs/stream."""

from __future__ import annotations

import asyncio
import os
from unittest.mock import AsyncMock, patch

from evoflow.collab.sse_notify import broadcast_collab_task_event, make_gateway_task_stream_writer


def test_broadcast_injects_in_process_on_gateway() -> None:
    inject = AsyncMock(return_value=True)
    with (
        patch.dict(os.environ, {"EVOFLOW_GATEWAY_PROCESS": "1"}),
        patch("evoflow.collab.sse_notify._resolve_lead_thread_id", return_value="thread-abc"),
        patch("app.gateway.streaming.session_stream_inject.inject_langgraph_custom", inject, create=True),
    ):
        asyncio.run(
            broadcast_collab_task_event(
                "Task_main",
                "task:running",
                {"type": "task_running", "task_id": "Sub_1", "collab_subtask_id": "Sub_1"},
            )
        )
    inject.assert_awaited_once()
    args = inject.await_args
    assert args is not None
    assert args.args[0] == "thread-abc"
    assert args.args[1]["type"] == "task_running"


def test_broadcast_skips_in_process_outside_gateway_without_secret() -> None:
    inject = AsyncMock(return_value=True)
    with (
        patch.dict(os.environ, {"EVOFLOW_GATEWAY_PROCESS": "", "INTERNAL_EVENTS_SECRET": ""}, clear=False),
        patch("evoflow.collab.sse_notify._resolve_lead_thread_id", return_value="thread-abc"),
        patch("app.gateway.streaming.session_stream_inject.inject_langgraph_custom", inject, create=True),
    ):
        ok = asyncio.run(
            broadcast_collab_task_event(
                "Task_main",
                "task:running",
                {"type": "task_running", "task_id": "Sub_1", "collab_subtask_id": "Sub_1"},
            )
        )
    inject.assert_not_awaited()
    assert ok is False


def test_gateway_stream_writer_schedules_inject() -> None:
    writer = make_gateway_task_stream_writer("Task_main")
    with patch("evoflow.collab.sse_notify.inject_collab_subtask_custom", new_callable=AsyncMock) as mock_inject:

        async def _run() -> None:
            writer({"type": "task_running", "task_id": "exec-1", "collab_subtask_id": "Sub_1"})
            await asyncio.sleep(0)

        asyncio.run(_run())
        mock_inject.assert_awaited()
        args = mock_inject.await_args
        assert args is not None
        assert args.args[0] == "Task_main"
        assert args.args[1]["type"] == "task_running"
