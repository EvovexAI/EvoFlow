"""v4 command 层 — queue / admission / idempotency 单元测试。

对齐 ZCode v3.15.1 命令层语义（docs/contribute/v3.15.1-port-plan.md §1/§2）：

- sendText 路由：idle 直接开 turn；running 按 requestedDelivery/followupMode 入队
- queue CRUD：edit（compact 拒绝）/ delete（未命中 noop）/ reorder / sendQueuedNow
- setAutoDrain：stop 暂停（autoDrain=false + pauseReason=stopped）、恢复即 drain
- 自动 drain：自然完成后提升队首；error/interrupted 不续跑
- admission 幂等：同 commandId 重放 → duplicate；CAS 命令缺 baseRevision → 拒绝；
  baseRevision 过期 → stale

Run: cd backend && python -m pytest tests/test_v4_command_queue.py -v
"""

from __future__ import annotations

import asyncio
import os

import pytest

from app.gateway.v4.conversation import (
    HUB as V4_CONVERSATION_HUB,
)
from app.gateway.v4.conversation import _PHASE_RUNNING, _SessionState


@pytest.fixture(autouse=True)
def _reset_hub_sessions():
    V4_CONVERSATION_HUB._sessions.clear()  # type: ignore[attr-defined]
    V4_CONVERSATION_HUB._subscriptions.clear()  # type: ignore[attr-defined]
    yield
    V4_CONVERSATION_HUB._sessions.clear()  # type: ignore[attr-defined]
    V4_CONVERSATION_HUB._subscriptions.clear()  # type: ignore[attr-defined]


@pytest.fixture(autouse=True)
def _echo_mode():
    os.environ.pop("EVOFLOW_V4_LLM", None)


def _make_sess(session_id: str) -> _SessionState:
    sess = _SessionState(session_id=session_id)
    V4_CONVERSATION_HUB._sessions[session_id] = sess  # type: ignore[attr-defined]
    return sess


