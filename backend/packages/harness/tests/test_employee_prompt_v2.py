"""Employee chat system prompt v2 skeleton."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import patch

from evoflow.proactive.employee_prompt import (
    build_employee_chat_system_prompt,
    build_employee_identity_block,
    is_employee_chat_session,
)


def _fake_role(**kwargs):
    defaults = {
        "agent_code": "evoflow-fullstack-lead",
        "role_name": "EvoFlow全栈工程师",
        "department": "工程",
        "status": "active",
        "config": SimpleNamespace(
            responsibilities=["修 bug", "加功能"],
            workspace_path="D:/dev/github/evoflow",
            department="工程",
        ),
    }
    defaults.update(kwargs)
    return SimpleNamespace(**defaults)


def test_normalize_strips_task_session_suffix():
    from evoflow.proactive.employee_prompt import _normalize_employee_agent_code

    assert (
        _normalize_employee_agent_code(
            "proactive:evoflow-fullstack-lead:task:2608280500_e6e3"
        )
        == "evoflow-fullstack-lead"
    )
    assert (
        _normalize_employee_agent_code("evoflow-fullstack-lead:task:2608280500_e6e3")
        == "evoflow-fullstack-lead"
    )


def test_build_employee_chat_v2_structure():
    identity = {
        "code": "evoflow-fullstack-lead",
        "role_name": "EvoFlow全栈工程师",
        "department": "工程",
        "responsibilities": ["修 bug", "加功能"],
        "workspace_path": "D:/dev/github/evoflow",
        "status": "active",
    }
    prompt = build_employee_chat_system_prompt(
        identity=identity,
        soul="只改 EvoFlow 仓库内的代码。",
        skills_section="<available_skills>\n</available_skills>",
        workspace_root_hint="D:/dev/github/evoflow",
        runtime_os="Windows",
        runtime_shell="PowerShell",
        runtime_now="2026-08-28",
        user_profile_block="<user_profile>\n<basic_info>\n测试用户\n</basic_info>\n</user_profile>",
        loaded_tool_names=["bash", "panel_set"],
    )
    assert "<employee" not in prompt
    assert 'version="2"' not in prompt
    assert "<identity>" in prompt
    assert "EvoFlow全栈工程师" in prompt
    assert "agent_code=`evoflow-fullstack-lead`" in prompt
    assert ":task:" not in prompt
    assert "2608280500_e6e3" not in prompt
    assert "<stance>" not in prompt
    assert "禁止自称" not in prompt
    assert "<communication>" in prompt
    assert "panel_set" not in prompt  # lives on tool description only
    assert "<contract>" in prompt
    assert "修 bug" in prompt
    assert "<habits>" in prompt
    assert "<skills>" in prompt
    assert "<workspace>" in prompt
    assert "<user_profile>" in prompt
    assert "测试用户" in prompt
    assert "<context_priority>" in prompt
    assert "用户画像" in prompt
    # No stacked generic assistant role / legacy framing
    assert "<role>" not in prompt
    assert "EvoFlow助手" not in prompt
    assert "<employee_posting>" not in prompt
    assert "<employee_chat_frame" not in prompt
    assert prompt.count("你是「EvoFlow全栈工程师」") == 1


def test_panel_set_never_in_employee_system_prompt():
    identity = {
        "code": "evoflow-fullstack-lead",
        "role_name": "EvoFlow全栈工程师",
        "department": "工程",
        "responsibilities": [],
        "workspace_path": "",
    }
    for tools in (["bash", "assets"], ["bash", "panel_set"]):
        prompt = build_employee_chat_system_prompt(
            identity=identity,
            user_profile_block="<user_profile></user_profile>",
            loaded_tool_names=tools,
        )
        assert "panel_set" not in prompt
        assert "web-embed" not in prompt


def test_identity_block_no_dirty_code():
    block = build_employee_identity_block(
        {
            "code": "code-agent",
            "role_name": "代码助手",
            "department": "",
            "responsibilities": [],
        }
    )
    assert "代码助手" in block
    assert "agent_code=`code-agent`" in block


def test_is_employee_chat_session_with_task_key():
    role = _fake_role()
    with patch(
        "evoflow.proactive.repositories.ProactiveRepository.get_role",
        return_value=role,
    ):
        ok, info = is_employee_chat_session(
            "proactive:evoflow-fullstack-lead:task:2608280500_e6e3",
            "evoflow-fullstack-lead",
        )
    assert ok is True
    assert info is not None
    assert info["code"] == "evoflow-fullstack-lead"
    assert info["role_name"] == "EvoFlow全栈工程师"


def test_is_employee_chat_session_rejects_main_and_xiaomi():
    assert is_employee_chat_session("thread-abc", "main")[0] is False
    with patch(
        "evoflow.proactive.repositories.ProactiveRepository.get_role",
        return_value=_fake_role(agent_code="xiaomi", role_name="小V"),
    ):
        # xiaomi filtered before role lookup via is_xiaomi_agent
        ok, _ = is_employee_chat_session("proactive:xiaomi:chat:stamp", "xiaomi")
    assert ok is False


def test_apply_prompt_template_employee_chat_v2():
    from evoflow.agents.lead_agent.prompt import apply_prompt_template

    role = _fake_role()
    with (
        patch(
            "evoflow.proactive.repositories.ProactiveRepository.get_role",
            return_value=role,
        ),
        patch(
            "evoflow.agents.lead_agent.prompt._load_agent_soul_text",
            return_value="专职负责 EvoFlow。",
        ),
        patch(
            "evoflow.agents.lead_agent.prompt.get_skills_prompt_section",
            return_value="",
        ),
        patch(
            "evoflow.agents.lead_agent.prompt._get_memory_context",
            return_value="",
        ),
        patch(
            "evoflow.assets.profile_injection.build_user_profile_injection_block",
            return_value="<user_profile>\n<basic_info>\n用户甲\n</basic_info>\n</user_profile>",
        ),
    ):
        prompt = apply_prompt_template(
            agent_name="evoflow-fullstack-lead",
            session_key="proactive:evoflow-fullstack-lead:task:2608280500_e6e3",
            available_skills=set(),
            intent_hint="chat",
            prompt_language="zh",
            include_memory=False,
            loaded_tool_names=["bash", "panel_set"],
        )
    assert "<employee" not in prompt
    assert "EvoFlow全栈工程师" in prompt
    assert "agent_code=`evoflow-fullstack-lead`" in prompt
    assert ":task:" not in prompt
    assert "<role>" not in prompt
    assert "EvoFlow助手" not in prompt
    assert "<employee_posting>" not in prompt
    assert "<employee_chat_frame" not in prompt
    assert "<stance>" not in prompt
    assert "<user_profile>" in prompt
    assert "用户甲" in prompt
    assert "panel_set" not in prompt


def test_apply_prompt_template_main_unchanged_has_role():
    from evoflow.agents.lead_agent.prompt import apply_prompt_template

    prompt = apply_prompt_template(
        agent_name="main",
        available_skills=set(),
        intent_hint="chat",
        prompt_language="zh",
        include_memory=False,
    )
    assert "<role>" in prompt
    assert "<identity>" not in prompt or "agent_code=`evoflow-fullstack-lead`" not in prompt
