from evoflow.config.tool_results_config import ToolResultsConfig, set_tool_results_config
from evoflow.tools.large_result_store import maybe_persist


def test_maybe_persist_returns_inline_when_offload_disabled():
    set_tool_results_config(
        ToolResultsConfig(
            enabled=True,
            threshold_chars=50_000,
            medium_threshold_chars=500,
            llm_summary_enabled=False,
        )
    )
    content = "x" * 800
    out = maybe_persist(content, "grep", "c1")
    assert out is content
