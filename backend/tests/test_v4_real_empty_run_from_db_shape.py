"""真实 DB 形状回归：API 空跑 vs run_id 错位的健康轮。

证据来自 ``~/.evoflow-dev/data/app/evoflow.db``（2026-11 扫描）：
- dump 浮层里的 self-evolution thread **不在**该库（也无法用 dump tid 证伪 API）；
- 同库 30 个近会话里有 **24** 条「可见 user 后无 assistant/tool」——持久层即空，非投影吞掉；
- 健康轮常见 user.run_id ≠ assistant.run_id（LangGraph hop），须靠 enrich 并成一轮。

本文件用扫到的原文/run_id 形状做镜像 + hydrate，不连真实 sqlite（CI 无该库）。
"""

from __future__ import annotations

import json
from typing import Any
from unittest.mock import patch

import pytest

from app.gateway.v4.agui_mirror import EMPTY_RUN_NOTICE_TEXT, V4Mirror
from app.gateway.v4.conversation import HUB, V4ConversationHub
from app.gateway.v4.hydration import hydrate_session_from_transcript

# 真实空跑：agent:main:new-d0ad1673 seq=81，following=[]
_REAL_EMPTY_USER = "哪些是没用的"
_REAL_EMPTY_RUN = "99bcebb1-a56a-495b-86b6-7f88fdfcb7e1"

# 真实健康轮：agent:main:new-4ffed1b4 seq 1–2（user/assistant run_id 故意不同）
_REAL_OK_USER = "1"
_REAL_OK_USER_RUN = "e0c14c4d-e057-4971-8831-b00dc2c9bc92"
_REAL_OK_ASSISTANT = "你好！请问有什么我可以帮你的吗？"
_REAL_OK_ASSISTANT_RUN = "01a1d4c1-0000-0000-0000-000000000001"


def _rows(session_id: str) -> list[dict[str, Any]]:
    sess = HUB.get_session(session_id)
    assert sess is not None
    return sorted(sess.rows.values(), key=lambda r: int(r["rowId"]))


@pytest.fixture()
def mirror_session(monkeypatch: pytest.MonkeyPatch) -> str:
    monkeypatch.setattr("app.gateway.v4.agui_mirror._MIRROR_DISABLED", False)
    sid = "mirror-real-empty-db-shape"
    if sid in getattr(HUB, "_sessions", {}):
        del HUB._sessions[sid]  # noqa: SLF001
    return sid


def test_mirror_empty_finished_with_real_db_user_text(mirror_session: str) -> None:
    """真实空跑用户文案 + 空流 FINISHED → 必须有 empty-run 占位（live 路径）。"""
    tid = mirror_session + "-live"
    if tid in getattr(HUB, "_sessions", {}):
        del HUB._sessions[tid]  # noqa: SLF001
    mirror = V4Mirror(HUB)
    mirror.note_user_input(tid, _REAL_EMPTY_USER, message_id="u-real-empty")
    mirror.feed_events(
        tid,
        [
            {"type": "RUN_STARTED", "threadId": tid, "runId": _REAL_EMPTY_RUN},
            {"type": "RUN_FINISHED", "threadId": tid, "runId": _REAL_EMPTY_RUN},
        ],
    )
    texts = [r for r in _rows(tid) if r.get("kind") == "assistantText"]
    assert len(texts) == 1
    assert str(texts[0].get("entityId") or "").startswith("empty-run-")
    assert texts[0]["text"] == EMPTY_RUN_NOTICE_TEXT
    assert texts[0]["turnId"] == _REAL_EMPTY_RUN


def _hydrate(hub: V4ConversationHub, tid: str, messages: list[dict[str, Any]]) -> int:
    with (
        patch(
            "evoflow.persistence.session_repositories.find_session_key_by_thread_id",
            return_value="agent:main:new-d0ad1673",
        ),
        patch(
            "evoflow.persistence.session_repositories.is_session_deleted",
            return_value=False,
        ),
        patch("app.gateway.v4.hydration._load_messages", return_value=messages),
    ):
        return hydrate_session_from_transcript(hub, tid)


def test_hydrate_real_api_empty_user_only_writes_notice() -> None:
    """DB 里 user 后无 assistant 行 → hydrate 也要占位，禁止 !EMPTY_ASSISTANT。"""
    hub = V4ConversationHub()
    tid = "2036fdcb-1ce0-4cbe-a477-0b9bbda8a789"
    messages = [
        {
            "role": "user",
            "content_json": json.dumps(
                {"content": [{"type": "text", "text": _REAL_EMPTY_USER}]},
                ensure_ascii=False,
            ),
            "message_id": "msg-empty-u81",
            "run_id": _REAL_EMPTY_RUN,
            "created_at": "2026-11-12T12:00:00+08:00",
            "turn_started_at": "2026-11-12T12:00:00+08:00",
            "turn_duration_ms": 0,
            "turn_state": "completed",
        }
    ]
    assert _hydrate(hub, tid, messages) > 0
    sess = hub.get_session(tid)
    assert sess is not None
    rows = sorted(sess.rows.values(), key=lambda r: int(r["rowId"]))
    users = [r for r in rows if r.get("kind") == "userInput"]
    texts = [r for r in rows if r.get("kind") == "assistantText"]
    assert len(users) == 1
    assert users[0]["text"] == _REAL_EMPTY_USER
    assert len(texts) == 1
    assert str(texts[0].get("entityId") or "").startswith("empty-run-")
    assert texts[0]["text"] == EMPTY_RUN_NOTICE_TEXT


def test_hydrate_real_mismatched_run_ids_stays_one_healthy_turn() -> None:
    """真实健康形状：user/assistant 不同 run_id，enrich 后不得误插 empty-run。"""
    hub = V4ConversationHub()
    tid = "d3cb164f-73c1-43ba-af2b-14c39bcfdd10"
    messages = [
        {
            "role": "user",
            "content_json": json.dumps(
                {"content": [{"type": "text", "text": _REAL_OK_USER}]},
                ensure_ascii=False,
            ),
            "message_id": "msg-ok-u1",
            "run_id": _REAL_OK_USER_RUN,
            "created_at": "2026-11-10T10:00:00+08:00",
            "turn_started_at": "2026-11-10T10:00:00+08:00",
            "turn_duration_ms": 500,
            "turn_state": "completed",
        },
        {
            "role": "assistant",
            "content_json": json.dumps(
                {"content": [{"type": "text", "text": _REAL_OK_ASSISTANT}]},
                ensure_ascii=False,
            ),
            "message_id": "msg-ok-a1",
            "run_id": _REAL_OK_ASSISTANT_RUN,
            "created_at": "2026-11-10T10:00:01+08:00",
            "turn_started_at": "2026-11-10T10:00:00+08:00",
            "turn_duration_ms": 500,
            "turn_state": "completed",
        },
    ]
    assert _hydrate(hub, tid, messages) > 0
    sess = hub.get_session(tid)
    assert sess is not None
    rows = sorted(sess.rows.values(), key=lambda r: int(r["rowId"]))
    headers = [r for r in rows if r.get("kind") == "turnHeader"]
    texts = [r for r in rows if r.get("kind") == "assistantText"]
    assert len(headers) == 1
    assert headers[0]["turnId"] == _REAL_OK_USER_RUN
    assert len(texts) == 1
    assert texts[0]["text"] == _REAL_OK_ASSISTANT
    assert not str(texts[0].get("entityId") or "").startswith("empty-run-")
