"""V4 RUN_ERROR → lastError must expose copyable detail for user feedback."""

from __future__ import annotations

from typing import Any

import pytest

from app.gateway.agui_stream_normalizer import AgUiEncoderState, RUN_ERROR, evf_payload_to_agui_events
from app.gateway.v4.agui_mirror import (
    V4Mirror,
    _is_user_interrupt_event,
    _run_error_info,
    mirror_seal_user_stop,
)
from app.gateway.v4.conversation import HUB


def test_run_error_info_schema_failure() -> None:
    info = _run_error_info(
        {
            "code": "PydanticInvalidForJsonSchema",
            "message": (
                "Failed to generate JSON schema for 'knowledge': "
                "Cannot generate a JsonSchema for core_schema.CallableSchema"
            ),
        },
        now_ms=1,
    )
    assert info["code"] == "PydanticInvalidForJsonSchema"
    assert "knowledge" in info["message"]
    assert "复制" in info["message"]
    assert "CallableSchema" in info["detail"]
    assert info["source"] == "runtime"


def test_run_error_info_bare_run_error_is_actionable() -> None:
    info = _run_error_info({"code": "run_error", "message": "run_error"}, now_ms=2)
    assert info["code"] == "run_error"
    assert "负载" in info["message"] or "中断" in info["message"]
    assert "开新会话" in info["message"]
    assert "上游未返回" in info["detail"]
    assert info["recoverable"] is True


def test_run_error_info_remote_disconnect() -> None:
    info = _run_error_info(
        {
            "code": "ERROR",
            "message": "httpx.RemoteProtocolError: Server disconnected without sending a response.",
        },
        now_ms=3,
    )
    assert "连接中断" in info["message"]
    assert info["recoverable"] is True


def test_agui_error_dict_extracts_message() -> None:
    state = AgUiEncoderState(thread_id="t1", run_id="r1")
    events = evf_payload_to_agui_events(
        {
            "type": "error",
            "error": {
                "error": "PydanticInvalidForJsonSchema",
                "message": "Failed to generate JSON schema for 'knowledge'",
            },
        },
        state=state,
    )
    err = next(e for e in events if e.get("type") == RUN_ERROR)
    assert err["code"] == "PydanticInvalidForJsonSchema"
    assert err["message"] == "Failed to generate JSON schema for 'knowledge'"
    assert "{" not in err["message"]


@pytest.mark.parametrize(
    "ev",
    [
        {"code": "USER_INTERRUPT", "message": "user_interrupt"},
        {"code": "ABORTED", "message": "user_interrupt"},
        {"code": "ERROR", "message": "User interrupted"},
        {"code": "user_interrupt", "message": ""},
    ],
)
def test_is_user_interrupt_event(ev: dict[str, Any]) -> None:
    assert _is_user_interrupt_event(ev) is True


def test_is_user_interrupt_event_rejects_real_errors() -> None:
    assert _is_user_interrupt_event({"code": "ERROR", "message": "timeout contacting vendor"}) is False


def _rows(session_id: str) -> list[dict[str, Any]]:
    sess = HUB.get_session(session_id)
    assert sess is not None
    return sorted(sess.rows.values(), key=lambda r: int(r["rowId"]))


def _latest_control_patch(session_id: str) -> dict[str, Any] | None:
    sess = HUB.get_session(session_id)
    assert sess is not None
    control = None
    for _seq, delta in sess.delta_log:
        if delta.get("op") != "state.updated":
            continue
        patch = delta.get("patch") or {}
        if "control" in patch and isinstance(patch["control"], dict):
            control = patch["control"]
    return control


