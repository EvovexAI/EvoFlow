"""V4 冷恢复 hydration 的轮累计 token usage：assistantText 轮尾行必须带 usage。

口径：该轮 assistant 消息 per-call token 列求和（harness transcript 落库形态），
与 live mirror 消费的轮累计 CUSTOM(name="usage") 同口径；无 token 列值的老会话不显示。
"""

from __future__ import annotations

import json
from unittest.mock import patch

from app.gateway.v4.conversation import V4ConversationHub
from app.gateway.v4.hydration import hydrate_session_from_transcript


def _msg(
    role: str,
    content: str,
    *,
    rid: str,
    run: str = "run-1",
    tokens: dict[str, int] | None = None,
) -> dict:
    msg = {
        "role": role,
        "content_json": json.dumps({"content": content}),
        "message_id": rid,
        "run_id": run,
        "created_at": "2026-11-09T15:00:00+08:00",
        "turn_started_at": "2026-11-09T15:00:00+08:00",
        "turn_duration_ms": 1000,
        "turn_state": "completed",
    }
    if tokens:
        msg.update(tokens)
    return msg


def _hydrate(thread_id: str, messages: list[dict]) -> V4ConversationHub:
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
        loaded = hydrate_session_from_transcript(hub, thread_id)
    assert loaded > 0
    return hub


def _assistant_text_rows(hub: V4ConversationHub, thread_id: str, turn_id: str) -> list[dict]:
    sess = hub.get_session(thread_id)
    assert sess is not None
    return sorted(
        (
            r
            for r in sess.rows.values()
            if r.get("kind") == "assistantText" and r.get("turnId") == turn_id
        ),
        key=lambda r: int(r["rowId"]),
    )


def test_hydrate_stamps_turn_usage_sum_on_last_assistant_text() -> None:
    """同轮两次模型调用（两条 assistant 消息带 per-call usage）→ 轮尾行 = 求和。"""
    messages = [
        _msg("user", "问", rid="u1", run="run-1"),
        _msg(
            "assistant",
            "中间答",
            rid="a1",
            run="run-1",
            tokens={"input_tokens": 100, "output_tokens": 20, "cache_read_tokens": 60},
        ),
        _msg(
            "assistant",
            "最终答",
            rid="a2",
            run="run-1",
            tokens={"input_tokens": 150, "output_tokens": 30, "cache_read_tokens": 80},
        ),
    ]
    hub = _hydrate("thread-usage-1", messages)
    texts = _assistant_text_rows(hub, "thread-usage-1", "run-1")
    assert len(texts) == 2
    assert texts[0].get("usage") is None, "非轮尾正文行不盖章"
    usage = texts[1].get("usage")
    assert usage == {
        "inputTokens": 250,
        "outputTokens": 50,
        "totalTokens": 0,
        "cacheReadTokens": 140,
    }


def test_hydrate_turn_without_tokens_has_no_usage() -> None:
    """老会话 assistant 消息没有 token 列值 → 该轮不显示用量，不报错。"""
    messages = [
        _msg("user", "问", rid="u1", run="run-1"),
        _msg("assistant", "答", rid="a1", run="run-1"),
    ]
    hub = _hydrate("thread-usage-2", messages)
    texts = _assistant_text_rows(hub, "thread-usage-2", "run-1")
    assert len(texts) == 1
    assert texts[0].get("usage") is None


def test_hydrate_multi_turn_usage_per_turn() -> None:
    """多轮各自求和：第二轮的 usage 不得混入第一轮。"""
    messages = [
        _msg("user", "一问", rid="u1", run="run-1"),
        _msg(
            "assistant",
            "一答",
            rid="a1",
            run="run-1",
            tokens={"input_tokens": 10, "output_tokens": 5, "total_tokens": 15},
        ),
        _msg("user", "二问", rid="u2", run="run-2"),
        _msg(
            "assistant",
            "二答",
            rid="a2",
            run="run-2",
            tokens={"input_tokens": 200, "output_tokens": 50, "total_tokens": 250},
        ),
    ]
    hub = _hydrate("thread-usage-3", messages)
    texts1 = _assistant_text_rows(hub, "thread-usage-3", "run-1")
    texts2 = _assistant_text_rows(hub, "thread-usage-3", "run-2")
    assert texts1[0]["usage"] == {
        "inputTokens": 10,
        "outputTokens": 5,
        "totalTokens": 15,
    }
    assert texts2[0]["usage"]["inputTokens"] == 200
    assert "cacheReadTokens" not in texts1[0]["usage"]
