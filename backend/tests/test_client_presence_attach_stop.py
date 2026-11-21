"""client_attach / client_restart default must not cancel panel runs."""

from __future__ import annotations

import os
from unittest.mock import AsyncMock, patch

import pytest

from app.gateway import client_presence as cp


@pytest.fixture(autouse=True)
def _reset_client_id():
    prev = cp._current_client_instance_id
    cp._current_client_instance_id = None
    yield
    cp._current_client_instance_id = prev


@pytest.mark.asyncio
async def test_client_attach_skips_stop_by_default(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("EVOFLOW_CLIENT_ATTACH_STOP_RUNS", raising=False)
    monkeypatch.delenv("EVOFLOW_CLIENT_RESTART_STOP_RUNS", raising=False)

    stop = AsyncMock(return_value={"chat_session_keys": ["sk"], "reason": "client_attach"})
    with patch.object(cp, "stop_all_panel_attached_sessions", stop):
        out = await cp.attach_client_instance("default::aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")

    assert out["ok"] is True
    assert out["reason"] == "client_attach"
    assert out["cancel_skipped"] is True
    assert out["stopped"] is None
    stop.assert_not_awaited()


@pytest.mark.asyncio
async def test_client_attach_stop_opt_in(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("EVOFLOW_CLIENT_ATTACH_STOP_RUNS", "true")
    monkeypatch.delenv("EVOFLOW_CLIENT_RESTART_STOP_RUNS", raising=False)

    stopped = {
        "chat_session_keys": ["panel:x"],
        "goal_session_keys": [],
        "reason": "client_attach",
    }
    stop = AsyncMock(return_value=stopped)
    with patch.object(cp, "stop_all_panel_attached_sessions", stop):
        out = await cp.attach_client_instance("default::aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")

    assert out["cancel_skipped"] is False
    assert out["stopped"] == stopped
    stop.assert_awaited_once()
    assert stop.await_args.kwargs.get("reason") == "client_attach"


@pytest.mark.asyncio
async def test_client_restart_skips_stop_by_default(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("EVOFLOW_CLIENT_ATTACH_STOP_RUNS", raising=False)
    monkeypatch.delenv("EVOFLOW_CLIENT_RESTART_STOP_RUNS", raising=False)
    cp._current_client_instance_id = "default::old-old-old-old-oldoldoldold"

    stop = AsyncMock()
    with patch.object(cp, "stop_all_panel_attached_sessions", stop):
        out = await cp.attach_client_instance("default::aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")

    assert out["reason"] == "client_restart"
    assert out["cancel_skipped"] is True
    stop.assert_not_awaited()
