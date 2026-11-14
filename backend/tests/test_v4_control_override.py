"""control patch 真值化（生命周期四件套第 1 件 / Phase A）单元测试。

核心契约：**snapshot 与增量的 control 同源**。

- mirror 打的 control 经 hub.set_control_override 落会话态，快照重建
  （刷新重订阅 / recovery / 溢出转 snapshot）不再被 _minimal_control(sess.phase)
  重算覆盖（旧实现主聊 sess.phase 停在 draft，快照 control 永远 draft+canStop:false）
- 终态语义对齐 ZCode：成功/中断 sessionEnded=True；error 可重试=False
- hub 自跑 turn 接管（patch_phase）时 override 让位

Run: cd backend && python -m pytest tests/test_v4_control_override.py -v
"""

from __future__ import annotations

from typing import Any

import pytest

from app.gateway.v4.agui_mirror import V4Mirror
from app.gateway.v4.conversation import (
    HUB,
    _minimal_control,
)


def _sess(session_id: str) -> Any:
    sess = HUB.get_session(session_id)
    assert sess is not None
    return sess


def _snapshot(session_id: str) -> dict[str, Any]:
    return HUB._build_snapshot(_sess(session_id))  # noqa: SLF001


def _control_deltas(session_id: str) -> list[dict[str, Any]]:
    """delta_log 里按序提取所有 control state.updated patch。"""
    sess = _sess(session_id)
    out: list[dict[str, Any]] = []
    for _seq, delta in sess.delta_log:
        if not isinstance(delta, dict) or delta.get("op") != "state.updated":
            continue
        patch = delta.get("patch") or {}
        if isinstance(patch.get("control"), dict):
            out.append(patch["control"])
    return out


@pytest.fixture()
def mirror_session(monkeypatch: pytest.MonkeyPatch) -> str:
    monkeypatch.setattr("app.gateway.v4.agui_mirror._MIRROR_DISABLED", False)
    return "control-override-test"


def _fresh_thread(mirror_session: str, tag: str) -> str:
    tid = f"{mirror_session}-{tag}"
    if tid in getattr(HUB, "_sessions", {}):
        del HUB._sessions[tid]  # noqa: SLF001
    return tid


def test_snapshot_control_matches_last_delta_while_running(mirror_session: str) -> None:
    """运行中新订阅拿到的快照 control 必须与最后一个 control 增量一致（同源）。"""
    tid = _fresh_thread(mirror_session, "running")
    mirror = V4Mirror(HUB)
    mirror.note_user_input(tid, "第一问")
    mirror.feed_events(
        tid,
        [
            {"type": "RUN_STARTED", "threadId": tid, "runId": "run-1"},
            {"type": "TEXT_MESSAGE_START", "messageId": "m1"},
            {"type": "TEXT_MESSAGE_CONTENT", "messageId": "m1", "delta": "答"},
        ],
    )

    deltas = _control_deltas(tid)
    assert deltas, "RUN_STARTED 必须发 running control 增量"
    snap = _snapshot(tid)
    # 快照与最后一个增量逐字段一致——这是本件的核心契约
    assert snap["control"] == deltas[-1]
    assert snap["control"]["phase"] == "running"
    assert snap["control"]["canStop"] is True
    assert snap["control"]["stopState"] == "stoppable"
    works = snap["control"]["activeWorks"]
    assert len(works) == 1 and works[0]["kind"] == "primaryTurn"
    # override 落会话态（phase 同步派生，inputRouting 同源）
    assert _sess(tid).control_override is not None
    assert _sess(tid).phase == "running"


