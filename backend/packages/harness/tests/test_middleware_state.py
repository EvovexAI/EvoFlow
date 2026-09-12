"""State update helpers for agent middleware."""

from langchain_core.messages import AIMessage, HumanMessage
from langgraph.graph.message import add_messages

from evoflow.agents.middleware_state import replace_messages_in_state


def test_replace_messages_in_state_replaces_full_list() -> None:
    old = [
        HumanMessage(content="a", id="1"),
        AIMessage(content="b", id="2"),
        HumanMessage(content="c", id="3"),
    ]
    replacement = [
        HumanMessage(content="summary", id="summary"),
        HumanMessage(content="latest", id="4"),
    ]
    patch = replace_messages_in_state(replacement)
    merged = add_messages(old, patch["messages"])
    assert len(merged) == 2
    assert [m.id for m in merged] == ["summary", "4"]
