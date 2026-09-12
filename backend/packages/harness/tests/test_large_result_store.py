from evoflow.config.tool_results_config import ToolResultsConfig, set_tool_results_config
from evoflow.tools.large_result_store import maybe_persist


def test_maybe_persist_returns_inline_when_offload_disabled():
    set_tool_results_config(ToolResultsConfig(enabled=True, threshold_chars=1000, summary_max_chars=200))
    big = "line\n" * 800
    out = maybe_persist(big, "grep", "call-1")
    assert out is big
    assert "[ToolResult persisted" not in out
