"""catchup 按 run_id 灌投影时，无可见 user 的续跑段必须并进上一轮。"""

from __future__ import annotations

import json
from typing import Any
from unittest.mock import patch

from app.gateway.v4.conversation import V4ConversationHub
from app.gateway.v4.hydration import hydrate_session_from_transcript


def _msg(
    role: str,
    content: str,
    *,
    rid: str,
    ts: str,
    run_id: str,
) -> dict[str, Any]:
    return {
        "role": role,
        "content_json": json.dumps({"content": content}),
        "message_id": rid,
        "run_id": run_id,
        "created_at": ts,
        "turn_started_at": ts,
        "turn_duration_ms": 1000,
        "turn_state": "completed",
    }


def _hydrate(hub: V4ConversationHub, tid: str, messages: list[dict[str, Any]]) -> int:
    with (
        patch(
            "evoflow.persistence.session_repositories.find_session_key_by_thread_id",
            return_value="agent:main:test",
        ),
        patch(
            "evoflow.persistence.session_repositories.is_session_deleted",
            return_value=False,
        ),
        patch("app.gateway.v4.hydration._load_messages", return_value=messages),
    ):
        return hydrate_session_from_transcript(hub, tid)


def test_hydrate_merges_run_without_user_into_previous_turn() -> None:
    """user@run-a + assistant@run-a + assistant@run-b → 一个 turnHeader，origin=userInput。"""
    hub = V4ConversationHub()
    tid = "thread-merge-cont"
    messages = [
        _msg(
            "user",
            "定位一下设置消息里相关的插件部分",
            rid="u1",
            ts="2026-11-17T19:40:00+08:00",
            run_id="run-a",
        ),
        _msg(
            "assistant",
            "日志里发现关键线索",
            rid="a1",
            ts="2026-11-17T19:45:00+08:00",
            run_id="run-a",
        ),
        _msg(
            "assistant",
            "本轮我做了多次改动，又自行推翻",
            rid="a2",
            ts="2026-11-17T19:50:00+08:00",
            run_id="run-b",
        ),
    ]
    assert _hydrate(hub, tid, messages) > 0

    sess = hub.get_session(tid)
    assert sess is not None
    rows = sorted(sess.rows.values(), key=lambda r: int(r["rowId"]))
    headers = [r for r in rows if r.get("kind") == "turnHeader"]
    assert len(headers) == 1, headers
    assert headers[0]["turnId"] == "run-a"
    assert headers[0]["origin"] == "userInput"
    users = [r for r in rows if r.get("kind") == "userInput"]
    assert len(users) == 1
    texts = [r for r in rows if r.get("kind") == "assistantText"]
    assert [t["text"] for t in texts] == [
        "日志里发现关键线索",
        "本轮我做了多次改动，又自行推翻",
    ]
    assert {t["turnId"] for t in texts} == {"run-a"}


def test_hydrate_keeps_orphan_first_run_as_goal_continuation() -> None:
    """冷启动无 user 的首段仍单独成轮，origin=goalContinuation。"""
    hub = V4ConversationHub()
    tid = "thread-orphan-first"
    messages = [
        _msg(
            "assistant",
            "旁观续看",
            rid="a0",
            ts="2026-11-17T19:40:00+08:00",
            run_id="run-orphan",
        ),
    ]
    assert _hydrate(hub, tid, messages) > 0

    sess = hub.get_session(tid)
    assert sess is not None
    rows = sorted(sess.rows.values(), key=lambda r: int(r["rowId"]))
    headers = [r for r in rows if r.get("kind") == "turnHeader"]
    assert len(headers) == 1
    assert headers[0]["origin"] == "goalContinuation"
    assert [r for r in rows if r.get("kind") == "userInput"] == []
