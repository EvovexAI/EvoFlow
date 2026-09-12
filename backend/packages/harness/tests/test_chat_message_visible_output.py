"""ai_message_has_visible_output — reasoning-only assistant rows are persistable."""

from __future__ import annotations

from langchain_core.messages import AIMessage

from evoflow.persistence.chat_message_content import ai_message_has_visible_output


def test_reasoning_content_counts_as_visible_output() -> None:
    msg = AIMessage(content="", additional_kwargs={"reasoning_content": "plan the next step"})
    assert ai_message_has_visible_output(msg)


def test_truly_empty_is_not_visible() -> None:
    assert not ai_message_has_visible_output(AIMessage(content=""))
