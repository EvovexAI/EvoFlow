"""Regression: resume-only LangGraph commands must not set goto=None."""

from __future__ import annotations

from evoflow.langgraph_api_command_patch import apply_langgraph_command_patch


def test_map_cmd_resume_uses_empty_goto_tuple() -> None:
    apply_langgraph_command_patch()
    from langgraph_api.command import map_cmd

    cmd = map_cmd({"resume": {"action": "execute_approved", "tool_call_ids": ["call_1"]}})
    assert cmd.goto == ()
    assert cmd.goto is not None
    assert cmd.resume == {"action": "execute_approved", "tool_call_ids": ["call_1"]}


def test_control_branch_accepts_resume_only_command() -> None:
    apply_langgraph_command_patch()
    from langgraph.graph.state import _control_branch
    from langgraph_api.command import map_cmd

    cmd = map_cmd({"resume": {"action": "await_next"}})
    assert _control_branch(cmd) == []
