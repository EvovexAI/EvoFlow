"""IM-only system prompt: <im_channel> gated; Panel chats stay clean."""

from __future__ import annotations

from evoflow.agents.lead_agent.prompt import (
    _assemble_system_prompt,
    resolve_im_channel_for_prompt,
)
from evoflow.agents.lead_agent.prompt_blocks import get_static_blocks


def test_resolve_im_channel_from_stamped_name():
    assert resolve_im_channel_for_prompt(im_channel="feishu") == "feishu"
    assert resolve_im_channel_for_prompt(im_channel="WeCom") == "wecom"
    assert resolve_im_channel_for_prompt(im_channel="panel") == ""
    assert resolve_im_channel_for_prompt(im_channel="") == ""
    assert resolve_im_channel_for_prompt() == ""


def test_resolve_im_channel_ignores_session_key_alone():
    # Opening an IM thread in Panel must not inject <im_channel> without a stamp.
    assert resolve_im_channel_for_prompt(session_key="agent:main:feishu:oc_x") == ""
    assert resolve_im_channel_for_prompt(im_channel=None, session_key="anything") == ""


def test_assemble_skips_artifact_and_adds_im_block_when_im():
    zh = get_static_blocks("zh")
    base_kwargs = dict(
        scenario="ask",
        agent_name="EvoFlow",
        soul="",
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
    panel = _assemble_system_prompt(**base_kwargs, im_channel="")
    im = _assemble_system_prompt(**base_kwargs, im_channel="feishu")

    assert "<artifact_display>" in panel
    assert "<im_channel>" not in panel
    assert "不要使用 Markdown" not in panel

    assert "<artifact_display>" not in im
    assert "<im_channel>" in im
    assert "channels.send_message" in im
    assert "不要使用 Markdown" in im
    assert zh.IM_CHANNEL_REPLY_BLOCK.strip() in im


def test_assemble_en_im_block():
    prompt = _assemble_system_prompt(
        scenario="ask",
        agent_name="EvoFlow",
        soul="",
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
        runtime_os="macOS",
        runtime_shell="zsh",
        runtime_now="now",
        runtime_host_hint="",
        collab_phase_section="",
        plan_runtime_stage_section="",
        active_scenario_keys=["ask"],
        subagent_enabled=False,
        bootstrap_mode=False,
        prompt_language="en",
        im_channel="slack",
    )
    assert "<im_channel>" in prompt
    assert "Do not use Markdown" in prompt
    assert "<artifact_display>" not in prompt
