"""Tests for collab conversation scope filters (subtask vs lead session isolation)."""

from __future__ import annotations

from evoflow.collab.conversation_scope import (
    conversation_msg_belongs_to_subtask,
    is_subtask_mirror_chat_row,
)


def test_subtask_history_does_not_match_all_main_thread_messages():
    main_tid = "thread-main-abc"
    sub_a = "Subtask_a_001"
    sub_b = "Subtask_b_002"
    msgs = [
        {"role": "assistant", "content": "lead plan", "thread_id": main_tid, "source": "lead_chat_mirror"},
        {"role": "assistant", "content": "worker a", "thread_id": main_tid, "collab_subtask_id": sub_a},
        {"role": "assistant", "content": "worker b", "thread_id": main_tid, "collab_subtask_id": sub_b},
    ]
    a_rows = [m for m in msgs if conversation_msg_belongs_to_subtask(m, sub_a)]
    b_rows = [m for m in msgs if conversation_msg_belongs_to_subtask(m, sub_b)]
    assert len(a_rows) == 1
    assert a_rows[0]["content"] == "worker a"
    assert len(b_rows) == 1
    assert b_rows[0]["content"] == "worker b"


def test_main_thread_id_only_does_not_cross_match_subtasks():
    main_tid = "thread-main-xyz"
    sub_a = "Subtask_a_001"
    msg = {"role": "assistant", "content": "orphan", "thread_id": main_tid}
    assert conversation_msg_belongs_to_subtask(msg, sub_a) is False


def test_dedicated_subtask_thread_matches_without_collab_tag():
    sub_tid = "sub-thread-99"
    sub_a = "Subtask_a_001"
    msg = {"role": "assistant", "content": "acp worker", "thread_id": sub_tid}
    assert conversation_msg_belongs_to_subtask(
        msg,
        sub_a,
        dedicated_subtask_thread_id=sub_tid,
    )


def test_is_subtask_mirror_chat_row():
    assert is_subtask_mirror_chat_row(
        {
            "message_id": "Subtask_x:src:msg1",
            "parent_thread_id": "thread-lead",
        }
    )
    assert is_subtask_mirror_chat_row({"message_id": "Subtask_x:src:msg1"})
    assert not is_subtask_mirror_chat_row({"message_id": "lead:abc", "content_json": "{}"})
