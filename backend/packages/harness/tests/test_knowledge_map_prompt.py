"""Mind map policy lives on the tool — not in the system prompt."""

from evoflow.agents.lead_agent.prompt import (
    _build_knowledge_map_guidance_section,
    apply_prompt_template,
)
from evoflow.exploration_graph.mind_map_tool_description import MIND_MAP_TOOL_DESCRIPTION
from evoflow.tools.builtins.mind_map_tool import mind_map_tool


def test_knowledge_map_guidance_section_always_empty() -> None:
    from evoflow.exploration_graph.config import load_exploration_graph_config_from_dict

    load_exploration_graph_config_from_dict({"enabled": True})
    assert _build_knowledge_map_guidance_section(["mind_map"], prompt_language="zh") == ""
    assert _build_knowledge_map_guidance_section(["mind_map"], prompt_language="en") == ""
    assert _build_knowledge_map_guidance_section(["read", "rg"], prompt_language="zh") == ""


def test_mind_map_tool_description_carries_policy() -> None:
    low = MIND_MAP_TOOL_DESCRIPTION.lower()
    assert "orphan" in low
    assert "set_goal" in MIND_MAP_TOOL_DESCRIPTION
    assert "append_body" in MIND_MAP_TOOL_DESCRIPTION
    assert "claim:" in MIND_MAP_TOOL_DESCRIPTION
    assert "query=true" in low
    assert "prompt-cache" in low or "prompt cache" in low
    assert "auto-injected" in low
    assert len(MIND_MAP_TOOL_DESCRIPTION) < 3600
    desc = str(getattr(mind_map_tool, "description", "") or "")
    assert "set_goal" in desc
    assert "Placeholder turn" not in MIND_MAP_TOOL_DESCRIPTION
    assert "下一轮第一时间" not in MIND_MAP_TOOL_DESCRIPTION

def test_system_prompt_omits_mind_map_policy(monkeypatch) -> None:
    from evoflow.exploration_graph.config import load_exploration_graph_config_from_dict
    from evoflow.persistence import panel_settings as ps

    load_exploration_graph_config_from_dict({"enabled": True})
    monkeypatch.setattr(ps, "get_panel_settings", lambda: {"knowledgeMapEnabled": True})
    prompt = apply_prompt_template(
        loaded_tool_names=["read", "rg", "mind_map", "worker"],
        all_tool_names=["read", "rg", "mind_map", "worker"],
        intent_hint="agent",
        prompt_language="zh",
    )
    assert "<mind_map_policy>" not in prompt
    assert "每轮须并发 `mind_map`" not in prompt
    assert "TOOL_CALLING_MIND_MAP_RULE" not in prompt


def test_system_prompt_omits_mind_map_policy_when_disabled(monkeypatch) -> None:
    from evoflow.exploration_graph.config import load_exploration_graph_config_from_dict
    from evoflow.persistence import panel_settings as ps

    load_exploration_graph_config_from_dict({"enabled": True})
    monkeypatch.setattr(ps, "get_panel_settings", lambda: {"knowledgeMapEnabled": False})
    prompt = apply_prompt_template(
        loaded_tool_names=["read", "rg", "mind_map", "worker"],
        all_tool_names=["read", "rg", "mind_map", "worker"],
        intent_hint="agent",
        prompt_language="zh",
    )
    assert "<mind_map_policy>" not in prompt
    assert "每轮须并发 `mind_map`" not in prompt
