from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from evoflow.config.tool_results_config import ToolResultsConfig, set_tool_results_config
from evoflow.context import tool_history_merge as merge_mod
from evoflow.context.tool_history_merge import (
    ToolRoundEntry,
    apply_cold_zone_policy,
    format_tool_history_batch,
)
from evoflow.context.tool_result_summarizer import TOOL_HISTORY_PREFIX


def _big_tool(call_id: str, name: str = "grep") -> ToolMessage:
    return ToolMessage(content="x" * 3000, tool_call_id=call_id, name=name)


def test_batch_merge_two_tools_one_block():
    set_tool_results_config(
        ToolResultsConfig(
            enabled=True,
            history_summarize_enabled=True,
            history_merge_enabled=True,
            history_merge_min_tools=2,
            history_merge_min_tokens=500,
            history_merge_cooldown_seconds=5.0,
            llm_summary_enabled=False,
        )
    )
    merge_mod._last_merge_at.pop("t-merge", None)
    messages = [
        HumanMessage(content="start"),
        AIMessage(content="", tool_calls=[{"id": "a1", "name": "web_fetch", "args": {"url": "https://a"}}]),
        _big_tool("a1", "web_fetch"),
        AIMessage(content="", tool_calls=[{"id": "a2", "name": "web_fetch", "args": {"url": "https://b"}}]),
        _big_tool("a2", "web_fetch"),
        AIMessage(content="", tool_calls=[{"id": "a3", "name": "bash", "args": {}}]),
        _big_tool("a3", "bash"),
    ]
    merged, candidates = apply_cold_zone_policy(messages, boundary=5, thread_id="t-merge")
    assert merged is not None
    assert len(candidates) == 2
    history_msgs = [m for m in merged if isinstance(m, HumanMessage) and TOOL_HISTORY_PREFIX in str(m.content)]
    assert len(history_msgs) == 1
    tool_bodies = [m for m in merged if isinstance(m, ToolMessage)]
    assert len(tool_bodies) == 1
    assert tool_bodies[0].tool_call_id == "a3"


def test_batch_merge_not_blocked_by_merge_cooldown():
    set_tool_results_config(
        ToolResultsConfig(
            enabled=True,
            history_summarize_enabled=True,
            history_merge_enabled=True,
            history_merge_min_tools=2,
            history_merge_min_tokens=500,
            history_merge_cooldown_seconds=60.0,
            llm_summary_enabled=False,
        )
    )
    merge_mod._last_merge_at["t-cd"] = __import__("time").monotonic()
    messages = [
        HumanMessage(content="start"),
        AIMessage(content="", tool_calls=[{"id": "a1", "name": "grep", "args": {}}]),
        _big_tool("a1", "grep"),
        AIMessage(content="", tool_calls=[{"id": "a2", "name": "grep", "args": {}}]),
        _big_tool("a2", "grep"),
        AIMessage(content="", tool_calls=[{"id": "a3", "name": "bash", "args": {}}]),
        _big_tool("a3", "bash"),
    ]
    merged, _ = apply_cold_zone_policy(messages, boundary=5, thread_id="t-cd")
    assert merged is not None
    assert any(TOOL_HISTORY_PREFIX in str(m.content) for m in merged if isinstance(m, HumanMessage))


def test_batch_merge_shaped_tools_below_token_floor():
    """Per-tool [tool:summary] is tiny; cold batch merge must still collapse rounds."""
    set_tool_results_config(
        ToolResultsConfig(
            enabled=True,
            history_summarize_enabled=True,
            history_merge_enabled=True,
            history_merge_min_tools=2,
            history_merge_min_tokens=2500,
            history_merge_cooldown_seconds=5.0,
            llm_summary_enabled=False,
        )
    )
    merge_mod._last_merge_at.pop("t-shaped", None)
    shaped = "[tool:summary] tool=grep\npath: /a\nstatus: ok\ncore: found hits\n"
    messages = [
        HumanMessage(content="start"),
        AIMessage(content="", tool_calls=[{"id": "a1", "name": "grep", "args": {"pattern": "x"}}]),
        ToolMessage(content=shaped, tool_call_id="a1", name="grep"),
        AIMessage(content="", tool_calls=[{"id": "a2", "name": "grep", "args": {"pattern": "y"}}]),
        ToolMessage(content=shaped, tool_call_id="a2", name="grep"),
        AIMessage(content="", tool_calls=[{"id": "a3", "name": "bash", "args": {}}]),
        ToolMessage(content=shaped, tool_call_id="a3", name="bash"),
    ]
    merged, candidates = apply_cold_zone_policy(messages, boundary=5, thread_id="t-shaped")
    assert merged is not None
    assert len(candidates) == 2
    history_msgs = [m for m in merged if isinstance(m, HumanMessage) and TOOL_HISTORY_PREFIX in str(m.content)]
    assert len(history_msgs) == 1
    assert len([m for m in merged if isinstance(m, ToolMessage)]) == 1


