"""MemoryMiddleware queues updates from after_model once per user turn."""

from __future__ import annotations

from unittest.mock import patch

from langchain_core.messages import AIMessage, HumanMessage
from langgraph.runtime import Runtime

from evoflow.agents.middlewares.memory_middleware import _MEMORY_UPDATE_SCHEDULED, MemoryMiddleware


def test_memory_middleware_queues_on_after_model_with_final_assistant() -> None:
    _MEMORY_UPDATE_SCHEDULED.clear()
    mw = MemoryMiddleware(agent_name="main")
    state = {
        "messages": [
            HumanMessage(content="hello", id="u1"),
            AIMessage(content="world reply"),
        ]
    }
    rt = Runtime(context={"thread_id": "t-mem-am"})

    with patch(
        "evoflow.agents.middlewares.memory_middleware.effective_memory_updates_enabled",
        return_value=True,
    ):
        with patch(
            "evoflow.agents.middlewares.memory_middleware.resolve_transcript_messages_for_analysis",
            side_effect=lambda **kw: kw["runtime_messages"],
        ):
            with patch("evoflow.agents.middlewares.memory_middleware.get_memory_queue") as mock_q:
                mw.after_model(state, rt)
                mock_q.return_value.add.assert_called_once()
                args, kwargs = mock_q.return_value.add.call_args
                assert kwargs["thread_id"] == "t-mem-am"
                assert kwargs["agent_name"] == "main"


def test_memory_middleware_skips_tool_call_assistant() -> None:
    _MEMORY_UPDATE_SCHEDULED.clear()
    mw = MemoryMiddleware()
    state = {
        "messages": [
            HumanMessage(content="search something", id="u2"),
            AIMessage(content="", tool_calls=[{"id": "tc1", "name": "rg", "args": {}}]),
        ]
    }
    rt = Runtime(context={"thread_id": "t-mem-tools"})

    with patch(
        "evoflow.agents.middlewares.memory_middleware.effective_memory_updates_enabled",
        return_value=True,
    ):
        with patch(
            "evoflow.agents.middlewares.memory_middleware.resolve_transcript_messages_for_analysis",
            side_effect=lambda **kw: kw["runtime_messages"],
        ):
            with patch("evoflow.agents.middlewares.memory_middleware.get_memory_queue") as mock_q:
                mw.after_model(state, rt)
                mock_q.return_value.add.assert_not_called()


def test_memory_middleware_dedupes_same_user_turn() -> None:
    _MEMORY_UPDATE_SCHEDULED.clear()
    mw = MemoryMiddleware()
    state = {
        "messages": [
            HumanMessage(content="once", id="u3"),
            AIMessage(content="done"),
        ]
    }
    rt = Runtime(context={"thread_id": "t-mem-dedupe"})

    with patch(
        "evoflow.agents.middlewares.memory_middleware.effective_memory_updates_enabled",
        return_value=True,
    ):
        with patch(
            "evoflow.agents.middlewares.memory_middleware.resolve_transcript_messages_for_analysis",
            side_effect=lambda **kw: kw["runtime_messages"],
        ):
            with patch("evoflow.agents.middlewares.memory_middleware.get_memory_queue") as mock_q:
                mw.after_model(state, rt)
                mw.after_model(state, rt)
                assert mock_q.return_value.add.call_count == 1
