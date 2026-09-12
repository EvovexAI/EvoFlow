"""Tests for O3 event triggers / noop backoff / O4.2 alert helpers."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from evoflow.proactive.models import ProactiveRole, ProactiveRoleConfig, ThinkResult
from evoflow.proactive.runner import ProactiveRunner
from evoflow.proactive.triggers import EventTriggerBus, get_event_bus, reset_event_bus


@pytest.fixture(autouse=True)
def _reset_bus():
    reset_event_bus()
    yield
    reset_event_bus()


def test_weekly_report_skips_when_recent() -> None:
    runner = ProactiveRunner()
    role = ProactiveRole(
        agent_code="wk",
        role_name="周报岗",
        config=ProactiveRoleConfig(),
        status="active",
    )
    mem = MagicMock()
    mem.extra = {"last_weekly_report_at": "2099-01-01T00:00:00Z"}

    with (
        patch(
            "evoflow.proactive.repositories.ProactiveRepository.list_roles",
            return_value=[role],
        ),
        patch(
            "evoflow.proactive.repositories.ProactiveMemoryRepository.get",
            return_value=mem,
        ),
        patch.object(runner, "_push_ops_alert", new_callable=AsyncMock) as push,
    ):
        n = asyncio.run(runner._maybe_push_weekly_reports())

    assert n == 0
    push.assert_not_called()


def test_noop_backoff_scales_after_three_rounds() -> None:
    runner = ProactiveRunner()
    role = ProactiveRole(
        agent_code="noop_r",
        role_name="N",
        heartbeat_rrule="FREQ=HOURLY;INTERVAL=2",
        config=ProactiveRoleConfig(),
    )
    mem = MagicMock()
    mem.extra = {}

    with patch(
        "evoflow.proactive.repositories.ProactiveMemoryRepository.get",
        return_value=mem,
    ):
        with patch("evoflow.proactive.repositories.ProactiveMemoryRepository.save"):
            # Seed 2 prior noops in memory
            mem.extra = {"consecutive_noop_count": 2}
            result = ThinkResult(outcome="本轮无变化，一切正常", created_initiative_ids=[])
            next_hb = runner._apply_noop_backoff(role, result, "2026-01-01T12:00:00+08:00")
            assert mem.extra["consecutive_noop_count"] == 3
            # Should push next heartbeat further than the input placeholder
            assert next_hb != "2026-01-01T12:00:00+08:00"
            assert "T" in next_hb


def test_noop_backoff_resets_on_real_work() -> None:
    runner = ProactiveRunner()
    role = ProactiveRole(agent_code="w", role_name="W", heartbeat_rrule="FREQ=HOURLY;INTERVAL=2")
    mem = MagicMock()
    mem.extra = {"consecutive_noop_count": 5}

    with patch(
        "evoflow.proactive.repositories.ProactiveMemoryRepository.get",
        return_value=mem,
    ):
        with patch("evoflow.proactive.repositories.ProactiveMemoryRepository.save"):
            result = ThinkResult(outcome="完成了 ESLint 修复", created_initiative_ids=["init_1"])
            out = runner._apply_noop_backoff(role, result, "keep-me")
            assert mem.extra["consecutive_noop_count"] == 0
            assert out == "keep-me"


def test_event_bus_debounces_git_push() -> None:
    runner = MagicMock()
    runner.dispatch_task = AsyncMock(return_value={"ok": True})
    bus = EventTriggerBus(runner)

    async def _run() -> None:
        await bus.emit("git_push", "code-agent", description="a")
        await bus.emit("git_push", "code-agent", description="b")
        assert bus.pending_count == 1
        # Cancel so test doesn't wait 60s
        bus.cancel_all()
        assert bus.pending_count == 0

    asyncio.run(_run())


def test_event_bus_ci_failed_fires_immediately() -> None:
    runner = MagicMock()
    runner.dispatch_task = AsyncMock(return_value={"ok": True, "busy": False})
    bus = EventTriggerBus(runner)

    async def _run() -> None:
        await bus.emit("ci_failed", "code-agent")
        assert runner.dispatch_task.await_count == 1
        args, kwargs = runner.dispatch_task.await_args
        assert args[0] == "code-agent"
        assert kwargs.get("source") == "event:ci_failed" or (
            len(args) >= 1 and True
        )
        # source is kwarg
        assert runner.dispatch_task.await_args.kwargs.get("source") == "event:ci_failed"

    asyncio.run(_run())


def test_get_event_bus_singleton() -> None:
    runner = MagicMock()
    a = get_event_bus(runner)
    b = get_event_bus()
    assert a is b


def test_anomaly_zombie_alert_dedupes() -> None:
    runner = ProactiveRunner()

    async def _run() -> None:
        fake_stale = [SimpleNamespace(role_agent_code="r1") for _ in range(6)]
        with patch(
            "evoflow.proactive.repositories.ProactiveRepository.list_stale_executing",
            return_value=fake_stale,
        ):
            with patch(
                "evoflow.proactive.repositories.ProactiveRepository.list_roles",
                return_value=[],
            ):
                with patch.object(runner, "_push_ops_alert", new_callable=AsyncMock) as push:
                    first = await runner._check_anomaly_alerts()
                    second = await runner._check_anomaly_alerts()
                    assert "zombie" in first
                    assert second == []  # same day dedupe
                    assert push.await_count == 1

    asyncio.run(_run())


def test_environment_context_omits_git_injection() -> None:
    """Duty brief must not auto-inject recent git commits (avoids non-eng drift)."""
    import asyncio

    runner = ProactiveRunner()
    role = ProactiveRole(
        agent_code="x",
        role_name="X",
        config=ProactiveRoleConfig(workspace_path="/no/such/path/ever"),
    )
    ctx = asyncio.run(runner._gather_environment_context(role))
    assert "自上次巡检以来的变化" not in ctx
    assert "git" not in ctx.lower()
