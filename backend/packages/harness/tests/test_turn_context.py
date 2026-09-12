from langchain.agents.middleware.types import ModelRequest
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage

from evoflow.agents.lead_agent.turn_context import (
    build_turn_context_section,
    extract_last_assistant_preview,
)
from evoflow.agents.middlewares.turn_context_middleware import _patch_request
from evoflow.config.tool_results_config import ToolResultsConfig


def test_extract_last_assistant_before_latest_human():
    msgs = [
        HumanMessage(content="first"),
        AIMessage(content="answer one"),
        HumanMessage(content="second question"),
    ]
    assert extract_last_assistant_preview(msgs) == "answer one"


def test_build_turn_context_section_disabled():
    block = build_turn_context_section(
        user_question="fix the bug",
        last_assistant_summary="I will check tests.",
        prompt_language="zh",
    )
    assert block == ""


def test_turn_context_middleware_strips_legacy_block():
    req = ModelRequest(
        model=None,
        messages=[],
        tools=[],
        state={
            "messages": [
                HumanMessage(content="hi"),
                AIMessage(content="prev"),
                HumanMessage(content="new ask"),
            ]
        },
        runtime=type("R", (), {"context": {"prompt_language": "en"}})(),
        system_message=SystemMessage(content="<turn_context>\nold\n</turn_context>\n\nbase"),
    )
    out = _patch_request(req)
    text = out.system_message.content or ""
    assert "old" not in text
    assert "<turn_context>" not in text
    assert text.strip() == "base"


def test_tool_results_llm_summary_default_on():
    assert ToolResultsConfig().llm_summary_enabled is True
