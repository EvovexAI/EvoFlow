"""Tests for EvoPanel client attach (gateway client_presence)."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, patch


def test_attach_client_instance_first_attach() -> None:
    import app.gateway.client_presence as cp

    async def _run() -> None:
        cp._current_client_instance_id = None
        with patch(
            "app.gateway.client_presence.stop_all_panel_attached_sessions",
            new_callable=AsyncMock,
            return_value={"chat_session_keys": [], "goal_session_keys": [], "reason": "client_attach"},
        ):
            out = await cp.attach_client_instance("first-client-id-001")
        assert out["ok"] is True
        assert out["client_instance_id"] == "first-client-id-001"
        assert out["reattached"] is False
        assert cp._current_client_instance_id == "first-client-id-001"

    asyncio.run(_run())


def test_attach_client_instance_reattach_same_id() -> None:
    import app.gateway.client_presence as cp

    async def _run() -> None:
        cp._current_client_instance_id = "same-client-id-002"
        with patch(
            "app.gateway.client_presence.stop_all_panel_attached_sessions",
            new_callable=AsyncMock,
        ) as stop_mock:
            out = await cp.attach_client_instance("same-client-id-002")
        assert out["reattached"] is True
        assert out["stopped"] is None
        stop_mock.assert_not_awaited()

    asyncio.run(_run())


def test_attach_client_instance_restart_skips_cancel_by_default() -> None:
    import app.gateway.client_presence as cp

    async def _run() -> None:
        cp._current_client_instance_id = "old-client-id-003"
        with patch(
            "app.gateway.client_presence.stop_all_panel_attached_sessions",
            new_callable=AsyncMock,
        ) as stop_mock:
            out = await cp.attach_client_instance("new-client-id-004")
        assert out["reattached"] is False
        assert out["cancel_skipped"] is True
        assert out["stopped"] is None
        stop_mock.assert_not_awaited()
        assert cp._current_client_instance_id == "new-client-id-004"

    asyncio.run(_run())


def test_attach_client_instance_restart_stops_when_env_enabled(monkeypatch) -> None:
    import app.gateway.client_presence as cp

    monkeypatch.setenv("EVOFLOW_CLIENT_RESTART_STOP_RUNS", "true")

    async def _run() -> None:
        cp._current_client_instance_id = "old-client-id-005"
        with patch(
            "app.gateway.client_presence.stop_all_panel_attached_sessions",
            new_callable=AsyncMock,
            return_value={"chat_session_keys": ["agent:main:main"], "goal_session_keys": [], "reason": "client_restart"},
        ) as stop_mock:
            out = await cp.attach_client_instance("new-client-id-006")
        assert out["cancel_skipped"] is False
        assert out["stopped"]["chat_session_keys"] == ["agent:main:main"]
        stop_mock.assert_awaited_once()

    asyncio.run(_run())
