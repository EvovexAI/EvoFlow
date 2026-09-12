"""Tool surface lock: alphabetical order + session freeze."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock

from langchain.agents.middleware.types import ModelRequest
from langchain_core.messages import SystemMessage

from evoflow.agents.middlewares.tool_surface_lock_middleware import (
    ToolSurfaceLockMiddleware,
    clear_tool_surface_lock,
)


def _tool(name: str):
    return SimpleNamespace(name=name)


def test_tool_surface_lock_sorts_and_freezes() -> None:
    clear_tool_surface_lock("t-tools")
    mw = ToolSurfaceLockMiddleware()
    rt = MagicMock()
    rt.context = {"thread_id": "t-tools"}
    req = ModelRequest(
        model=MagicMock(),
        messages=[],
        system_message=SystemMessage("sys"),
        tools=[_tool("zeta"), _tool("alpha"), _tool("mid")],
        state={"messages": []},
        runtime=rt,
    )
    out1 = mw._patch_request(req)
    assert [t.name for t in out1.tools] == ["alpha", "mid", "zeta"]

    # Later call with different order / extra tool: locked set wins (extra ignored).
    req2 = req.override(tools=[_tool("zeta"), _tool("newbie"), _tool("alpha")])
    out2 = mw._patch_request(req2)
    assert [t.name for t in out2.tools] == ["alpha", "zeta"]
    assert "newbie" not in [t.name for t in out2.tools]

    # Same payload twice: system+tools names stable
    names1 = [t.name for t in out1.tools]
    names2 = [t.name for t in mw._patch_request(req.override(tools=[_tool("mid"), _tool("zeta"), _tool("alpha")])).tools]
    assert names1 == names2 == ["alpha", "mid", "zeta"]
