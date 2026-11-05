"""create_agent tool: omit tools/mcp/skills → empty allowlist (not inherit-all)."""

from __future__ import annotations

import json
import uuid
from types import SimpleNamespace

import pytest

from evoflow.admin.agents import delete_agent, get_agent
from evoflow.config.agents_config import load_agent_config
from evoflow.tools.builtins.create_agent_tool import create_agent_tool


def _runtime():
    return SimpleNamespace(context={}, config={})


async def _call(**kwargs):
    # Call underlying coroutine — StructuredTool.ainvoke needs full ToolCall for InjectedToolCallId.
    raw = await create_agent_tool.coroutine(
        runtime=_runtime(),
        tool_call_id="t1",
        **kwargs,
    )
    return json.loads(raw) if isinstance(raw, str) else raw


@pytest.mark.asyncio
async def test_create_agent_tool_omit_tools_is_empty_allowlist() -> None:
    code = f"tool-omit-{uuid.uuid4().hex[:8]}"
    try:
        out = await _call(
            agent_code=code,
            agent_name="Omit Via Tool",
            agent_type="custom",
            description="omit bindings",
        )
        assert out.get("success") is True, out
        assert out.get("tools") == []
        assert out.get("mcp_servers") == []
        assert out.get("skills") == []
        assert out.get("bindings_applied", {}).get("tools_mode") == "empty"

        cfg = load_agent_config(code)
        assert cfg.tools == []
        assert cfg.mcp_servers == []
        assert cfg.skills == []
        # None would mean inherit-all — must not happen on omit.
        assert cfg.tools is not None
        assert cfg.mcp_servers is not None

        row = get_agent(code)
        assert row.get("tools") == []
        assert row.get("mcp_servers") == []
    finally:
        try:
            delete_agent(code, keep_employee=True)
        except Exception:
            pass


@pytest.mark.asyncio
async def test_create_agent_tool_explicit_empty_lists() -> None:
    code = f"tool-list-{uuid.uuid4().hex[:8]}"
    try:
        out = await _call(
            agent_code=code,
            agent_name="Empty List Via Tool",
            agent_type="custom",
            tools=[],
            mcp_servers=[],
            skills=[],
        )
        assert out.get("success") is True, out
        assert out.get("bindings_applied", {}).get("tools_mode") == "empty"
        cfg = load_agent_config(code)
        assert cfg.tools == []
        assert cfg.mcp_servers == []
    finally:
        try:
            delete_agent(code, keep_employee=True)
        except Exception:
            pass