def test_prune_boundary_six_tools_keeps_three_hot_merges_three_cold():
    from evoflow.agents.middlewares.tool_history_ager_middleware import _prune_boundary

    set_tool_results_config(
        ToolResultsConfig(
            enabled=True,
            history_merge_min_tools=1,
            history_keep_full_tools=3,
            history_tail_token_budget=50_000,
        )
    )
    shaped = "[tool:summary] tool=grep\ncore: x\n"
    messages = [HumanMessage(content="start")]
    for i in range(6):
        tid = f"a{i}"
        messages.append(AIMessage(content="", tool_calls=[{"id": tid, "name": "grep", "args": {}}]))
        messages.append(ToolMessage(content=shaped, tool_call_id=tid, name="grep"))
    boundary = _prune_boundary(messages, keep_full_tools=3, token_budget=50_000)
    prefix_tools = [m for m in messages[:boundary] if isinstance(m, ToolMessage)]
    suffix_tools = [m for m in messages[boundary:] if isinstance(m, ToolMessage)]
    assert len(prefix_tools) == 3
    assert len(suffix_tools) == 3


def test_batch_merge_all_cold_tools_when_many_rounds():
    set_tool_results_config(
        ToolResultsConfig(
            enabled=True,
            history_summarize_enabled=True,
            history_merge_enabled=True,
            history_merge_min_tools=1,
            history_merge_min_tokens=2500,
            history_merge_cooldown_seconds=5.0,
            history_keep_full_tools=3,
            llm_summary_enabled=False,
        )
    )
    merge_mod._last_merge_at.pop("t-many", None)
    shaped = "[tool:summary] tool=grep\ncore: hit\n"
    messages = [HumanMessage(content="start")]
    for i in range(8):
        tid = f"t{i}"
        messages.append(AIMessage(content="", tool_calls=[{"id": tid, "name": "grep", "args": {}}]))
        messages.append(ToolMessage(content=shaped, tool_call_id=tid, name="grep"))
    from evoflow.agents.middlewares.tool_history_ager_middleware import _prune_boundary

    boundary = _prune_boundary(messages, keep_full_tools=3, token_budget=50_000)
    merged, candidates = apply_cold_zone_policy(messages, boundary=boundary, thread_id="t-many")
    assert merged is not None
    assert len(candidates) == 5
    history_msgs = [m for m in merged if isinstance(m, HumanMessage) and TOOL_HISTORY_PREFIX in str(m.content)]
    assert len(history_msgs) == 1
    assert "merged_tools=5" in history_msgs[0].content
    assert len([m for m in merged if isinstance(m, ToolMessage)]) == 3


def test_format_tool_history_batch():
    body = format_tool_history_batch(
        [
            ToolRoundEntry(
                tool_name="read_file",
                tool_call_id="a1",
                content="[tool:summary] tool=read_file\ncore: read auth module",
                token_estimate=1000,
                tool_index=2,
            ),
            ToolRoundEntry(
                tool_name="grep",
                tool_call_id="a2",
                content="[tool:summary] tool=grep\ncore: found 3 hits",
                token_estimate=1000,
                tool_index=4,
            ),
        ]
    )
    assert body.startswith(TOOL_HISTORY_PREFIX)
    assert "merged_tools=2" in body
    assert "read_file" in body
