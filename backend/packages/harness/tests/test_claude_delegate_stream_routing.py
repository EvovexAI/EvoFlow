"""Claude Code subtask delegation must route stream events to gateway SSE in follow-up waves."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from evoflow.tools.builtins.supervisor import execution as exec_mod


def test_claude_delegate_send_passes_main_task_id_for_sse() -> None:
  storage = SimpleNamespace()
  subtask_row = {"name": "Step 2", "project_path": "./"}
  captured: list[dict] = []

  async def _fake_ainvoke(payload: dict) -> dict:
    captured.append(dict(payload))
    action = payload.get("action")
    if action == "create":
      return {"ok": True, "session_id": "claude-code-test1"}
    if action == "send":
      return {"ok": True, "accumulated_text": "done", "streamed_lines": 1}
    if action == "close":
      return {"ok": True}
    return {"ok": True}

  async def _run() -> dict:
    with (
      patch.object(exec_mod, "get_stream_writer", side_effect=RuntimeError("no writer")),
      patch(
        "evoflow.tools.builtins.claude_session_tool.claude_session_tool",
        SimpleNamespace(ainvoke=_fake_ainvoke),
      ),
      patch(
        "evoflow.tools.builtins.supervisor.execution._emit_claude_subtask_task_started",
        new_callable=AsyncMock,
      ),
      patch(
        "evoflow.collab.storage.persist_subtask_runtime_snapshot",
      ),
      patch(
        "evoflow.tools.builtins.task_tool._append_subtask_conversation_replica",
      ),
      patch(
        "evoflow.tools.builtins.supervisor.execution._persist_subtask_session_id",
      ),
      patch(
        "evoflow.collab.sse_notify.broadcast_collab_subtask_stream",
        new_callable=AsyncMock,
      ),
    ):
      return await exec_mod._delegate_via_claude_session_tool(
        storage=storage,
        main_task_id="Task_main_abc",
        subtask_id="Subtask_parallel_2",
        subtask_row=subtask_row,
        prompt="run step 2",
        default_project_path="./",
      )

  result = asyncio.run(_run())

  assert result.get("ok") is True
  send_calls = [p for p in captured if p.get("action") == "send"]
  assert len(send_calls) == 1
  assert send_calls[0].get("stream_to_subtask_id") == "Subtask_parallel_2"
  assert send_calls[0].get("stream_to_main_task_id") == "Task_main_abc"


def test_claude_task_started_broadcast_when_no_langgraph_writer() -> None:
  async def _run() -> None:
    with patch(
      "evoflow.collab.sse_notify.broadcast_collab_subtask_stream",
      new_callable=AsyncMock,
    ) as mock_broadcast:
      await exec_mod._emit_claude_subtask_task_started(
        main_task_id="Task_main_abc",
        subtask_id="Subtask_parallel_3",
        subtask_row={"name": "Step 3"},
        writer=None,
      )
      mock_broadcast.assert_awaited_once()
      args = mock_broadcast.await_args
      assert args is not None
      assert args.args[0] == "Task_main_abc"
      assert args.args[1] == "task:started"
      assert args.kwargs.get("subtask_id") == "Subtask_parallel_3"

  asyncio.run(_run())


def test_claude_task_started_sse_even_when_langgraph_writer_present() -> None:
  async def _run() -> None:
    writer = AsyncMock()
    with patch(
      "evoflow.collab.sse_notify.broadcast_collab_subtask_stream",
      new_callable=AsyncMock,
    ) as mock_sse:
      await exec_mod._emit_claude_subtask_task_started(
        main_task_id="Task_main_abc",
        subtask_id="Subtask_parallel_3",
        subtask_row={"name": "Step 3"},
        writer=writer,
      )
      mock_sse.assert_awaited_once()
      writer.assert_called_once()

  asyncio.run(_run())


def test_claude_delegate_detached_returns_before_send_finishes() -> None:
  storage = SimpleNamespace()
  subtask_row = {"name": "Step 3", "project_path": "./", "claude_session_id": "existing-sid"}
  send_started = asyncio.Event()
  send_release = asyncio.Event()

  async def _fake_ainvoke(payload: dict) -> dict:
    if payload.get("action") == "send":
      send_started.set()
      await send_release.wait()
      return {"ok": True, "accumulated_text": "parallel ok", "streamed_lines": 2}
    if payload.get("action") == "close":
      return {"ok": True}
    return {"ok": True}

  async def _run() -> None:
    with (
      patch.object(exec_mod, "get_stream_writer", side_effect=RuntimeError("no writer")),
      patch(
        "evoflow.tools.builtins.claude_session_tool.claude_session_tool",
        SimpleNamespace(ainvoke=_fake_ainvoke),
      ),
      patch(
        "evoflow.tools.builtins.supervisor.execution._emit_claude_subtask_task_started",
        new_callable=AsyncMock,
      ),
      patch("evoflow.collab.storage.persist_subtask_runtime_snapshot"),
      patch("evoflow.tools.builtins.task_tool._append_subtask_conversation_replica"),
      patch(
        "evoflow.collab.sse_notify.broadcast_collab_subtask_stream",
        new_callable=AsyncMock,
      ),
    ):
      task = asyncio.create_task(
        exec_mod._delegate_via_claude_session_tool(
          storage=storage,
          main_task_id="Task_main_abc",
          subtask_id="Subtask_parallel_3",
          subtask_row=subtask_row,
          prompt="run step 3",
          wait_for_completion=False,
        )
      )
      result = await asyncio.wait_for(task, timeout=1.0)
      assert result.get("detached") is True
      assert result.get("ok") is True
      await asyncio.wait_for(send_started.wait(), timeout=1.0)
      send_release.set()
      await asyncio.sleep(0.05)

  asyncio.run(_run())
