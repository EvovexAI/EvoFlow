"""T2 — ``V4ConversationHub.send_command`` 的 stop / abort 路径单元测试。

不带 FastAPI、不发真实 wire 帧，纯 Python asyncio 跑 hub：

- stop 命令取消当前 turn task
- _run_turn 的 CancelledError 分支收敛为终态帧
  (turnHeader.state=completedInterrupted + assistantText.state=interrupted
   + phase=completedInterrupted)
- 没跑 turn 时再发 stop 返回 noop（不报错）
- 对不存在的 session 返回 rejected
- 同时接 'stop' 与 'abort' 两种命令名

Run: cd backend && python -m pytest tests/test_v4_conversation_stop.py -v
"""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

import pytest

# 后端 conftest 已把 app/ 与 evoflow/ 加到 sys.path
# 但为单元测试 hub 不需要 FastAPI 任何 import，这里显式 import 即可
from app.gateway.v4.conversation import (
    HUB as V4_CONVERSATION_HUB,
)
from app.gateway.v4 import conversation as conv_mod


@pytest.fixture(autouse=True)
def _reset_hub_sessions():
    """每个 case 之间清空 hub 的 sessions，避免相互污染。"""
    V4_CONVERSATION_HUB._sessions.clear()  # type: ignore[attr-defined]
    V4_CONVERSATION_HUB._subscriptions.clear()  # type: ignore[attr-defined]
    yield
    V4_CONVERSATION_HUB._sessions.clear()  # type: ignore[attr-defined]
    V4_CONVERSATION_HUB._subscriptions.clear()  # type: ignore[attr-defined]


def _make_echo_sess(session_id: str = "test-stop-1"):
    """直接造一个 _SessionState，跳过 createSession 命令面。"""
    from app.gateway.v4.conversation import _SessionState, _PHASE_RUNNING
    sess = _SessionState(session_id=session_id)
    sess.phase = _PHASE_RUNNING
    V4_CONVERSATION_HUB._sessions[session_id] = sess  # type: ignore[attr-defined]
    return sess


async def _wait_turn_done(sess, timeout: float = 2.0):
    """等 turn_task 结束（completed / cancelled 都算 done）。"""
    deadline = asyncio.get_event_loop().time() + timeout
    while asyncio.get_event_loop().time() < deadline:
        if sess.turn_task is None or sess.turn_task.done():
            return
        await asyncio.sleep(0.02)
    raise AssertionError("turn_task 2s 内未结束")


@pytest.mark.asyncio
async def test_stop_cancels_running_turn_and_writes_terminating_frames():
    """stop 命令 → turn_task 取消 → _run_turn CancelledError 分支写终态帧。"""
    # echo 模式不依赖 LLM env；sleep 路径能让 cancel 命中 await 点
    os.environ.pop("EVOFLOW_V4_LLM", None)
    sess = _make_echo_sess("test-stop-A")
    V4_CONVERSATION_HUB._start_turn(sess, "请给我讲个长故事，长到停不下来那种")  # type: ignore[attr-defined]
    # 等 turn 真正开始（_run_turn 头部 _patch_phase 已发出 + assistant row 已 append）
    await asyncio.sleep(0.05)
    assert sess.turn_task is not None
    assert not sess.turn_task.done()

    # 发 stop 命令
    ack = await V4_CONVERSATION_HUB.send_command({
        "type": "stop",
        "commandId": "cmd-stop-1",
        "sessionId": "test-stop-A",
        "payload": {},
    })
    assert ack["status"] == "accepted", ack
    assert ack["commandId"] == "cmd-stop-1"

    # 等 turn 收尾
    await _wait_turn_done(sess)

    # 终态断言
    header_rows = [r for r in sess.rows.values() if r["kind"] == "turnHeader"]
    assert len(header_rows) == 1
    assert header_rows[0]["state"] == "completedInterrupted", header_rows[0]
    assert "endedAt" in header_rows[0]

    assistant_rows = [r for r in sess.rows.values() if r["kind"] == "assistantText"]
    assert len(assistant_rows) == 1
    assert assistant_rows[0]["state"] == "interrupted", assistant_rows[0]

    assert sess.phase == "completedInterrupted", sess.phase
    # 后续再发 stop 应返回 noop（不再有运行中 turn）
    ack2 = await V4_CONVERSATION_HUB.send_command({
        "type": "stop",
        "commandId": "cmd-stop-2",
        "sessionId": "test-stop-A",
        "payload": {},
    })
    assert ack2["status"] == "noop", ack2
    assert ack2["reasonCode"] == "noRunningTurn"


@pytest.mark.asyncio
async def test_abort_alias_works_same_as_stop():
    """type='abort' 与 type='stop' 等价（旧命名兼容）。"""
    os.environ.pop("EVOFLOW_V4_LLM", None)
    sess = _make_echo_sess("test-abort-1")
    V4_CONVERSATION_HUB._start_turn(sess, "再来一个超长输入")  # type: ignore[attr-defined]
    await asyncio.sleep(0.05)

    ack = await V4_CONVERSATION_HUB.send_command({
        "type": "abort",
        "commandId": "cmd-abort-1",
        "sessionId": "test-abort-1",
        "payload": {},
    })
    assert ack["status"] == "accepted", ack
    await _wait_turn_done(sess)
    assert sess.phase == "completedInterrupted"


@pytest.mark.asyncio
async def test_stop_on_unknown_session_rejected():
    ack = await V4_CONVERSATION_HUB.send_command({
        "type": "stop",
        "commandId": "cmd-stop-X",
        "sessionId": "ghost-session",
        "payload": {},
    })
    assert ack["status"] == "rejected", ack
    assert ack["reasonCode"] == "sessionNotFound"


@pytest.mark.asyncio
async def test_stop_on_idle_session_is_noop():
    """没有 turn_task 的 session 收 stop 直接 noop（v4 shell 静默处理）。"""
    sess = _make_echo_sess("test-idle-1")
    # 故意不 _start_turn
    assert sess.turn_task is None
    ack = await V4_CONVERSATION_HUB.send_command({
        "type": "stop",
        "commandId": "cmd-stop-idle",
        "sessionId": "test-idle-1",
        "payload": {},
    })
    assert ack["status"] == "noop", ack
    assert ack["reasonCode"] == "noRunningTurn"


def test_minimal_control_can_stop_false_after_interrupted_phase():
    """control.canStop 必须在 interrupted 态为 False（前端据此隐藏 Stop）。"""
    from app.gateway.v4.conversation import _minimal_control
    ctrl = _minimal_control("completedInterrupted")
    assert ctrl["canStop"] is False
    assert ctrl["stopState"] == "idle"
    assert ctrl["phase"] == "completedInterrupted"
