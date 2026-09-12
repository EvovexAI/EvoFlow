"""Tests for LangGraph cancel + post-stop sweep."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, patch


def test_sweep_langgraph_runs_until_idle_clears_on_second_poll():
    from evoflow.session_execution.langgraph_cancel import sweep_langgraph_runs_until_idle

    client = AsyncMock()
    list_mock = AsyncMock(side_effect=[["run-1"], []])
    cancel_mock = AsyncMock(return_value=["run-1"])

    async def _run():
        with patch(
            "evoflow.session_execution.langgraph_cancel.list_active_langgraph_run_ids",
            list_mock,
        ), patch(
            "evoflow.session_execution.langgraph_cancel.cancel_active_langgraph_runs",
            cancel_mock,
        ), patch("evoflow.session_execution.langgraph_cancel.asyncio.sleep", new=AsyncMock()):
            return await sweep_langgraph_runs_until_idle(
                client,
                "thread-1",
                max_wait_s=2.0,
                poll_interval_s=0.01,
            )

    cancelled, orphans = asyncio.run(_run())
    assert cancelled == ["run-1"]
    assert orphans == []
    assert cancel_mock.await_count >= 1
    assert cancel_mock.await_args.kwargs.get("only_run_ids") == {"run-1"}


def test_sweep_langgraph_runs_until_idle_reports_orphans_on_timeout():
    from evoflow.session_execution.langgraph_cancel import sweep_langgraph_runs_until_idle

    client = AsyncMock()
    list_mock = AsyncMock(return_value=["run-stuck"])
    cancel_mock = AsyncMock(return_value=[])

    async def _run():
        with patch(
            "evoflow.session_execution.langgraph_cancel.list_active_langgraph_run_ids",
            list_mock,
        ), patch(
            "evoflow.session_execution.langgraph_cancel.cancel_active_langgraph_runs",
            cancel_mock,
        ), patch("evoflow.session_execution.langgraph_cancel.asyncio.sleep", new=AsyncMock()):
            return await sweep_langgraph_runs_until_idle(
                client,
                "thread-2",
                max_wait_s=0.0,
                poll_interval_s=0.01,
            )

    cancelled, orphans = asyncio.run(_run())
    assert cancelled == []
    assert orphans == ["run-stuck"]


def test_sweep_does_not_cancel_runs_started_after_stop_began():
    from evoflow.session_execution.langgraph_cancel import sweep_langgraph_runs_until_idle

    client = AsyncMock()
    list_mock = AsyncMock(side_effect=[["run-old"], ["run-new"]])
    cancel_mock = AsyncMock(return_value=["run-old"])

    async def _run():
        with patch(
            "evoflow.session_execution.langgraph_cancel.list_active_langgraph_run_ids",
            list_mock,
        ), patch(
            "evoflow.session_execution.langgraph_cancel.cancel_active_langgraph_runs",
            cancel_mock,
        ), patch("evoflow.session_execution.langgraph_cancel.asyncio.sleep", new=AsyncMock()):
            return await sweep_langgraph_runs_until_idle(
                client,
                "thread-race",
                max_wait_s=2.0,
                poll_interval_s=0.01,
            )

    cancelled, orphans = asyncio.run(_run())
    assert cancelled == ["run-old"]
    assert orphans == []
    assert cancel_mock.await_args.kwargs.get("only_run_ids") == {"run-old"}
    assert "run-new" not in cancelled


def test_cancel_langgraph_runs_before_send_only_targets_preferred():
    from evoflow.session_execution.langgraph_cancel import cancel_langgraph_runs_before_send

    client = AsyncMock()
    list_mock = AsyncMock(return_value=["run-current", "run-other"])

    async def _run():
        with patch(
            "evoflow.session_execution.langgraph_cancel.list_active_langgraph_run_ids",
            list_mock,
        ), patch(
            "evoflow.session_execution.langgraph_cancel._post_cancel_run",
            new=AsyncMock(return_value="cancelled"),
        ) as post_cancel:
            out = await cancel_langgraph_runs_before_send(
                client,
                "thread-send",
                preferred_run_id="run-current",
            )
            assert post_cancel.await_count == 1
            assert post_cancel.await_args.args[2] == "run-current"
            return out

    cancelled = asyncio.run(_run())
    assert cancelled == ["run-current"]


def test_cancel_before_send_without_preferred_is_noop():
    """Idle / no bound run: must not cancel newest active (races with new POST)."""
    from evoflow.session_execution.langgraph_cancel import cancel_langgraph_runs_before_send

    client = AsyncMock()
    list_mock = AsyncMock(return_value=["run-new"])
    post_cancel = AsyncMock(return_value="cancelled")

    async def _run():
        with patch(
            "evoflow.session_execution.langgraph_cancel.list_active_langgraph_run_ids",
            list_mock,
        ), patch(
            "evoflow.session_execution.langgraph_cancel._post_cancel_run",
            post_cancel,
        ):
            return await cancel_langgraph_runs_before_send(
                client,
                "thread-idle",
                preferred_run_id=None,
            )

    cancelled = asyncio.run(_run())
    assert cancelled == []
    assert list_mock.await_count == 0
    assert post_cancel.await_count == 0


def test_cancel_before_send_does_not_fallthrough_to_newest():
    """preferred missing from active list → no cancel of other actives."""
    from evoflow.session_execution.langgraph_cancel import cancel_langgraph_runs_before_send

    client = AsyncMock()
    list_mock = AsyncMock(return_value=["run-new"])
    post_cancel = AsyncMock(return_value="cancelled")

    async def _run():
        with patch(
            "evoflow.session_execution.langgraph_cancel.list_active_langgraph_run_ids",
            list_mock,
        ), patch(
            "evoflow.session_execution.langgraph_cancel._post_cancel_run",
            post_cancel,
        ):
            return await cancel_langgraph_runs_before_send(
                client,
                "thread-race",
                preferred_run_id="run-stale-client-uuid",
            )

    cancelled = asyncio.run(_run())
    assert cancelled == []
    assert post_cancel.await_count == 0


def test_cancel_langgraph_runs_before_send_treats_404_as_done():
    from evoflow.session_execution.langgraph_cancel import cancel_langgraph_runs_before_send

    client = AsyncMock()
    list_mock = AsyncMock(return_value=["run-stale"])

    async def _run():
        with patch(
            "evoflow.session_execution.langgraph_cancel.list_active_langgraph_run_ids",
            list_mock,
        ), patch(
            "evoflow.session_execution.langgraph_cancel._post_cancel_run",
            new=AsyncMock(return_value="already_gone"),
        ):
            return await cancel_langgraph_runs_before_send(
                client,
                "thread-send",
                preferred_run_id="run-stale",
            )

    cancelled = asyncio.run(_run())
    assert cancelled == []
