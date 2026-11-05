"""Lead-agent identity layers: no triple restatement of who the agent is."""

from __future__ import annotations

from evoflow.agents.lead_agent.prompt import (
    _assemble_system_prompt,
    _normalize_prompt_body_for_dedupe,
)


def _base_kwargs(**overrides):
    kwargs = dict(
        scenario="ask",
        agent_name="EvoFlow",
        soul="",
        custom_system_prompt="",
        memory_context="",
        workspace_memory_context="",
        mission_state_section="",
        tool_catalog_section="",
        skills_section="",
        subagent_section="",
        trae_section="",
        worker_guidance_section="",
        task_router_section="",
        acp_section="",
        workspace_root_hint="/tmp",
        runtime_mode="local",
        runtime_os="Windows",
        runtime_shell="pwsh",
        runtime_now="now",
        runtime_host_hint="",
        collab_phase_section="",
        plan_runtime_stage_section="",
        active_scenario_keys=["ask"],
        subagent_enabled=False,
        bootstrap_mode=False,
        prompt_language="zh",
    )
    kwargs.update(overrides)
    return kwargs


def test_normalize_collapses_heading_and_bold_noise():
    a = "# EvoFlow\n\n你是用户的**默认主智能体**：改代码。"
    b = "EvoFlow\n你是用户的默认主智能体：改代码。"
    assert _normalize_prompt_body_for_dedupe(a) == _normalize_prompt_body_for_dedupe(b)


def test_near_duplicate_soul_and_system_prompt_inject_soul_once():
    body_soul = "EvoFlow\n\n你是用户的**默认主智能体**：可直接完成问答、改代码。"
    body_sp = "# EvoFlow\n\n你是用户的**默认主智能体**：可直接完成问答、改代码。"
    prompt = _assemble_system_prompt(
        **_base_kwargs(soul=body_soul, custom_system_prompt=body_sp)
    )
    assert prompt.count("<soul>") == 1
    assert "<agent_system_prompt>" not in prompt
    assert "默认主智能体" in prompt


def test_distinct_system_prompt_still_injected():
    prompt = _assemble_system_prompt(
        **_base_kwargs(
            soul="气质：务实。",
            custom_system_prompt="岗位职责：只做代码评审，不做实现。",
        )
    )
    assert "<soul>" in prompt
    assert "<agent_system_prompt>" in prompt
    assert "只做代码评审" in prompt
    assert prompt.index("<agent_system_prompt>") < prompt.index("<soul>")


def test_context_priority_says_memory_must_yield():
    prompt = _assemble_system_prompt(**_base_kwargs())
    assert "<context_priority>" in prompt
    assert "不得用旧约束改写本轮意图" in prompt
