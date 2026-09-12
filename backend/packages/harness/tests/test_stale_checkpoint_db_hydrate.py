"""Stale LangGraph checkpoint must not re-trigger compress when DB already has summary."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from evoflow.agents.middlewares.context_compaction_middleware import (
    _prefer_db_hydrated_if_stale_checkpoint,
)


def test_prefer_db_hydrate_when_checkpoint_lacks_summary() -> None:
    stale = [
        HumanMessage(content="old user", id="u1"),
        AIMessage(content="old ai", id="a1"),
        ToolMessage(content="big " * 200, tool_call_id="t1", id="tm1"),
    ] * 20  # 60 msgs, no conversation_summary
    hydrated = [
        HumanMessage(content="[CONTEXT COMPACTION — REFERENCE ONLY]\nfolded", name="conversation_summary", id="sum"),
        HumanMessage(content="latest", id="u-new"),
    ]

    with patch(
        "evoflow.persistence.chat_message_repositories.find_latest_compaction_seq",
        return_value=100,
    ), patch(
        "evoflow.agents.middlewares.session_transcript_hydration_middleware.load_model_messages_for_session",
        return_value=hydrated,
    ):
        out, swapped = _prefer_db_hydrated_if_stale_checkpoint(
            stale,
            session_key="proactive:x:task:1",
            runtime=MagicMock(),
            thread_id="tid",
        )

    assert swapped is True
    assert len(out) == 2
    assert getattr(out[0], "name", None) == "conversation_summary"


def test_prefer_db_hydrate_rejects_hydrate_without_summary() -> None:
    stale = [
        HumanMessage(content="old user", id="u1"),
        AIMessage(content="old ai", id="a1"),
        ToolMessage(content="big " * 200, tool_call_id="t1", id="tm1"),
    ] * 20
    # round_id dump style: many msgs, no conversation_summary name
    hydrated = [HumanMessage(content=f"u{i}", id=f"hu{i}") for i in range(40)]

    with patch(
        "evoflow.persistence.chat_message_repositories.find_latest_compaction_seq",
        return_value=100,
    ), patch(
        "evoflow.agents.middlewares.session_transcript_hydration_middleware.load_model_messages_for_session",
        return_value=hydrated,
    ):
        out, swapped = _prefer_db_hydrated_if_stale_checkpoint(
            stale,
            session_key="proactive:x:task:1",
            runtime=MagicMock(),
            thread_id="tid",
        )

    assert swapped is False
    assert out is stale


def test_prefer_db_hydrate_noop_when_messages_already_have_summary() -> None:
    msgs = [
        HumanMessage(content="[CONTEXT COMPACTION — REFERENCE ONLY]\nok", name="conversation_summary"),
        HumanMessage(content="hi"),
    ]
    with patch(
        "evoflow.persistence.chat_message_repositories.find_latest_compaction_seq",
        return_value=100,
    ) as find:
        out, swapped = _prefer_db_hydrated_if_stale_checkpoint(
            msgs,
            session_key="proactive:x:task:1",
            runtime=None,
            thread_id="tid",
        )
    assert swapped is False
    assert out is msgs
    find.assert_not_called()
