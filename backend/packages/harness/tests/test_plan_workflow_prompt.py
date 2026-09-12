"""Plan workflow system block is injected when plan scenario is active."""

from __future__ import annotations

from evoflow.agents.lead_agent.prompt import apply_prompt_template
from evoflow.tools.builtins.plan_tool import plan_tool


def test_plan_scenario_injects_plan_workflow() -> None:
    prompt = apply_prompt_template(
        intent_hint="plan",
        loaded_tool_names=["plan", "supervisor", "subagent", "ask_clarification", "list_agents"],
        all_tool_names=["plan", "supervisor", "subagent", "ask_clarification", "list_agents"],
        prompt_language="zh",
        include_memory=False,
        collab_phase="planning",
    )
    assert "<plan_workflow>" in prompt
    assert "## 0 流程" in prompt or "流程（按序）" in prompt
    assert "monitor_execution_step" in prompt
    assert "自动派发" in prompt or "auto-dispatch" in prompt.lower() or "自动派发首波" in prompt
    assert "<phase_execution_guard>" in prompt


def test_ask_scenario_omits_plan_workflow() -> None:
    prompt = apply_prompt_template(
        intent_hint="ask",
        loaded_tool_names=["read"],
        all_tool_names=["read"],
        prompt_language="zh",
        include_memory=False,
    )
    assert "<plan_workflow>" not in prompt


def test_plan_tool_guide_keeps_full_preconditions() -> None:
    desc = str(getattr(plan_tool, "description", "") or "")
    assert "调用前置条件" in desc or "三项" in desc
    assert "flowchart_mermaid" in desc
    assert "subagent" in desc
    assert len(desc) > 800


# ── Regression: WORKSPACE_BLOCK_TEMPLATE literal braces must not KeyError ──
# Bug: `_assemble_system_prompt` crashed with
#   KeyError: 'type, path|url|content, name?'
# because WORKSPACE_BLOCK_TEMPLATE contained an un-escaped `{type, ...}` that
# `str.format(...)` treated as a named placeholder. Guard it here.


def test_workspace_template_formats_without_keyerror() -> None:
    from evoflow.agents.lead_agent.prompt_blocks_zh import WORKSPACE_BLOCK_TEMPLATE

    out = WORKSPACE_BLOCK_TEMPLATE.format(
        workspace_root_hint="D:/workspace",
        runtime_os="Windows",
        runtime_shell="PowerShell",
        runtime_host_hint="",
    )
    # Literal text must survive rendering as a single-brace annotation.
    assert "data.items=[{type, path|url|content, name?}]" in out


def test_apply_prompt_template_does_not_crash_on_workspace_braces() -> None:
    """Full assembly path (covers _assemble_system_prompt) must not raise KeyError."""
    prompt = apply_prompt_template(
        intent_hint="ask",
        loaded_tool_names=["panel_set", "read"],
        all_tool_names=["panel_set", "read"],
        prompt_language="zh",
        include_memory=False,
    )
    assert isinstance(prompt, str) and len(prompt) > 0