def _long(text: str) -> str:
    """echo 20ms/64 字符块：>128 字符保证 turn 在断言窗口内仍在运行。"""
    return text * (160 // max(len(text), 1) + 1) + text


async def _wait_turn_done(sess, timeout: float = 3.0):
    deadline = asyncio.get_event_loop().time() + timeout
    while asyncio.get_event_loop().time() < deadline:
        if sess.turn_task is None or sess.turn_task.done():
            return
        await asyncio.sleep(0.02)
    raise AssertionError("turn_task 3s 内未结束")


async def _cmd(session_id: str, type_: str, payload: dict, command_id: str, **extra) -> dict:
    envelope = {
        "type": type_,
        "commandId": command_id,
        "sessionId": session_id,
        "payload": payload,
        **extra,
    }
    return await V4_CONVERSATION_HUB.send_command(envelope)  # type: ignore[attr-defined]


# row-targeting 命令的 baseLogEpoch（hub 默认 log_epoch="1"）
_BASE_LOG_EPOCH = {"baseLogEpoch": "1"}


# ── sendText 路由 ─────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_send_text_idle_starts_turn():
    sess = _make_sess("q-idle")
    ack = await _cmd("q-idle", "sendText", {"text": "hello"}, "cmd-1")
    assert ack["status"] == "accepted", ack
    assert sess.turn_task is not None
    await _wait_turn_done(sess)


@pytest.mark.asyncio
async def test_send_text_running_without_delivery_enqueues_by_followup_mode():
    sess = _make_sess("q-followup")
    V4_CONVERSATION_HUB._start_turn(sess, _long("第一轮"))  # type: ignore[attr-defined]
    assert sess.turn_running()
    ack = await _cmd("q-followup", "sendText", {"text": "第二条"}, "cmd-2")
    assert ack["status"] == "accepted", ack
    assert ack["result"]["input"]["delivery"] == "queue"
    assert len(sess.queue_items) == 1
    assert sess.queue_items[0]["sourceCommandId"] == "cmd-2"
    assert sess.queue_items[0]["delivery"]["requested"] == "queue"
    await _wait_turn_done(sess)


@pytest.mark.asyncio
async def test_send_text_running_start_now_rejected_busy():
    sess = _make_sess("q-busy")
    V4_CONVERSATION_HUB._start_turn(sess, _long("第一轮"))  # type: ignore[attr-defined]
    ack = await _cmd(
        "q-busy", "sendText", {"text": "抢占", "requestedDelivery": "startNow"}, "cmd-3"
    )
    assert ack["status"] == "rejected", ack
    assert ack["reasonCode"] == "busy"
    assert sess.queue_items == []
    # 收尾：等 turn 自然结束
    await _wait_turn_done(sess)


# ── queue CRUD ────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_queue_edit_reorder_delete():
    sess = _make_sess("q-crud")
    V4_CONVERSATION_HUB._start_turn(sess, _long("占用"))  # type: ignore[attr-defined]
    await _cmd("q-crud", "sendText", {"text": "甲"}, "cmd-a")
    await _cmd("q-crud", "sendText", {"text": "乙"}, "cmd-b")

    # edit
    ack = await _cmd(
        "q-crud",
        "editQueueItem",
        {"queueItemId": "queue_cmd-a", "newText": "甲改"},
        "cmd-edit",
        baseRevision=sess.revision,
    )
    assert ack["status"] == "accepted", ack
    assert sess.queue_items[0]["text"] == "甲改"

    # reorder：乙 移到甲 前
    ack = await _cmd(
        "q-crud",
        "reorderQueueItem",
        {"queueItemId": "queue_cmd-b", "beforeQueueItemId": "queue_cmd-a"},
        "cmd-reorder",
        baseRevision=sess.revision,
    )
    assert ack["status"] == "accepted", ack
    assert [i["queueItemId"] for i in sess.queue_items] == ["queue_cmd-b", "queue_cmd-a"]

    # delete
    ack = await _cmd(
        "q-crud",
        "deleteQueueItem",
        {"queueItemId": "queue_cmd-b"},
        "cmd-del",
        baseRevision=sess.revision,
    )
    assert ack["status"] == "accepted", ack
    assert [i["queueItemId"] for i in sess.queue_items] == ["queue_cmd-a"]

    # 重复 delete → noop（并发竞态语义）
    ack = await _cmd(
        "q-crud",
        "deleteQueueItem",
        {"queueItemId": "queue_cmd-b"},
        "cmd-del-2",
        baseRevision=sess.revision,
    )
    assert ack["status"] == "noop", ack
    assert ack["reasonCode"] == "queue.itemMissing"
    await _wait_turn_done(sess)


@pytest.mark.asyncio
async def test_send_queued_now_rejected_while_running_promotes_when_idle():
    sess = _make_sess("q-promote")
    V4_CONVERSATION_HUB._start_turn(sess, _long("占用"))  # type: ignore[attr-defined]
    await _cmd("q-promote", "sendText", {"text": "插队项"}, "cmd-p")
    assert len(sess.queue_items) == 1

    # running 时提升被拒
    ack = await _cmd(
        "q-promote",
        "sendQueuedNow",
        {"queueItemId": "queue_cmd-p"},
        "cmd-promote-1",
        baseRevision=sess.revision,
    )
    assert ack["status"] == "rejected", ack
    assert ack["reasonCode"] == "guard.queuePromotionBusy"
    assert len(sess.queue_items) == 1

    # 等 turn 结束 → 队首被 auto-drain 消费（autoDrain 默认开）
    await _wait_turn_done(sess)
    assert sess.queue_items == [], sess.queue_state()


# ── stop 暂停队列 / setAutoDrain ──────────────────────────────────────────────


@pytest.mark.asyncio
async def test_stop_pauses_queue_and_set_auto_drain_resumes():
    sess = _make_sess("q-pause")
    V4_CONVERSATION_HUB._start_turn(sess, _long("占用"))  # type: ignore[attr-defined]
    await _cmd("q-pause", "sendText", {"text": "排队一"}, "cmd-x")

    ack = await _cmd("q-pause", "stop", {}, "cmd-stop")
    assert ack["status"] == "accepted", ack
    await _wait_turn_done(sess)
    assert sess.phase == "completedInterrupted"
    assert sess.auto_drain is False
    assert sess.pause_reason == "stopped"
    # interrupted 不自动续跑：队列保持
    assert len(sess.queue_items) == 1

    # 恢复：idle + 授权 → 立即 drain 队首
    ack = await _cmd("q-pause", "setAutoDrain", {"autoDrain": True}, "cmd-resume", baseRevision=sess.revision)
    assert ack["status"] == "accepted", ack
    assert sess.auto_drain is True
    assert sess.pause_reason is None
    assert len(sess.queue_items) == 0
    assert sess.turn_running()
    await _wait_turn_done(sess)


# ── admission 幂等 / CAS ──────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_duplicate_command_id_returns_duplicate():
    sess = _make_sess("q-idem")
    ack1 = await _cmd("q-idem", "sendText", {"text": "第一条"}, "cmd-dup")
    ack2 = await _cmd("q-idem", "sendText", {"text": "第一条"}, "cmd-dup")
    assert ack1["status"] == "accepted"
    assert ack2["status"] == "duplicate", ack2
    assert ack2["commandId"] == "cmd-dup"
    await _wait_turn_done(sess)


@pytest.mark.asyncio
async def test_cas_commands_require_base_revision():
    sess = _make_sess("q-cas")
    ack = await _cmd("q-cas", "setAutoDrain", {"autoDrain": False}, "cmd-nobase")
    assert ack["status"] == "rejected", ack
    assert ack["reasonCode"] == "proto.missingBaseRevision"

    ack = await _cmd("q-cas", "setAutoDrain", {"autoDrain": False}, "cmd-stale", baseRevision=999)
    assert ack["status"] == "stale", ack
    assert ack["reasonCode"] == "proto.staleRevision"

    ack = await _cmd("q-cas", "setAutoDrain", {"autoDrain": False}, "cmd-ok", baseRevision=0)
    assert ack["status"] == "accepted", ack


@pytest.mark.asyncio
async def test_unsupported_command_explicitly_rejected():
    _make_sess("q-unsup")
    ack = await _cmd("q-unsup", "forkAssistant", {}, "cmd-fork", baseRevision=0, **_BASE_LOG_EPOCH)
    assert ack["status"] == "rejected", ack
    assert ack["reasonCode"] == "unsupportedCommand"


@pytest.mark.asyncio
async def test_assistant_feedback_accepted_and_recorded():
    sess = _make_sess("q-fb")
    ack = await _cmd(
        "q-fb",
        "setAssistantFeedback",
        {"target": {"rowId": 3}, "feedback": "like"},
        "cmd-fb",
        baseRevision=0,
        **_BASE_LOG_EPOCH,
    )
    assert ack["status"] == "accepted", ack
    assert sess.feedbacks == {"3": "like"}


@pytest.mark.asyncio
async def test_snapshot_carries_queue_state():
    sess = _make_sess("q-snap")
    V4_CONVERSATION_HUB._start_turn(sess, _long("占用"))  # type: ignore[attr-defined]
    await _cmd("q-snap", "sendText", {"text": "排队"}, "cmd-s")
    snap = V4_CONVERSATION_HUB._build_snapshot(sess)  # type: ignore[attr-defined]
    assert snap["queue"]["autoDrain"] is True
    assert len(snap["queue"]["items"]) == 1
    item = snap["queue"]["items"][0]
    assert item["dispatch"]["state"] == "queued"
    assert item["order"]["queuePosition"] == 0
    assert item["delivery"] == {"requested": "queue", "admitted": "queue"}
    assert snap["inputRouting"] == {"mode": "enqueue"}
    await _wait_turn_done(sess)
