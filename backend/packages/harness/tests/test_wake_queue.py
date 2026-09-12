"""L1 wake queue: busy roles enqueue instead of failing silently / minting tasks."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch


def test_enqueue_pending_wake_dedupes_by_related_task_id() -> None:
    from evoflow.proactive.runner import ProactiveRunner

    runner = ProactiveRunner()

    async def _run() -> None:
        with patch(
            "evoflow.proactive.runner.ProactiveRepository.get_role",
            return_value=MagicMock(role_name="前端工程师", agent_code="code-agent"),
        ):
            a = await runner._enqueue_pending_wake(
                "code-agent",
                "goal-a",
                related_task_id="Task_1",
            )
            b = await runner._enqueue_pending_wake(
                "code-agent",
                "goal-b",
                related_task_id="Task_1",
            )
        assert a.get("queued_behind_busy") is True
        assert b.get("queued_behind_busy") is True
        assert b.get("queue_depth") == 1
        q = runner._wake_queue.get("code-agent") or []
        assert len(q) == 1
        assert q[0]["goal"] == "goal-b"

    asyncio.run(_run())


def test_fire_and_forget_busy_enqueues() -> None:
    from evoflow.proactive.runner import ProactiveRunner

    runner = ProactiveRunner()

    async def _run() -> None:
        role = MagicMock(role_name="前端工程师", agent_code="code-agent", status="active")
        with (
            patch(
                "evoflow.proactive.runner.ProactiveRepository.get_role",
                return_value=role,
            ),
            patch.object(runner, "_reserve_role", new=AsyncMock(return_value=False)),
        ):
            out = await runner.dispatch_task_fire_and_forget(
                "code-agent",
                "继续修闪烁",
                related_task_id="2608150338_29d8",
                source="user_item",
                skip_done_guard=True,
            )
        assert out.get("queued_behind_busy") is True
        assert out.get("dispatched") is False
        assert out.get("related_task_id") == "2608150338_29d8"
        assert (runner._wake_queue.get("code-agent") or [])[0]["related_task_id"] == "2608150338_29d8"

    asyncio.run(_run())


def test_fire_and_forget_interrupt_cancels_then_dispatches() -> None:
    from evoflow.proactive.runner import ProactiveRunner

    runner = ProactiveRunner()

    async def _run() -> None:
        role = MagicMock(role_name="前端工程师", agent_code="code-agent", status="active")
        reserve = AsyncMock(side_effect=[False, True])
        cancel = AsyncMock(
            return_value={
                "ok": True,
                "was_busy": True,
                "task_cancelled": True,
                "langgraph_runs_cancelled": 0,
            }
        )
        with (
            patch(
                "evoflow.proactive.runner.ProactiveRepository.get_role",
                return_value=role,
            ),
            patch.object(runner, "_reserve_role", new=reserve),
            patch.object(runner, "cancel_role", new=cancel),
            patch.object(runner, "_dispatch_task_bg", new=AsyncMock(return_value={})),
        ):
            out = await runner.dispatch_task_fire_and_forget(
                "code-agent",
                "立刻改闪烁",
                related_task_id="2608150338_29d8",
                source="user_item",
                skip_done_guard=True,
                interrupt=True,
            )
        assert out.get("dispatched") is True
        assert out.get("interrupted") is True
        assert "中断" in str(out.get("message") or "")
        cancel.assert_awaited_once()
        assert cancel.await_args.kwargs.get("drain_queue") is False
        assert reserve.await_count == 2
        assert not (runner._wake_queue.get("code-agent") or [])

    asyncio.run(_run())