def test_user_interrupt_run_error_is_interrupted_not_error_banner(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("app.gateway.v4.agui_mirror._MIRROR_DISABLED", False)
    tid = "mirror-user-interrupt-test"
    if tid in getattr(HUB, "_sessions", {}):
        del HUB._sessions[tid]  # noqa: SLF001
    mirror = V4Mirror(HUB)
    mirror.note_user_input(tid, "hi")
    mirror.feed_events(
        tid,
        [
            {"type": "RUN_STARTED", "threadId": tid, "runId": "run-stop"},
            {"type": "RUN_ERROR", "code": "USER_INTERRUPT", "message": "user_interrupt"},
        ],
    )
    headers = [r for r in _rows(tid) if r.get("kind") == "turnHeader"]
    assert headers
    assert headers[-1]["state"] == "completedInterrupted"
    texts = [r for r in _rows(tid) if r.get("kind") == "assistantText"]
    assert not any("详情" in str(r.get("text") or "") for r in texts)
    assert not any("user_interrupt" in str(r.get("text") or "") for r in texts)
    ctrl = _latest_control_patch(tid)
    assert ctrl is not None
    assert ctrl["phase"] == "completedInterrupted"
    assert ctrl["lastError"] is None


def test_late_user_interrupt_does_not_downgrade_completed_success(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Queue auto-send / send_prep race must not rewrite success →「用户停止」."""
    monkeypatch.setattr("app.gateway.v4.agui_mirror._MIRROR_DISABLED", False)
    tid = "mirror-late-interrupt-after-success"
    if tid in getattr(HUB, "_sessions", {}):
        del HUB._sessions[tid]  # noqa: SLF001
    mirror = V4Mirror(HUB)
    mirror.note_user_input(tid, "hi")
    mirror.feed_events(
        tid,
        [
            {"type": "RUN_STARTED", "threadId": tid, "runId": "run-ok"},
            {"type": "TEXT_MESSAGE_START", "messageId": "m1", "role": "assistant"},
            {"type": "TEXT_MESSAGE_CONTENT", "messageId": "m1", "delta": "done"},
            {"type": "TEXT_MESSAGE_END", "messageId": "m1"},
            {"type": "RUN_FINISHED", "threadId": tid, "runId": "run-ok"},
        ],
    )
    headers = [r for r in _rows(tid) if r.get("kind") == "turnHeader"]
    assert headers
    assert headers[-1]["state"] == "completedSuccess"
    sealed_header_id = int(headers[-1]["rowId"])
    # FINISHED 会 reset ephemeral；模拟迟到 interrupt 仍指向已成功 header。
    st = mirror._states[tid]  # noqa: SLF001
    st.run_started = True
    st.turn_header_row_id = sealed_header_id
    mirror.feed_events(
        tid,
        [
            {
                "type": "RUN_ERROR",
                "code": "USER_INTERRUPT",
                "message": "user_interrupt",
                "threadId": tid,
                "runId": "run-ok",
            },
        ],
    )
    sealed = next(r for r in _rows(tid) if int(r["rowId"]) == sealed_header_id)
    assert sealed["state"] == "completedSuccess"


def test_run_finished_seals_open_tool_calls(monkeypatch: pytest.MonkeyPatch) -> None:
    """TOOL_CALL_END→running 后若无 RESULT，FINISHED 必须封掉，否则画布永久转圈。"""
    monkeypatch.setattr("app.gateway.v4.agui_mirror._MIRROR_DISABLED", False)
    tid = "mirror-seal-open-tools"
    if tid in getattr(HUB, "_sessions", {}):
        del HUB._sessions[tid]  # noqa: SLF001
    mirror = V4Mirror(HUB)
    mirror.note_user_input(tid, "hi")
    mirror.feed_events(
        tid,
        [
            {"type": "RUN_STARTED", "threadId": tid, "runId": "run-seal"},
            {
                "type": "TOOL_CALL_START",
                "toolCallId": "tc-open",
                "toolCallName": "web_search",
            },
            {"type": "TOOL_CALL_ARGS", "toolCallId": "tc-open", "delta": "{}"},
            {"type": "TOOL_CALL_END", "toolCallId": "tc-open"},
            {"type": "RUN_FINISHED", "threadId": tid, "runId": "run-seal"},
        ],
    )
    tools = [r for r in _rows(tid) if r.get("kind") == "toolCall"]
    assert tools
    assert tools[-1]["status"] == "cancelled"
    headers = [r for r in _rows(tid) if r.get("kind") == "turnHeader"]
    assert headers[-1]["state"] == "completedSuccess"


def test_mirror_seal_user_stop_seals_tools_and_reasoning(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """点停不经在途 RUN_ERROR：mirror_seal_user_stop 必须立刻封工具/思考。"""
    monkeypatch.setattr("app.gateway.v4.agui_mirror._MIRROR_DISABLED", False)
    tid = "mirror-seal-user-stop-live"
    if tid in getattr(HUB, "_sessions", {}):
        del HUB._sessions[tid]  # noqa: SLF001
    # 走全局镜像入口（与 stop_session_execution 同路径）
    import app.gateway.v4.agui_mirror as mirror_mod

    mirror_mod._MIRROR = V4Mirror(HUB)  # noqa: SLF001
    mirror = mirror_mod._MIRROR
    mirror.note_user_input(tid, "改全屏")
    mirror.feed_events(
        tid,
        [
            {"type": "RUN_STARTED", "threadId": tid, "runId": "run-stop-live"},
            {"type": "REASONING_MESSAGE_START", "messageId": "r1"},
            {"type": "REASONING_MESSAGE_CONTENT", "messageId": "r1", "delta": "找源码"},
            {
                "type": "TOOL_CALL_START",
                "toolCallId": "tc-bash",
                "toolCallName": "bash",
            },
            {"type": "TOOL_CALL_END", "toolCallId": "tc-bash"},
            {
                "type": "TEXT_MESSAGE_START",
                "messageId": "a1",
                "role": "assistant",
            },
            {"type": "TEXT_MESSAGE_CONTENT", "messageId": "a1", "delta": "半截"},
        ],
    )
    mirror_seal_user_stop(tid)
    headers = [r for r in _rows(tid) if r.get("kind") == "turnHeader"]
    assert headers[-1]["state"] == "completedInterrupted"
    tools = [r for r in _rows(tid) if r.get("kind") == "toolCall"]
    assert tools and tools[-1]["status"] == "cancelled"
    reasoning = [r for r in _rows(tid) if r.get("kind") == "reasoning"]
    assert reasoning and reasoning[-1]["state"] == "interrupted"
    texts = [r for r in _rows(tid) if r.get("kind") == "assistantText"]
    assert texts and texts[-1]["state"] == "interrupted"
    st = mirror._states[tid]  # noqa: SLF001
    assert st.run_started is False


def test_run_started_after_open_prior_seals_orphan_tools(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """上一轮漏 FINISHED 时，新 RUN_STARTED 也要封掉孤儿工具卡。"""
    monkeypatch.setattr("app.gateway.v4.agui_mirror._MIRROR_DISABLED", False)
    tid = "mirror-prior-reset-seal-tools"
    if tid in getattr(HUB, "_sessions", {}):
        del HUB._sessions[tid]  # noqa: SLF001
    mirror = V4Mirror(HUB)
    mirror.note_user_input(tid, "first")
    mirror.feed_events(
        tid,
        [
            {"type": "RUN_STARTED", "threadId": tid, "runId": "run-old"},
            {
                "type": "TOOL_CALL_START",
                "toolCallId": "tc-orphan",
                "toolCallName": "bash",
            },
            {"type": "TOOL_CALL_END", "toolCallId": "tc-orphan"},
        ],
    )
    mirror.note_user_input(tid, "second")
    mirror.feed_events(
        tid,
        [{"type": "RUN_STARTED", "threadId": tid, "runId": "run-new"}],
    )
    tools = [r for r in _rows(tid) if r.get("kind") == "toolCall"]
    assert tools
    assert tools[0]["status"] == "cancelled"
    headers = [r for r in _rows(tid) if r.get("kind") == "turnHeader"]
    assert any(h.get("state") == "failed" for h in headers)
    assert headers[-1]["state"] == "running"
