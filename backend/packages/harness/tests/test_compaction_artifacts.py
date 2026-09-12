"""Single conversation_summary and tool_history block invariants."""

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langgraph.graph.message import add_messages

from evoflow.agents.context_compaction_core import (
    MAIN_SUMMARY_PREFIX,
    CompactionPlan,
    apply_compaction_with_summary,
    dedupe_compaction_artifacts,
    partition_compaction_artifacts,
)
from evoflow.agents.middleware_state import replace_messages_in_state
from evoflow.context.tool_result_summarizer import TOOL_HISTORY_PREFIX


def test_partition_strips_prior_artifacts() -> None:
    msgs = [
        HumanMessage(content="start", id="h0"),
        HumanMessage(content=f"{MAIN_SUMMARY_PREFIX}\nold summary", name="conversation_summary", id="s1"),
        HumanMessage(content=f"{TOOL_HISTORY_PREFIX} merged_tools=2", name="tool_history", id="t1"),
        HumanMessage(content="recent", id="h1"),
        AIMessage(content="ok", id="a1"),
    ]
    stripped, summaries, tools = partition_compaction_artifacts(msgs)
    assert len(stripped) == 3
    assert len(summaries) == 1
    assert "old summary" in summaries[0]
    assert len(tools) == 1
    assert TOOL_HISTORY_PREFIX in tools[0]


def test_dedupe_keeps_first_summary_and_tool_history() -> None:
    msgs = [
        HumanMessage(content=f"{MAIN_SUMMARY_PREFIX}\none", name="conversation_summary"),
        HumanMessage(content=f"{TOOL_HISTORY_PREFIX} a=1", name="tool_history"),
        HumanMessage(content=f"{MAIN_SUMMARY_PREFIX}\ntwo", name="conversation_summary"),
        HumanMessage(content=f"{TOOL_HISTORY_PREFIX} b=2", name="tool_history"),
        HumanMessage(content="latest"),
    ]
    out = dedupe_compaction_artifacts(msgs)
    assert sum(1 for m in out if getattr(m, "name", None) == "conversation_summary") == 1
    assert sum(1 for m in out if getattr(m, "name", None) == "tool_history") == 1
    assert "one" in str(out[0].content)
    assert "a=1" in str(out[1].content)


def test_apply_compaction_does_not_duplicate_summary_in_head() -> None:
    working = [
        HumanMessage(content="head", id="h"),
        HumanMessage(content=f"{MAIN_SUMMARY_PREFIX}\nstale", name="conversation_summary", id="old"),
        HumanMessage(content="mid", id="m"),
        HumanMessage(content="tail", id="t"),
    ]
    plan = CompactionPlan(
        working=working,
        head_end=2,
        compress_end=3,
        middle=[working[2]],
        middle_tokens=10,
        original_count=4,
    )
    out = apply_compaction_with_summary(plan, f"{MAIN_SUMMARY_PREFIX}\nfresh")
    summaries = [m for m in out if getattr(m, "name", None) == "conversation_summary"]
    assert len(summaries) == 1
    assert "fresh" in str(summaries[0].content)
    assert any(str(getattr(m, "content", "")) == "head" for m in out)
    assert not any(str(getattr(m, "content", "")) == "mid" for m in out)
    assert any(str(getattr(m, "content", "")) == "tail" for m in out)


def test_apply_compaction_keeps_tool_history_summary_and_latest_user_turn() -> None:
    from evoflow.context.tool_result_summarizer import TOOL_HISTORY_PREFIX

    ai = AIMessage(content="", tool_calls=[{"name": "grep", "args": {"q": "x"}, "id": "call_1"}])
    tool = ToolMessage(content="hits", tool_call_id="call_1", name="grep")
    working = [
        HumanMessage(content="opening plan from long ago", id="h0"),
        HumanMessage(content="old user turn", id="h1"),
        AIMessage(content="old reply", id="a0"),
        HumanMessage(content=f"{TOOL_HISTORY_PREFIX} merged=2", name="tool_history", id="th"),
        HumanMessage(content="current user ask", id="h2"),
        ai,
        tool,
    ]
    plan = CompactionPlan(
        working=working,
        head_end=1,
        compress_end=4,
        middle=[working[1], working[2]],
        middle_tokens=100,
        original_count=len(working),
    )
    out = apply_compaction_with_summary(plan, f"{MAIN_SUMMARY_PREFIX}\nfolded context")
    names = [getattr(m, "name", None) for m in out]
    assert names[0] == "tool_history"
    summary_idx = next(i for i, n in enumerate(names) if n == "conversation_summary")
    pre_users = [m for m in out[:summary_idx] if getattr(m, "name", None) != "tool_history"]
    assert len(pre_users) == 2
    assert str(pre_users[0].content) == "opening plan from long ago"
    assert str(pre_users[1].content) == "old user turn"
    tail = out[summary_idx + 1 :]
    assert str(tail[0].content) == "current user ask"
    assert tail[1] is ai
    assert tail[2] is tool


def test_replace_messages_does_not_accumulate_summaries() -> None:
    old = [
        HumanMessage(content="u1", id="1"),
        HumanMessage(content=f"{MAIN_SUMMARY_PREFIX}\ns1", name="conversation_summary", id="s1"),
    ]
    new = [
        HumanMessage(content="u1", id="1"),
        HumanMessage(content=f"{MAIN_SUMMARY_PREFIX}\ns2", name="conversation_summary", id="s2"),
    ]
    merged = add_messages(old, replace_messages_in_state(new)["messages"])
    assert len(merged) == 2
    assert getattr(merged[1], "name", None) == "conversation_summary"
