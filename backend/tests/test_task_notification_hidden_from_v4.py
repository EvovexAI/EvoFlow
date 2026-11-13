"""``<task-notification>`` must not become a visible V4 userInput (live or hydrate)."""

from __future__ import annotations

from typing import Any

import pytest

from app.gateway.v4.agui_mirror import (
    V4Mirror,
    _is_hidden_context_compaction_user_text,
    _is_hidden_task_notification_message_id,
    _is_hidden_task_notification_user_text,
)
from app.gateway.v4.conversation import HUB
from app.gateway.v4.hydration import (
    _is_hidden_context_compaction_text,
    _is_hidden_context_user_tool_name,
    _is_hidden_task_notification_message_id as hydrate_mid,
    _is_hidden_task_notification_text,
)


def _rows(session_id: str) -> list[dict[str, Any]]:
    sess = HUB.get_session(session_id)
    assert sess is not None
    return sorted(sess.rows.values(), key=lambda r: int(r["rowId"]))


@pytest.fixture()
def mirror_session(monkeypatch: pytest.MonkeyPatch) -> str:
    monkeypatch.setattr("app.gateway.v4.agui_mirror._MIRROR_DISABLED", False)
    sid = "mirror-task-notif-test"
    if sid in getattr(HUB, "_sessions", {}):
        del HUB._sessions[sid]  # noqa: SLF001
    return sid


def test_task_notification_text_sniff():
    sample = (
        "<task-notification>\n"
        "<task-id>Run_1</task-id>\n"
        "<status>completed</status>\n"
        "</task-notification>"
    )
    assert _is_hidden_task_notification_user_text(sample)
    assert _is_hidden_task_notification_text(sample)
    assert _is_hidden_task_notification_user_text(
        "<subagent-notification>x</subagent-notification>"
    )
    assert not _is_hidden_task_notification_user_text("普通用户消息")
    assert not _is_hidden_task_notification_text("普通用户消息")


def test_task_notification_message_id_sniff():
    assert _is_hidden_task_notification_message_id("bash-task-notification:abc")
    assert _is_hidden_task_notification_message_id("subagent-task-notification:xyz")
    assert hydrate_mid("bash-task-notification:abc")
    assert not _is_hidden_task_notification_message_id("user-msg-1")
    assert not hydrate_mid("")


def test_context_compaction_text_and_tool_name_hidden():
    assert _is_hidden_context_compaction_user_text("[上下文摘要 - 已压缩 12 条历史]\n…")
    assert _is_hidden_context_compaction_text("[深度压缩摘要]\n…")
    assert _is_hidden_context_compaction_user_text("[CONTEXT COMPACTION]\n…")
    assert _is_hidden_context_user_tool_name("conversation_summary")
    assert _is_hidden_context_user_tool_name("tool_history")
    assert not _is_hidden_context_compaction_text("普通用户消息")


def test_hidden_task_notification_not_mirrored(mirror_session: str) -> None:
    tid = mirror_session + "-hidden-task-notif"
    if tid in getattr(HUB, "_sessions", {}):
        del HUB._sessions[tid]  # noqa: SLF001
    mirror = V4Mirror(HUB)
    body = (
        "<task-notification>\n"
        "<task-id>Run_x</task-id>\n"
        "<status>completed</status>\n"
        "<summary>done</summary>\n"
        "</task-notification>"
    )
    mirror.note_user_input(
        tid,
        body,
        message_id="bash-task-notification:Run_x",
    )
    mirror.feed_events(
        tid,
        [
            {"type": "RUN_STARTED", "threadId": tid, "runId": "run-tn"},
            {"type": "TEXT_MESSAGE_START", "messageId": "m1"},
            {"type": "TEXT_MESSAGE_CONTENT", "messageId": "m1", "delta": "已汇总"},
            {"type": "TEXT_MESSAGE_END", "messageId": "m1"},
            {"type": "RUN_FINISHED", "threadId": tid, "runId": "run-tn"},
        ],
    )
    users = [r for r in _rows(tid) if r.get("kind") == "userInput"]
    assert users == [], users
    texts = [r for r in _rows(tid) if r.get("kind") == "assistantText"]
    assert len(texts) == 1
    assert texts[0]["text"] == "已汇总"
