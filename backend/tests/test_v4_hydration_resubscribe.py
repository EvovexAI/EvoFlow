"""Empty-session hydration retry (collab subtask right-stage panel).

Regression observed live: the node panel opens while the step is still running,
subscribes an empty v4 session (rows=0, seq=0), and the worker's messages are
persisted seconds later. The old guard — hydrate only when the session had
neither rows nor deltas, and inside ``hydrate_session_from_transcript`` bail out
whenever ``sess.seq`` was non-zero — meant history could never be back-filled,
so the panel stayed blank forever ("已工作 1 秒" with no content, while the DB
held a 47s turn).

Timeline from the real incident:

    14:39:05  subscribe  -> hydrate -> 0 messages -> rows=0 snapshot
    14:39:18  messages persisted to evoflow_chat_messages
    14:39:28  turn completed (turn_duration_ms=47207)
    (no further hydrate attempts: panel blank permanently)
"""

from __future__ import annotations

import json
from unittest.mock import patch

from app.gateway.v4.conversation import V4ConversationHub
from app.gateway.v4.hydration import hydrate_session_from_transcript


def _msg(role: str, content: str, *, rid: str, ts: str) -> dict:
    return {
        "role": role,
        "content_json": json.dumps({"content": content}),
        "message_id": rid,
        "run_id": "run-1",
        "created_at": ts,
        "turn_started_at": "2026-10-25T14:38:40.822488+08:00",
        "turn_duration_ms": 47207,
        "turn_state": "completed",
    }


THREAD = "lead-0000__sub__Subtask_1"
MESSAGES = [
    _msg("assistant", "提炼 3 条要点", rid="m1", ts="2026-10-25T14:39:18.239997+08:00"),
    _msg("tool", "已上报", rid="m2", ts="2026-10-25T14:39:18.249524+08:00"),
]


def _hydrate_with(rows_from_db):
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
        patch(
            "app.gateway.v4.hydration._load_messages",
            return_value=list(rows_from_db),
        ),
    ):
        loaded = hydrate_session_from_transcript(hub, THREAD)
    return hub, loaded


def test_empty_session_hydrates_once_transcript_lands() -> None:
    """A session created by a bare subscribe (no rows) must still hydrate later.

    Exact incident shape: the subscribe incremented ``seq`` (the hub counts the
    snapshot/boot ops) while ``rows`` stayed empty. The old guard keyed off
    ``sess.seq`` and therefore refused to hydrate forever.
    """
    hub = V4ConversationHub()
    # Simulate the bare subscribe: session exists, seq advanced, but no content.
    sess = hub._get_or_create_session(THREAD)
    sess.seq = 3
    assert sess.rows == {}
    assert sess.seq > 0

    with (
        patch(
            "evoflow.persistence.session_repositories.find_session_key_by_thread_id",
            return_value="agent:main:test",
        ),
        patch(
            "evoflow.persistence.session_repositories.is_session_deleted",
            return_value=False,
        ),
        patch(
            "app.gateway.v4.hydration._load_messages",
            return_value=tuple(MESSAGES),
        ),
    ):
        loaded = hydrate_session_from_transcript(hub, THREAD)

    assert loaded > 0, "transcript landed after subscribe → history must be back-filled"
    assert hub.get_session(THREAD).rows, "panel would stay blank without hydrated rows"


def test_hydrate_is_noop_when_session_already_has_rows() -> None:
    """Never double-append history on repeated subscribes."""
    hub, first = _hydrate_with(MESSAGES)
    assert first > 0
    _hub2, second = _hydrate_with(MESSAGES)
    assert second > 0  # fresh hub, independent
    # Same hub, second call must be a no-op.
    with (
        patch(
            "evoflow.persistence.session_repositories.find_session_key_by_thread_id",
            return_value="agent:main:test",
        ),
        patch(
            "evoflow.persistence.session_repositories.is_session_deleted",
            return_value=False,
        ),
        patch(
            "app.gateway.v4.hydration._load_messages",
            return_value=tuple(MESSAGES),
        ),
    ):
        again = hydrate_session_from_transcript(hub, THREAD)
    assert again == 0


def test_hydrate_returns_zero_when_transcript_still_empty() -> None:
    """Nothing to show yet → 0, and it must stay retryable (no rows written)."""
    hub, loaded = _hydrate_with([])
    assert loaded == 0
    assert hub.get_session(THREAD).rows == {}


def test_hydrated_turn_header_carries_real_duration() -> None:
    """The '已工作 1 秒' symptom: header must carry the persisted 47s span."""
    hub, loaded = _hydrate_with(MESSAGES)
    assert loaded > 0
    rows = hub.get_session(THREAD).rows
    headers = [r for r in rows.values() if r.get("kind") == "turnHeader"]
    assert headers, "hydration must author a turnHeader for the turn"
    header = headers[0]
    assert header["endedAt"] > header["startedAt"]
    # 47207ms turn span, not the 1s placeholder an empty shell renders.
    assert header["endedAt"] - header["startedAt"] >= 47000
