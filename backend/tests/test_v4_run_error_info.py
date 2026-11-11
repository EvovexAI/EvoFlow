"""V4 RUN_ERROR → lastError must expose copyable detail for user feedback."""

from __future__ import annotations

from typing import Any

import pytest

from app.gateway.agui_stream_normalizer import AgUiEncoderState, RUN_ERROR, evf_payload_to_agui_events
from app.gateway.v4.agui_mirror import V4Mirror, _is_user_interrupt_event, _run_error_info
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
