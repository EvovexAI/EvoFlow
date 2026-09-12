from evoflow.config.tool_results_config import ToolResultsConfig, set_tool_results_config
from evoflow.context.shaped_tool_cache import get_shaped
from evoflow.context.tool_history_ager_queue import ToolSummaryJob, get_tool_history_summary_queue


def test_background_queue_writes_cache(monkeypatch):
    set_tool_results_config(
        ToolResultsConfig(
            enabled=True,
            history_summarize_enabled=True,  # required: ToolHistorySummaryQueue.enqueue gates on this
            history_background_llm=True,
            history_background_debounce_seconds=0.5,
            llm_summary_enabled=True,
            tier_small_tokens=100,
        )
    )

    async def fake_async(content: str, tool_name: str) -> str:
        return f"[tool:summary] tool={tool_name}\ncore: llm-refined\n"

    monkeypatch.setattr(
        "evoflow.context.tool_history_ager_queue.summarize_tool_result_async",
        fake_async,
    )

    q = get_tool_history_summary_queue()
    q.enqueue(
        [
            ToolSummaryJob(
                thread_id="t-bg",
                tool_call_id="c1",
                tool_name="grep",
                content="x" * 2000,
            )
        ]
    )
    q._run_processing()
    cached = get_shaped("t-bg", "c1")
    assert cached is not None
    assert "llm-refined" in cached
