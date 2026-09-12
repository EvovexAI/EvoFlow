"""Checkpoint transcript slim + hydration guard for empty/slim checkpoints."""

from __future__ import annotations

from types import SimpleNamespace

from langchain_core.messages import AIMessage, HumanMessage, RemoveMessage
from langgraph.graph.message import REMOVE_ALL_MESSAGES

from evoflow.agents.middlewares.checkpoint_transcript_slim_middleware import (
    CheckpointTranscriptSlimMiddleware,
    checkpoint_transcript_slim_enabled,
)
from evoflow.agents.middlewares.session_transcript_hydration_middleware import (
    checkpoint_messages_look_slim,
)


def test_checkpoint_messages_look_slim_detects_cleared_plus_new_human() -> None:
    assert checkpoint_messages_look_slim([HumanMessage(content="hi", id="u1")], max_seq=10) is True
    assert checkpoint_messages_look_slim([], max_seq=10) is True


def test_checkpoint_messages_look_slim_false_when_history_present() -> None:
    msgs = [
        HumanMessage(content="a", id="u1"),
        AIMessage(content="b", id="a1"),
        HumanMessage(content="c", id="u2"),
    ]
    assert checkpoint_messages_look_slim(msgs, max_seq=10) is False


def test_checkpoint_messages_look_slim_false_on_empty_db() -> None:
    assert checkpoint_messages_look_slim([HumanMessage(content="hi")], max_seq=0) is False
    assert checkpoint_messages_look_slim([HumanMessage(content="hi")], max_seq=1) is False


def test_slim_middleware_clears_messages(monkeypatch) -> None:
    monkeypatch.setenv("EVOFLOW_CHECKPOINT_SLIM_MESSAGES", "1")
    assert checkpoint_transcript_slim_enabled() is True
    mw = CheckpointTranscriptSlimMiddleware()
    state = {
        "messages": [
            HumanMessage(content="u", id="1"),
            AIMessage(content="a", id="2"),
        ],
        "ui_messages": [{"role": "assistant", "content": "x"}],
    }
    runtime = SimpleNamespace(config={"configurable": {"thread_id": "t1"}}, context={})
    patch = mw.after_agent(state, runtime)
    assert patch is not None
    assert patch["ui_messages"] == []
    msgs = patch["messages"]
    assert isinstance(msgs[0], RemoveMessage)
    assert msgs[0].id == REMOVE_ALL_MESSAGES
    assert len(msgs) == 1


def test_slim_middleware_disabled(monkeypatch) -> None:
    monkeypatch.setenv("EVOFLOW_CHECKPOINT_SLIM_MESSAGES", "0")
    mw = CheckpointTranscriptSlimMiddleware()
    state = {"messages": [HumanMessage(content="u", id="1")]}
    runtime = SimpleNamespace(config={"configurable": {"thread_id": "t1"}}, context={})
    assert mw.after_agent(state, runtime) is None
