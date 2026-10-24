"""ACTIVITY_SNAPSHOT retrying/model_error must project into V4 control + text."""

from __future__ import annotations

from typing import Any

import pytest

from app.gateway.v4.agui_mirror import V4Mirror
from app.gateway.v4.conversation import HUB

_FREE_TIER = (
    "You've reached the API rate limit for free users. "
    "Upgrade to a Token Plan to unlock higher limits."
)


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


@pytest.fixture()
def mirror_session(monkeypatch: pytest.MonkeyPatch) -> str:
    monkeypatch.setattr("app.gateway.v4.agui_mirror._MIRROR_DISABLED", False)
    sid = "mirror-activity-retry-test"
    if sid in getattr(HUB, "_sessions", {}):
        del HUB._sessions[sid]  # noqa: SLF001
    return sid


def test_activity_retrying_sets_api_retry_with_vendor_detail(mirror_session: str) -> None:
    tid = mirror_session
    mirror = V4Mirror(HUB)
    mirror.note_user_input(tid, "a")
    mirror.feed_events(
        tid,
        [
            {"type": "RUN_STARTED", "threadId": tid, "runId": "run-rl"},
            {
                "type": "ACTIVITY_SNAPSHOT",
                "messageId": "activity-0",
                "activityType": "system",
                "content": {
                    "kind": "retrying",
                    "detail": _FREE_TIER,
                    "attempt": 1,
                    "max_attempts": 3,
                    "wait_s": 2.0,
                    "reason": "rate_limit",
                },
            },
        ],
    )
    ctrl = _latest_control_patch(tid)
    assert ctrl is not None
    assert ctrl["phase"] == "running"
    assert ctrl["apiRetry"] is not None
    assert ctrl["apiRetry"]["attempt"] == 1
    assert ctrl["apiRetry"]["maxAttempts"] == 4  # retries + first try
    assert _FREE_TIER in ctrl["apiRetry"]["reasonCode"]


def test_activity_model_error_sets_last_error_and_assistant_text(mirror_session: str) -> None:
    tid = mirror_session + "-err"
    if tid in getattr(HUB, "_sessions", {}):
        del HUB._sessions[tid]  # noqa: SLF001
    mirror = V4Mirror(HUB)
    mirror.note_user_input(tid, "a")
    mirror.feed_events(
        tid,
        [
            {"type": "RUN_STARTED", "threadId": tid, "runId": "run-err"},
            {
                "type": "ACTIVITY_SNAPSHOT",
                "messageId": "activity-0",
                "activityType": "system",
                "content": {
                    "kind": "model_error",
                    "detail": _FREE_TIER,
                    "reason": "rate_limit",
                },
            },
        ],
    )
    ctrl = _latest_control_patch(tid)
    assert ctrl is not None
    assert ctrl["apiRetry"] is None
    assert ctrl["lastError"] is not None
    assert _FREE_TIER in str(ctrl["lastError"].get("message") or "")
    texts = [r for r in _rows(tid) if r.get("kind") == "assistantText"]
    assert len(texts) == 1
    assert texts[0]["text"] == _FREE_TIER
    assert texts[0]["state"] == "complete"


def test_text_message_clears_api_retry(mirror_session: str) -> None:
    tid = mirror_session + "-clear"
    if tid in getattr(HUB, "_sessions", {}):
        del HUB._sessions[tid]  # noqa: SLF001
    mirror = V4Mirror(HUB)
    mirror.note_user_input(tid, "hi")
    mirror.feed_events(
        tid,
        [
            {"type": "RUN_STARTED", "threadId": tid, "runId": "run-ok"},
            {
                "type": "ACTIVITY_SNAPSHOT",
                "content": {
                    "kind": "retrying",
                    "detail": _FREE_TIER,
                    "attempt": 1,
                    "max_attempts": 3,
                    "wait_s": 1,
                    "reason": "rate_limit",
                },
            },
            {"type": "TEXT_MESSAGE_START", "messageId": "m1"},
            {"type": "TEXT_MESSAGE_CONTENT", "messageId": "m1", "delta": "ok"},
            {"type": "TEXT_MESSAGE_END", "messageId": "m1"},
        ],
    )
    ctrl = _latest_control_patch(tid)
    assert ctrl is not None
    assert ctrl.get("apiRetry") is None
