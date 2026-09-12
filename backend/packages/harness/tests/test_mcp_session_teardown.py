"""MCP session teardown must not abort vault reindex on cross-task cancel-scope errors."""

from __future__ import annotations

import asyncio
from contextlib import AsyncExitStack
from unittest.mock import AsyncMock, MagicMock

import pytest

from evoflow.knowledge.vault import mcp_runtime as mr


@pytest.mark.asyncio
async def test_close_stack_swallows_base_exception_group():
    stack = MagicMock(spec=AsyncExitStack)
    stack.aclose = AsyncMock(
        side_effect=BaseExceptionGroup(
            "unhandled errors in a TaskGroup",
            [RuntimeError("Attempted to exit cancel scope in a different task than it was entered in")],
        )
    )
    # Must not raise — previously escaped and aborted CLI reindex.
    await mr._close_stack(stack)


@pytest.mark.asyncio
async def test_close_session_resources_kills_pids_before_stack_close(monkeypatch):
    killed: list[int] = []

    monkeypatch.setattr(mr, "_kill_pid", lambda pid: killed.append(pid))
    monkeypatch.setattr(mr, "_unregister_pids", lambda _vid: None)

    stack = MagicMock(spec=AsyncExitStack)
    stack.aclose = AsyncMock(
        side_effect=BaseExceptionGroup(
            "tg",
            [RuntimeError("cancel scope")],
        )
    )
    sess = mr.VaultMcpSession(vault_id="evoflow-assets")
    sess.managed_pids = [4242, 4243]
    sess.search_stack = stack

    await mr._close_session_resources(sess)

    assert killed == [4242, 4243]
    assert sess.managed_pids == []
    assert sess.search_stack is None
    stack.aclose.assert_awaited()


@pytest.mark.asyncio
async def test_drop_session_never_raises_on_teardown_noise(monkeypatch):
    sess = mr.VaultMcpSession(vault_id="evoflow-assets")
    sess.managed_pids = [7]
    mr._SESSIONS["evoflow-assets"] = sess

    async def _boom(_sess):
        raise BaseExceptionGroup("tg", [RuntimeError("cancel scope")])

    monkeypatch.setattr(mr, "_close_session_resources", _boom)
    await mr.drop_session("evoflow-assets")
    assert "evoflow-assets" not in mr._SESSIONS
