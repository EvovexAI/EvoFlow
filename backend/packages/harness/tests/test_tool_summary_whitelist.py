"""LLM tool-summary whitelist."""

from evoflow.config.tool_results_config import (
    ToolResultsConfig,
    set_tool_results_config,
    tool_uses_llm_summary,
)
from evoflow.context.tool_result_summarizer import summarize_tool_result_sync


def test_whitelist_defaults():
    # ``llm_summary_enabled`` defaults to False — explicitly enable so the
    # whitelist gate (``tool_uses_llm_summary``) actually inspects the tool name.
    set_tool_results_config(ToolResultsConfig(llm_summary_enabled=True))
    assert tool_uses_llm_summary("web_search") is True
    assert tool_uses_llm_summary("search_code_index") is True
    assert tool_uses_llm_summary("read_file") is False
    assert tool_uses_llm_summary("bash") is False


def test_summarize_skips_non_whitelist_without_llm_call():
    set_tool_results_config(
        ToolResultsConfig(
            llm_summary_enabled=True,
            llm_summary_tool_names=["web_search"],
        )
    )
    assert summarize_tool_result_sync("x" * 5000, "read_file") is None
