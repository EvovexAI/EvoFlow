"""Medium-tier tool shaping: full inline body; shaped cache still upgrades ToolMessages."""

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from evoflow.agents.middlewares.tool_shaped_cache_middleware import apply_shaped_cache_to_messages
from evoflow.config.tool_results_config import ToolResultsConfig, set_tool_results_config
from evoflow.context.shaped_tool_cache import remember_shaped
from evoflow.tools.tool_result_shaper import shape_tool_result


def test_shape_medium_returns_full_body_without_background_queue():
    set_tool_results_config(
        ToolResultsConfig(
            enabled=True,
            use_token_tiers=True,
            tier_small_tokens=100,
            tier_medium_tokens=10_000,
            threshold_chars=50_000,
            llm_summary_enabled=True,
            medium_background_llm=True,
            llm_summary_tool_names=["grep"],
        )
    )
    body = "line\n" * 400
    out = shape_tool_result(body, "grep", "tc-bg", thread_id="thread-bg")
    assert out == body
    assert "[tool:summary]" not in out


def test_apply_shaped_cache_upgrades_tool_message():
    set_tool_results_config(ToolResultsConfig(enabled=True))
    tid = "t-cache"
    cid = "call-1"
    placeholder = "[tool:summary] tool=grep\ncore: placeholder"
    upgraded = "[tool:summary] tool=grep\ncore: richer background summary"
    remember_shaped(tid, cid, upgraded)
    messages = [
        HumanMessage(content="hi"),
        AIMessage(content="", tool_calls=[{"id": cid, "name": "grep", "args": {}}]),
        ToolMessage(content=placeholder, tool_call_id=cid, name="grep"),
    ]
    patched = apply_shaped_cache_to_messages(messages, thread_id=tid)
    assert patched is not None
    assert patched[2].content == upgraded
