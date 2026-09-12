from __future__ import annotations

from evoflow.config.agents_config import (
    merge_skill_allowlist_with_preferred,
    parse_preferred_skills_from_context,
    resolve_skill_allowlist_for_lead_prompt,
)
from evoflow.config.agents_config import AgentConfig


def test_parse_preferred_skills_from_context_list_and_single() -> None:
    assert parse_preferred_skills_from_context({"preferred_skills": ["wechat-chat", "pdf"]}) == [
        "wechat-chat",
        "pdf",
    ]
    assert parse_preferred_skills_from_context({"preferred_skill": "wechat-chat"}) == ["wechat-chat"]
    assert parse_preferred_skills_from_context({}) == []


def test_merge_skill_allowlist_with_preferred_filters_unknown(monkeypatch) -> None:
    monkeypatch.setattr(
        "evoflow.config.agent_resource_validation.valid_skill_names",
        lambda enabled_only=True: {"wechat-chat", "deep-research"},
    )
    base = resolve_skill_allowlist_for_lead_prompt(
        AgentConfig(agent_code="main", skills=["deep-research"]),
    )
    merged = merge_skill_allowlist_with_preferred(base, ["wechat-chat", "missing-skill"])
    assert merged == {"deep-research", "wechat-chat"}


def test_merge_into_empty_role_allowlist(monkeypatch) -> None:
    monkeypatch.setattr(
        "evoflow.config.agent_resource_validation.valid_skill_names",
        lambda enabled_only=True: {"wechat-chat"},
    )
    base = resolve_skill_allowlist_for_lead_prompt(AgentConfig(agent_code="main", skills=[]))
    assert base == set()
    merged = merge_skill_allowlist_with_preferred(base, ["wechat-chat"])
    assert merged == {"wechat-chat"}
