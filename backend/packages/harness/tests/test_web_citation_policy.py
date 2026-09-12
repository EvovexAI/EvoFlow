"""Web citation policy lives on web tool schemas, not system prompt."""

from __future__ import annotations

from evoflow.community.baidu_search import web_search_tool
from evoflow.community.web_fetch.tools import web_fetch_tool
from evoflow.tools import get_available_tools
from evoflow.tools.host_direct.web_fetch import web_fetch_hd


def test_web_search_tool_includes_citation_policy() -> None:
    get_available_tools(include_search=True)  # applies citation policy hooks
    desc = str(getattr(web_search_tool, "description", "") or "")
    assert "Citation policy:" in desc
    assert "cite sources" in desc.lower()


def test_web_fetch_tools_include_citation_policy() -> None:
    get_available_tools(include_search=True)
    for tool in (web_fetch_tool, web_fetch_hd):
        desc = str(getattr(tool, "description", "") or "")
        assert "Citation policy:" in desc


def test_agent_prompt_omits_web_citation_policy_block() -> None:
    from evoflow.agents.lead_agent.prompt import apply_prompt_template

    text = apply_prompt_template(
        intent_hint="agent",
        include_memory=False,
        available_skills=set(),
        prompt_language="en",
    )
    assert "<web_citation_policy>" not in text
