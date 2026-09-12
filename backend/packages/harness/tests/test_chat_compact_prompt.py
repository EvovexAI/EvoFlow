"""Chat-scenario compact system prompt (token reduction)."""

from __future__ import annotations

from evoflow.agents.lead_agent.prompt import (
    _build_tool_catalog_section,
    apply_prompt_template,
)


def _chat_prompt(**kwargs) -> str:
    defaults = dict(
        intent_hint="chat",
        include_memory=False,
        available_skills=set(),
        subagent_enabled=False,
        prompt_language="en",
    )
    defaults.update(kwargs)
    return apply_prompt_template(**defaults)


def test_pure_chat_uses_full_role_and_compact_style() -> None:
    text = _chat_prompt()
    assert "EvovexAI assistant" in text or "EvovexAI" in text
    assert "Sessions may include context, state" in text
    assert "## Communication style (EvovexAI)" not in text
    assert "Tone: professional, warm, practical" in text


def test_pure_chat_tool_catalog_omits_tool_names() -> None:
    deferred = ["automation", "browser_back", "web_search", "plan"]
    text = _chat_prompt(
        loaded_tool_names=["read_file"],
        all_tool_names=["read_file", *deferred],
    )
    assert "tools deferred" in text
    assert "automation, browser_back" not in text
    assert "web_search" not in text.split("<tools_not_in_request>")[1].split("</tools_not_in_request>")[0]


def test_workspace_scenario_uses_compact_tool_catalog() -> None:
    text = apply_prompt_template(
        intent_hint="workspace",
        include_memory=False,
        available_skills=set(),
        loaded_tool_names=["read_file"],
        all_tool_names=["read_file", "automation", "browser_back"],
        prompt_language="en",
    )
    assert "tools deferred" in text
    assert "automation, browser_back" not in text


def test_workspace_only_uses_compact_deferred_catalog() -> None:
    text = apply_prompt_template(
        intent_hint="workspace",
        include_memory=False,
        available_skills=set(),
        loaded_tool_names=["read_file"],
        all_tool_names=["read_file", "automation", "browser_back"],
        prompt_language="en",
    )
    not_bound = text.split("<tools_not_in_request>")[1].split("</tools_not_in_request>")[0]
    assert "tools deferred" in not_bound
    assert "0 tools deferred" not in not_bound
    assert "automation" not in not_bound
    assert "browser_back" not in not_bound


def test_pure_chat_omits_subagent_focus_mode() -> None:
    text = _chat_prompt()
    assert "<subagent_focus_mode>" not in text


def test_tool_catalog_compact_section_direct() -> None:
    section = _build_tool_catalog_section(
        ["read_file"],
        all_tool_names=["read_file", "automation", "browser_back"],
        compact=True,
        active_scenarios=["agent"],
    )
    not_bound = section.split("<tools_not_in_request>")[1].split("</tools_not_in_request>")[0]
    assert "tools deferred" in not_bound
    assert "0 tools deferred" not in not_bound
    assert "automation" not in section
    assert "browser_back" not in section


def test_empty_memory_shell_not_injected() -> None:
    text = _chat_prompt(include_memory=True)
    assert "<turn_context>" not in text
    assert "<context_discovery>" not in text
    assert "<file_delivery>" not in text
    if "ref memory" in text or "memory: reference only" in text or "MEMORY CONTENT" in text:
        assert "<memory>" in text


def test_workspace_block_order_memory_after_workspace() -> None:
    text = _chat_prompt(include_memory=True)
    if "<memory>" in text:
        assert text.index("<workspace>") < text.index("<memory>")


def test_compact_workspace_omits_web_search_date_note() -> None:
    text = _chat_prompt()
    assert "Web search & dates" not in text
