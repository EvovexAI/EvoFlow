"""Helpers for LangGraph ``add_messages`` state updates."""

from __future__ import annotations

from typing import Any

from langchain_core.messages import BaseMessage, RemoveMessage
from langgraph.graph.message import REMOVE_ALL_MESSAGES


def replace_messages_in_state(messages: list[BaseMessage]) -> dict[str, Any]:
    """Return a state patch that replaces the full ``messages`` channel.

    Agent state uses ``Annotated[list, add_messages]``; returning only the new
    list merges by message id and leaves stale entries. Use ``RemoveMessage`` +
    ``REMOVE_ALL_MESSAGES`` (same pattern as LangChain ``SummarizationMiddleware``).
    """
    return {
        "messages": [
            RemoveMessage(id=REMOVE_ALL_MESSAGES),
            *messages,
        ]
    }
