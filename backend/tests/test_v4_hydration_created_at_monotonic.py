"""hydrate createdAt 跨轮单调：禁止 assistantText@now → 下一轮 turnHeader@更早。"""

from __future__ import annotations

import json
from unittest.mock import patch

from app.gateway.v4.conversation import V4ConversationHub
from app.gateway.v4.hydration import hydrate_session_from_transcript


def _msg(role: str, content: str, *, rid: str, run: str, created_at: str) -> dict:
    return {
        "role": role,
        "content_json": json.dumps({"content": content}),
        "message_id": rid,
        "run_id": run,
        "created_at": created_at,
        "turn_started_at": created_at,
        "turn_duration_ms": 1000,
        "turn_state": "completed",
    }


def test_hydrate_created_at_non_decreasing_across_turns() -> None:
    messages = [
        _msg("user", "一问", rid="u1", run="run-1", created_at="2026-11-14T10:00:00+08:00"),
        _msg(
            "assistant",
            "一答中间",
            rid="a1",
            run="run-1",
            created_at="2026-11-14T10:00:05+08:00",
        ),
        _msg(
            "assistant",
            "一答结论",
            rid="a2",
            run="run-1",
            created_at="2026-11-14T10:01:00+08:00",
        ),
        _msg("user", "二问", rid="u2", run="run-2", created_at="2026-11-14T11:00:00+08:00"),
        _msg(
            "assistant",
            "二答",
            rid="a3",
            run="run-2",
            created_at="2026-11-14T11:00:30+08:00",
        ),
    ]
    hub = V4ConversationHub()
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
        assert hydrate_session_from_transcript(hub, "thread-mono") > 0

    sess = hub.get_session("thread-mono")
    assert sess is not None
    ordered = [sess.rows[rid] for rid in sorted(sess.rows.keys())]
    prev = 0
    for row in ordered:
        created = int(row.get("createdAt") or 0)
        assert created >= prev, (
            f"createdAt 回退：{row.get('kind')}@{created} < prev={prev} rowId={row.get('rowId')}"
        )
        prev = created
    # 关键：第二轮 turnHeader 不得早于第一轮最后一条正文
    headers = [r for r in ordered if r.get("kind") == "turnHeader"]
    texts = [r for r in ordered if r.get("kind") == "assistantText"]
    assert len(headers) >= 2 and len(texts) >= 2
    assert int(headers[1]["createdAt"]) >= int(texts[1]["createdAt"])
