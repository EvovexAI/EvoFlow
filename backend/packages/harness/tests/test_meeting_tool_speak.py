"""Meeting verify tools (read-only) — no live LLM."""

from __future__ import annotations

from types import SimpleNamespace

from evoflow.a2a.meeting_tool_speak import _run_tool, build_meeting_verify_tools


def test_build_meeting_verify_tools_names() -> None:
    role = SimpleNamespace(agent_code="demo-bot", role_name="Demo", config=SimpleNamespace())
    tools = build_meeting_verify_tools(agent_code="demo-bot", role=role)
    names = {t.name for t in tools}
    assert names == {"lookup_my_tasks", "search_my_assets", "read_my_asset"}


def test_run_unknown_tool() -> None:
    role = SimpleNamespace(agent_code="demo-bot", role_name="Demo", config=SimpleNamespace())
    tools = build_meeting_verify_tools(agent_code="demo-bot", role=role)
    assert "未知工具" in _run_tool(tools, "write_soul", {})
