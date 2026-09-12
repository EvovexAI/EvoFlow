"""Background LLM jobs from ToolHistoryAgerMiddleware must not duplicate shaped tools."""

from __future__ import annotations

from evoflow.agents.middlewares.tool_history_ager_middleware import _background_jobs_for_candidates
from evoflow.config.tool_results_config import ToolResultsConfig, set_tool_results_config
from evoflow.context.tool_history_merge import ToolRoundEntry


def test_background_jobs_skip_already_shaped_content():
    set_tool_results_config(
        ToolResultsConfig(
            enabled=True,
            history_background_llm=True,
            llm_summary_enabled=True,
            tier_small_tokens=100,
        )
    )
    shaped = "[tool:summary] tool=grep\npath: foo\nstatus: ok\ncore: done\n"
    candidates = [
        ToolRoundEntry(
            tool_name="grep",
            tool_call_id="c-shaped",
            content=shaped,
            raw_content=shaped,
            token_estimate=500,
        ),
        ToolRoundEntry(
            tool_name="grep",
            tool_call_id="c-raw",
            content="x" * 2000,
            raw_content="x" * 2000,
            token_estimate=500,
        ),
    ]
    jobs = _background_jobs_for_candidates("t1", candidates)
    assert len(jobs) == 1
    assert jobs[0].tool_call_id == "c-raw"
