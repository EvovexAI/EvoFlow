"""MCP stdio errlog default must track live sys.stderr after detach/rewrap."""

from __future__ import annotations

import asyncio
import io
import sys

import pytest

from evoflow.desktop_stdio import heal_mcp_stdio_errlog_default


def test_heal_mcp_stdio_errlog_replaces_detached_default():
    import mcp.client.stdio as stdio_mod

    wrapped = getattr(stdio_mod.stdio_client, "__wrapped__", stdio_mod.stdio_client)
    assert wrapped.__defaults__
    original_defaults = wrapped.__defaults__

    # Fake the Gateway failure mode without touching the process stderr fd:
    # MCP's frozen default points at a detached TextIOWrapper.
    stale = io.TextIOWrapper(io.BytesIO(), encoding="utf-8", errors="replace")
    stale.detach()
    wrapped.__defaults__ = (stale,) + tuple(original_defaults[1:])
    try:
        with pytest.raises(ValueError, match="buffer has been detached"):
            stale.write("x")

        heal_mcp_stdio_errlog_default()
        assert wrapped.__defaults__[0] is sys.stderr
    finally:
        # Restore whatever the SDK had so other tests stay clean.
        wrapped.__defaults__ = original_defaults


@pytest.mark.asyncio
async def test_heal_allows_stdio_spawn_with_stale_default():
    import mcp.client.stdio as stdio_mod
    from mcp import StdioServerParameters

    wrapped = getattr(stdio_mod.stdio_client, "__wrapped__", stdio_mod.stdio_client)
    original_defaults = wrapped.__defaults__
    stale = io.TextIOWrapper(io.BytesIO(), encoding="utf-8", errors="replace")
    stale.detach()
    wrapped.__defaults__ = (stale,) + tuple(original_defaults[1:])
    try:
        heal_mcp_stdio_errlog_default()
        params = StdioServerParameters(
            command=sys.executable, args=["-c", "import time; time.sleep(0.2)"]
        )
        async with stdio_mod.stdio_client(params) as (_r, _w):
            await asyncio.sleep(0.05)
    finally:
        wrapped.__defaults__ = original_defaults
