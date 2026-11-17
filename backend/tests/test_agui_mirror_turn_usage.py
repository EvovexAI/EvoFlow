"""V4 镜像轮累计 token usage 盖章：CUSTOM(name="usage") 必须落到轮尾 assistantText 行。

背景：旧版 UI 每条回复下方显示 ↑输入 ↓输出 · ⚡缓存命中；V4 协议原本把
sse_ui_normalize 的 usage 帧丢在镜像外，面板无从显示。
"""

from __future__ import annotations

from typing import Any

import pytest

from app.gateway.v4.agui_mirror import V4Mirror
from app.gateway.v4.conversation import HUB


def _texts(session_id: str, turn_id: str) -> list[dict[str, Any]]:
    sess = HUB.get_session(session_id)
    assert sess is not None
    return sorted(
        (
            r
            for r in sess.rows.values()
            if r.get("kind") == "assistantText" and r.get("turnId") == turn_id
        ),
        key=lambda r: int(r["rowId"]),
    )


_USAGE = {
    "input_tokens": 1200,
    "output_tokens": 340,
    "total_tokens": 1540,
    "cache_read_tokens": 890,
    "cache_creation_tokens": 12,
    "cache_miss_tokens": 298,
}


@pytest.fixture()
def clean_hub(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr("app.gateway.v4.agui_mirror._MIRROR_DISABLED", False)
    created: list[str] = []

    def _make(suffix: str) -> str:
        tid = f"mirror-usage-{suffix}"
        if tid in getattr(HUB, "_sessions", {}):
            del HUB._sessions[tid]  # noqa: SLF001
        created.append(tid)
        return tid

    yield _make
    for tid in created:
        if tid in getattr(HUB, "_sessions", {}):
            del HUB._sessions[tid]  # noqa: SLF001


def test_turn_usage_stamped_on_last_assistant_text(clean_hub) -> None:
    """正常路径：usage CUSTOM 先于 RUN_FINISHED，轮累计盖在最后一条正文行上。"""
    tid = clean_hub("normal")
    mirror = V4Mirror(HUB)
    usage_event = {"type": "CUSTOM", "name": "usage", "value": {"type": "usage", "usage": _USAGE}}
    mirror.feed_events(
        tid,
        [
            {"type": "RUN_STARTED", "threadId": tid, "runId": "run-1"},
            {"type": "TEXT_MESSAGE_START", "messageId": "m1"},
            {"type": "TEXT_MESSAGE_CONTENT", "messageId": "m1", "delta": "第一段"},
            {"type": "TEXT_MESSAGE_END", "messageId": "m1"},
            {"type": "TEXT_MESSAGE_START", "messageId": "m2"},
            {"type": "TEXT_MESSAGE_CONTENT", "messageId": "m2", "delta": "最终段"},
            {"type": "TEXT_MESSAGE_END", "messageId": "m2"},
            usage_event,
            {"type": "RUN_FINISHED", "threadId": tid, "runId": "run-1"},
        ],
    )
    texts = _texts(tid, "run-1")
    assert len(texts) == 2
    assert texts[0].get("usage") is None, "非轮尾正文行不盖章"
    stamped = texts[1]
    assert stamped["text"] == "最终段"
    assert stamped["state"] == "complete"
    assert stamped["usage"] == {
        "inputTokens": 1200,
        "outputTokens": 340,
        "totalTokens": 1540,
        "cacheReadTokens": 890,
        "cacheWriteTokens": 12,
    }


def test_late_usage_event_after_finish_stamps(clean_hub) -> None:
    """早封路径：RUN_FINISHED 先到、usage 同批后到（thread_state 先 seal），迟到帧必须补盖。"""
    tid = clean_hub("late")
    mirror = V4Mirror(HUB)
    mirror.feed_events(
        tid,
        [
            {"type": "RUN_STARTED", "threadId": tid, "runId": "run-1"},
            {"type": "TEXT_MESSAGE_START", "messageId": "m1"},
            {"type": "TEXT_MESSAGE_CONTENT", "messageId": "m1", "delta": "答"},
            {"type": "TEXT_MESSAGE_END", "messageId": "m1"},
            {"type": "RUN_FINISHED", "threadId": tid, "runId": "run-1"},
            {"type": "CUSTOM", "name": "usage", "value": {"type": "usage", "usage": _USAGE}},
        ],
    )
    texts = _texts(tid, "run-1")
    assert len(texts) == 1
    assert texts[0]["usage"]["inputTokens"] == 1200


def test_failed_turn_not_stamped(clean_hub) -> None:
    """失败轮不盖 usage（V4 动作行不渲染，也没有可信的轮累计）。"""
    tid = clean_hub("failed")
    mirror = V4Mirror(HUB)
    mirror.feed_events(
        tid,
        [
            {"type": "RUN_STARTED", "threadId": tid, "runId": "run-1"},
            {"type": "TEXT_MESSAGE_START", "messageId": "m1"},
            {"type": "TEXT_MESSAGE_CONTENT", "messageId": "m1", "delta": "写到一半"},
            {"type": "TEXT_MESSAGE_END", "messageId": "m1"},
            {"type": "RUN_ERROR", "threadId": tid, "runId": "run-1", "message": "boom"},
            {"type": "CUSTOM", "name": "usage", "value": {"type": "usage", "usage": _USAGE}},
        ],
    )
    texts = _texts(tid, "run-1")
    assert texts and all(r.get("usage") is None for r in texts)


def test_usage_event_without_usage_payload_ignored(clean_hub) -> None:
    """畸形/空 usage 事件不得覆盖或盖章。"""
    tid = clean_hub("empty")
    mirror = V4Mirror(HUB)
    mirror.feed_events(
        tid,
        [
            {"type": "RUN_STARTED", "threadId": tid, "runId": "run-1"},
            {"type": "TEXT_MESSAGE_START", "messageId": "m1"},
            {"type": "TEXT_MESSAGE_CONTENT", "messageId": "m1", "delta": "答"},
            {"type": "TEXT_MESSAGE_END", "messageId": "m1"},
            {"type": "CUSTOM", "name": "usage", "value": {"type": "usage", "usage": {}}},
            {"type": "RUN_FINISHED", "threadId": tid, "runId": "run-1"},
        ],
    )
    texts = _texts(tid, "run-1")
    assert len(texts) == 1
    assert texts[0].get("usage") is None


def test_next_turn_resets_usage_context(clean_hub) -> None:
    """开新轮必须清上一轮的 usage 记账，避免旧累计盖到新轮正文行。"""
    tid = clean_hub("reset")
    mirror = V4Mirror(HUB)
    mirror.feed_events(
        tid,
        [
            {"type": "RUN_STARTED", "threadId": tid, "runId": "run-1"},
            {"type": "TEXT_MESSAGE_START", "messageId": "m1"},
            {"type": "TEXT_MESSAGE_CONTENT", "messageId": "m1", "delta": "答一"},
            {"type": "TEXT_MESSAGE_END", "messageId": "m1"},
            {"type": "RUN_FINISHED", "threadId": tid, "runId": "run-1"},
        ],
    )
    mirror.feed_events(
        tid,
        [
            {"type": "RUN_STARTED", "threadId": tid, "runId": "run-2"},
            {"type": "TEXT_MESSAGE_START", "messageId": "m2"},
            {"type": "TEXT_MESSAGE_CONTENT", "messageId": "m2", "delta": "答二"},
            {"type": "TEXT_MESSAGE_END", "messageId": "m2"},
            {"type": "RUN_FINISHED", "threadId": tid, "runId": "run-2"},
            {"type": "CUSTOM", "name": "usage", "value": {"type": "usage", "usage": _USAGE}},
        ],
    )
    texts1 = _texts(tid, "run-1")
    texts2 = _texts(tid, "run-2")
    assert texts1 and texts1[0].get("usage") is None
    assert texts2 and texts2[0]["usage"]["inputTokens"] == 1200


def test_session_usage_state_bumped_on_turn_finish(clean_hub) -> None:
    """快照基线存在时，成功轮的累计 usage 并入会话 usage_state 并发增量。"""
    tid = clean_hub("bump")
    mirror = V4Mirror(HUB)
    mirror.feed_events(tid, [{"type": "RUN_STARTED", "threadId": tid, "runId": "run-1"}])
    sess = HUB.get_session(tid)
    assert sess is not None
    sess.usage_state = {
        "contextWindow": None,
        "cumulative": {
            "inputTokens": 1000,
            "outputTokens": 100,
            "cacheReadTokens": 500,
            "cacheWriteTokens": 10,
            "totalTokens": 1100,
            "cacheMissTokens": 400,
        },
    }
    mirror.feed_events(
        tid,
        [
            {"type": "TEXT_MESSAGE_START", "messageId": "m1"},
            {"type": "TEXT_MESSAGE_CONTENT", "messageId": "m1", "delta": "答"},
            {"type": "TEXT_MESSAGE_END", "messageId": "m1"},
            {"type": "CUSTOM", "name": "usage", "value": {"type": "usage", "usage": _USAGE}},
            {"type": "RUN_FINISHED", "threadId": tid, "runId": "run-1"},
        ],
    )
    cum = sess.usage_state["cumulative"]
    assert cum["inputTokens"] == 1000 + 1200
    assert cum["outputTokens"] == 100 + 340
    assert cum["totalTokens"] == 1100 + 1540
    assert cum["cacheReadTokens"] == 500 + 890
    assert cum["cacheMissTokens"] == 400 + 298


def test_session_usage_state_no_double_count_on_late_duplicate(clean_hub) -> None:
    """早封路径（FINISHED 先到、usage 后到）补并入一次；再迟到的重复帧不得双计。"""
    tid = clean_hub("late-bump")
    mirror = V4Mirror(HUB)
    mirror.feed_events(tid, [{"type": "RUN_STARTED", "threadId": tid, "runId": "run-1"}])
    sess = HUB.get_session(tid)
    assert sess is not None
    sess.usage_state = {
        "contextWindow": None,
        "cumulative": {
            "inputTokens": 0,
            "outputTokens": 0,
            "cacheReadTokens": 0,
            "cacheWriteTokens": 0,
        },
    }
    late_usage = {"type": "CUSTOM", "name": "usage", "value": {"type": "usage", "usage": _USAGE}}
    mirror.feed_events(
        tid,
        [
            {"type": "TEXT_MESSAGE_START", "messageId": "m1"},
            {"type": "TEXT_MESSAGE_CONTENT", "messageId": "m1", "delta": "答"},
            {"type": "TEXT_MESSAGE_END", "messageId": "m1"},
            {"type": "RUN_FINISHED", "threadId": tid, "runId": "run-1"},
            late_usage,
            late_usage,
        ],
    )
    cum = sess.usage_state["cumulative"]
    assert cum["inputTokens"] == 1200, "同一轮的累计 usage 只允许并入一次"


def test_session_usage_state_skipped_without_baseline(clean_hub) -> None:
    """本进程没建过快照（usage_state=None）→ 跳过并入，不报错。"""
    tid = clean_hub("no-base")
    mirror = V4Mirror(HUB)
    mirror.feed_events(tid, [{"type": "RUN_STARTED", "threadId": tid, "runId": "run-1"}])
    sess = HUB.get_session(tid)
    assert sess is not None
    mirror.feed_events(
        tid,
        [
            {"type": "TEXT_MESSAGE_START", "messageId": "m1"},
            {"type": "TEXT_MESSAGE_CONTENT", "messageId": "m1", "delta": "答"},
            {"type": "TEXT_MESSAGE_END", "messageId": "m1"},
            {"type": "CUSTOM", "name": "usage", "value": {"type": "usage", "usage": _USAGE}},
            {"type": "RUN_FINISHED", "threadId": tid, "runId": "run-1"},
        ],
    )
    assert sess.usage_state is None


def test_assistant_text_preserves_start_created_at(clean_hub, monkeypatch: pytest.MonkeyPatch) -> None:
    """TEXT_MESSAGE_END / RUN_FINISHED 不得把多段正文盖成同一个 turn_started。"""
    clock = {"t": 1_700_000_000_000}

    def _tick() -> int:
        clock["t"] += 10
        return clock["t"]

    monkeypatch.setattr("app.gateway.v4.agui_mirror._now_ms", _tick)
    tid = clean_hub("created-at")
    mirror = V4Mirror(HUB)
    mirror.feed_events(
        tid,
        [
            {"type": "RUN_STARTED", "threadId": tid, "runId": "run-1"},
            {"type": "TEXT_MESSAGE_START", "messageId": "m1"},
            {"type": "TEXT_MESSAGE_CONTENT", "messageId": "m1", "delta": "一"},
            {"type": "TEXT_MESSAGE_END", "messageId": "m1"},
            {"type": "TEXT_MESSAGE_START", "messageId": "m2"},
            {"type": "TEXT_MESSAGE_CONTENT", "messageId": "m2", "delta": "二"},
            {"type": "TEXT_MESSAGE_END", "messageId": "m2"},
            {"type": "RUN_FINISHED", "threadId": tid, "runId": "run-1"},
        ],
    )
    texts = _texts(tid, "run-1")
    assert len(texts) == 2
    c0 = int(texts[0]["createdAt"])
    c1 = int(texts[1]["createdAt"])
    assert c1 > c0, f"两段正文须各自保留 START 时钟，got {c0} / {c1}"
    sess = HUB.get_session(tid)
    assert sess is not None
    header = next(r for r in sess.rows.values() if r.get("kind") == "turnHeader")
    assert c0 > int(header["createdAt"])
    assert c1 > int(header["createdAt"])