def test_terminal_control_semantics(mirror_session: str) -> None:
    """三种终态：成功 sessionEnded=True；error 可重试 False；用户中断 interrupted。"""
    # ① 成功收尾
    tid_ok = _fresh_thread(mirror_session, "ok")
    mirror = V4Mirror(HUB)
    mirror.note_user_input(tid_ok, "问")
    mirror.feed_events(
        tid_ok,
        [
            {"type": "RUN_STARTED", "threadId": tid_ok, "runId": "run-ok"},
            {"type": "TEXT_MESSAGE_START", "messageId": "m-ok"},
            {"type": "TEXT_MESSAGE_CONTENT", "messageId": "m-ok", "delta": "答"},
            {"type": "TEXT_MESSAGE_END", "messageId": "m-ok"},
            {"type": "RUN_FINISHED", "threadId": tid_ok, "runId": "run-ok"},
        ],
    )
    ctrl_ok = _snapshot(tid_ok)["control"]
    assert ctrl_ok["phase"] == "completedSuccess"
    assert ctrl_ok["sessionEnded"] is True
    assert ctrl_ok["canStop"] is False
    assert ctrl_ok["stopState"] == "idle"
    assert ctrl_ok["activeWorks"] == []
    assert ctrl_ok == _control_deltas(tid_ok)[-1]

    # ② 模型错误：error 可重试 → sessionEnded=False（ZCode onTurnError 语义）
    tid_err = _fresh_thread(mirror_session, "err")
    mirror.feed_events(
        tid_err,
        [
            {"type": "RUN_STARTED", "threadId": tid_err, "runId": "run-err"},
            {
                "type": "RUN_ERROR",
                "code": "provider_error",
                "message": "boom",
                "threadId": tid_err,
            },
        ],
    )
    ctrl_err = _snapshot(tid_err)["control"]
    assert ctrl_err["phase"] == "error"
    assert ctrl_err["sessionEnded"] is False
    assert ctrl_err["canStop"] is False
    last_error = ctrl_err["lastError"]
    assert isinstance(last_error, dict) and last_error.get("code") == "provider_error"

    # ③ 用户停止：completedInterrupted 正常结束
    tid_stop = _fresh_thread(mirror_session, "stop")
    mirror.note_user_input(tid_stop, "问")
    mirror.feed_events(
        tid_stop,
        [{"type": "RUN_STARTED", "threadId": tid_stop, "runId": "run-stop"}],
    )
    mirror.feed_events(
        tid_stop,
        [
            {
                "type": "RUN_ERROR",
                "code": "USER_INTERRUPT",
                "message": "user_interrupt",
                "threadId": tid_stop,
            }
        ],
    )
    ctrl_stop = _snapshot(tid_stop)["control"]
    assert ctrl_stop["phase"] == "completedInterrupted"
    assert ctrl_stop["sessionEnded"] is True
    assert ctrl_stop["canStop"] is False
    assert ctrl_stop["activeWorks"] == []


def test_minimal_control_running_fallback_carries_primary_turn() -> None:
    """fallback（无 override）路径：running 也补 activeWorks，驱动前端 control-first。"""
    ctrl = _minimal_control("running", run_started_at=1234)
    assert ctrl["canStop"] is True
    assert ctrl["sessionEnded"] is False
    assert ctrl["activeWorks"] == [{"kind": "primaryTurn", "startedAt": 1234}]
    # error 可重试不算 ended；draft/prewarming 空转
    assert _minimal_control("error")["sessionEnded"] is False
    assert _minimal_control("completedSuccess")["sessionEnded"] is True
    assert _minimal_control("draft")["activeWorks"] == []


def test_hub_turn_patch_phase_clears_override(mirror_session: str) -> None:
    """hub 自跑 turn 接管：patch_phase 清 override，谁拥有执行权谁写 control。"""
    tid = _fresh_thread(mirror_session, "hub-takeover")
    mirror = V4Mirror(HUB)
    mirror.note_user_input(tid, "问")
    mirror.feed_events(
        tid,
        [{"type": "RUN_STARTED", "threadId": tid, "runId": "run-1"}],
    )
    assert _sess(tid).control_override is not None

    # hub 接管 phase（_run_turn 头部即调 patch_phase(running)）
    HUB.patch_phase(tid, "running")
    sess = _sess(tid)
    assert sess.control_override is None
    assert sess.run_started_at is not None
    snap = _snapshot(tid)["control"]
    # fallback control：running + primaryTurn startedAt 来自 patch_phase 记录
    assert snap["phase"] == "running"
    assert snap["canStop"] is True
    assert snap["activeWorks"][0]["kind"] == "primaryTurn"
    assert snap["activeWorks"][0]["startedAt"] == sess.run_started_at

    # 终态：override 仍空、activeWorks 收口
    HUB.patch_phase(tid, "completedSuccess")
    sess2 = _sess(tid)
    assert sess2.control_override is None
    assert sess2.run_started_at is None
    snap2 = _snapshot(tid)["control"]
    assert snap2["canStop"] is False
    assert snap2["sessionEnded"] is True
    assert snap2["activeWorks"] == []
