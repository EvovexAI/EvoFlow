"""404 remint 重发双写去重（2026-11-14 用户实锤回归）。

事故链：LangGraph 服务重启丢线程 → 发送 404 → remint 换新线程 + force-rehydrate
（transcript 里的用户消息已入投影，entityId=前端 userMsgId）→ 前端重发 stream →
mirror note_user_input 落 userInput + RUN_STARTED 开新 turnHeader。

回归根因：``_extract_messages_for_mission_bootstrap`` 丢弃消息 ``id`` →
``_extract_user_message_id_from_stream_body`` 永远拿空 → note 无 message_id →
``_find_reusable_user_input_row`` 的 entityId 路径失效（prev 路径仅在 prior_reset
时启用）→ 同一条消息落两轮（时间线「上面出现了两次」）。

修复：提取器保留 ``id``；重发 note 与 transcript 同 id → entityId 精确复用。

Run: cd backend && python -m pytest tests/test_v4_remint_user_input_dedup.py -v
"""

from __future__ import annotations

import json
from typing import Any

import pytest

from app.gateway.routers.langgraph_proxy import (
    _extract_messages_for_mission_bootstrap,
    _extract_user_message_id_from_stream_body,
)
from app.gateway.v4.agui_mirror import V4Mirror
from app.gateway.v4.conversation import HUB


def test_extract_user_message_id_from_stream_body() -> None:
    """重发 body 最后一条 human 的 id 必须被提取（此前提取器丢 id 恒空）。"""
    body = json.dumps(
        {
            "input": {
                "messages": [
                    {"role": "user", "content": "上一轮", "id": "u-old"},
                    {"role": "assistant", "content": "答"},
                    {
                        "role": "user",
                        "content": [{"type": "text", "text": "再帮我调用"}],
                        "id": "u-new",
                    },
                ]
            }
        }
    ).encode("utf-8")
    assert _extract_user_message_id_from_stream_body(body) == "u-new"

    # 无 id（旧客户端/IM 路径）→ 空串，不得误取
    body_no_id = json.dumps({"input": {"messages": [{"role": "user", "content": "hi"}]}}).encode()
    assert _extract_user_message_id_from_stream_body(body_no_id) == ""
    # 其他调用方（text/attachments 提取）不受 id 字段增列影响
    msgs = _extract_messages_for_mission_bootstrap(body)
    assert msgs[-1]["role"] == "user"
    assert msgs[-1]["id"] == "u-new"


def _rows(tid: str) -> list[dict[str, Any]]:
    sess = HUB.get_session(tid)
    assert sess is not None
    return sorted(sess.rows.values(), key=lambda r: int(r["rowId"]))


@pytest.fixture()
def mirror_thread(monkeypatch: pytest.MonkeyPatch) -> str:
    monkeypatch.setattr("app.gateway.v4.agui_mirror._MIRROR_DISABLED", False)
    tid = "remint-dedup-test"
    if tid in getattr(HUB, "_sessions", {}):
        del HUB._sessions[tid]  # noqa: SLF001
    yield tid
    if tid in getattr(HUB, "_sessions", {}):
        del HUB._sessions[tid]  # noqa: SLF001


def _seed_rehydrated_rows(tid: str) -> None:
    """模拟 force-rehydrate 产物：transcript 里的本轮用户消息已进投影。

    与 hydration._hydrate 产物同形：turnHeader(completedSuccess, turnId=LG run id)
    + userInput(entityId=前端 userMsgId，两端同源)。种子行占 rowId 1-2 并推进
    会话 next_row_id（真实 hydrate 用会话计数器分配行 id，mirror 不得重叠）。
    """
    sess = HUB._get_or_create_session(tid)  # noqa: SLF001 — 同包协作
    sess.next_row_id = 3
    HUB.author_append_row(
        tid,
        {
            "rowId": 1,
            "turnId": "lg-run-f19c",
            "kind": "turnHeader",
            "origin": "userInput",
            "state": "completedSuccess",
            "startedAt": 1,
            "endedAt": 2,
            "createdAt": 1,
            "createdAtSeq": 0,
        },
    )
    HUB.author_append_row(
        tid,
        {
            "rowId": 2,
            "turnId": "lg-run-f19c",
            "kind": "userInput",
            "text": "再帮我调用，然后试一下我验证功能呢",
            "origin": "realUser",
            "entityId": "u-msg-1",
            "createdAt": 1,
            "createdAtSeq": 0,
            "actions": {"canEdit": True},
        },
    )


def test_remint_resend_reuses_rehydrated_user_row(mirror_thread: str) -> None:
    """remint 重发：note+RUN_STARTED 必须复用 rehydrate 行，不得再落一轮。"""
    tid = mirror_thread
    _seed_rehydrated_rows(tid)
    mirror = V4Mirror(HUB)
    # 前端重发 stream：同一条消息、同一个稳定 userMsgId
    mirror.note_user_input(tid, "再帮我调用，然后试一下我验证功能呢", message_id="u-msg-1")
    mirror.feed_events(tid, [{"type": "RUN_STARTED", "threadId": tid, "runId": "run-new"}])

    users = [r for r in _rows(tid) if r.get("kind") == "userInput"]
    assert len(users) == 1, f"重发不得重复落用户气泡: {users}"
    assert users[0]["entityId"] == "u-msg-1"
    assert users[0]["turnId"] == "run-new", "复用行应挂到新 turn"
    headers = [r for r in _rows(tid) if r.get("kind") == "turnHeader"]
    assert len(headers) == 2  # rehydrate 轮 + 重发运行轮（running）
    assert headers[-1]["state"] == "running"


def test_remint_resend_without_id_still_fresh_row(mirror_thread: str) -> None:
    """无 id 的重发（旧客户端）：entityId 路径不可用，保持现行为（新行）——
    文档化而非鼓励；id 路径修复后此形态只剩 IM/历史兼容面。"""
    tid = mirror_thread
    _seed_rehydrated_rows(tid)
    mirror = V4Mirror(HUB)
    mirror.note_user_input(tid, "再帮我调用，然后试一下我验证功能呢")
    mirror.feed_events(tid, [{"type": "RUN_STARTED", "threadId": tid, "runId": "run-new"}])
    users = [r for r in _rows(tid) if r.get("kind") == "userInput"]
    assert len(users) == 2  # 无 id 无从精确认领，不猜（对齐 ZCode「绝不猜」纪律）
    assert users[1].get("entityId", "") == ""
