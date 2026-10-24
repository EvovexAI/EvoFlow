"""Node panel hydration must not pull the lead/main chat transcript.

Regression: find_session_key_by_thread_id falls back to the lead session when an
executor thread has no dedicated session row. Using that key with
list_messages_for_display_all hydrated the entire main conversation into the
right-stage node panel (串台).
"""

from __future__ import annotations

from unittest.mock import patch

from app.gateway.v4.hydration import _load_messages


def test_load_messages_executor_thread_never_uses_lead_session_display() -> None:
    lead = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
    executor = f"{lead}__sub__st-node-1"
    lead_only_msgs = [
        {"role": "user", "content_json": '{"content":"主对话用户话"}', "message_id": "m1"},
        {"role": "assistant", "content_json": '{"content":"主对话回复"}', "message_id": "m2"},
    ]

    with (
        patch(
            "evoflow.persistence.session_repositories.find_session_key_by_thread_id",
            return_value="agent:main-chat",
        ) as find_sk,
        patch(
            "evoflow.persistence.session_repositories.is_session_deleted",
            return_value=False,
        ),
        patch(
            "evoflow.persistence.chat_message_repositories.list_messages_for_display_all",
            return_value={"messages": lead_only_msgs},
        ) as display_all,
        patch(
            "evoflow.persistence.chat_message_repositories.list_messages_for_thread_id",
            return_value=[],
        ) as by_thread,
        patch(
            "evoflow.persistence.chat_message_repositories.conversation_archive_from_thread_id",
            return_value=[],
        ),
        patch("app.gateway.v4.hydration._load_raw_messages_by_thread", return_value=[]),
    ):
        out = _load_messages(executor)

    assert out == []
    by_thread.assert_called()
    display_all.assert_not_called()
    # Must not resolve via lead fallback for hydration scoping.
    find_sk.assert_not_called()


def test_load_messages_executor_thread_returns_scoped_rows_only() -> None:
    lead = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
    executor = f"{lead}__sub__st-node-2"
    scoped = [
        {
            "role": "assistant",
            "content_json": '{"content":"节点输出"}',
            "message_id": "n1",
            "thread_id": executor,
        },
    ]

    with (
        patch(
            "evoflow.persistence.chat_message_repositories.list_messages_for_display_all",
            return_value={
                "messages": [
                    {"role": "user", "content_json": '{"content":"主对话"}', "message_id": "bad"},
                ]
            },
        ) as display_all,
        patch(
            "evoflow.persistence.chat_message_repositories.list_messages_for_thread_id",
            return_value=scoped,
        ),
    ):
        out = _load_messages(executor)

    assert out == scoped
    display_all.assert_not_called()


def test_load_messages_lead_thread_still_uses_session_display() -> None:
    lead = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
    msgs = [{"role": "user", "content_json": '{"content":"hi"}', "message_id": "u1"}]
    with (
        patch(
            "evoflow.persistence.session_repositories.find_session_key_by_thread_id",
            return_value="agent:main",
        ),
        patch(
            "evoflow.persistence.session_repositories.is_session_deleted",
            return_value=False,
        ),
        patch(
            "evoflow.persistence.chat_message_repositories.list_messages_for_display_all",
            return_value={"messages": msgs},
        ) as display_all,
        patch(
            "evoflow.persistence.chat_message_repositories.list_messages_for_thread_id",
            return_value=[],
        ) as by_thread,
    ):
        out = _load_messages(lead)

    assert out == msgs
    display_all.assert_called_once()
    by_thread.assert_not_called()
