"""Cold hydrate must seed rows in one lock, not N× author_append_row.

Regression: multi-chat freeze — hydrate worker held ``_write_lock`` once per
history row while AG-UI stream authors waited on the Gateway event loop.
"""

from __future__ import annotations

import json
from unittest.mock import patch

from app.gateway.v4.conversation import V4ConversationHub
from app.gateway.v4.hydration import hydrate_session_from_transcript


def _msg(role: str, content: str, *, rid: str, run: str = "run-1") -> dict:
    return {
        "role": role,
        "content_json": json.dumps({"content": content}),
        "message_id": rid,
        "run_id": run,
        "created_at": "2026-11-09T15:00:00+08:00",
        "turn_started_at": "2026-11-09T15:00:00+08:00",
        "turn_duration_ms": 1000,
        "turn_state": "completed",
    }


def test_hydrate_uses_author_seed_rows_not_per_row_append() -> None:
    hub = V4ConversationHub()
    append_calls = {"n": 0}
    real_append = hub.author_append_row

    def counting_append(session_id: str, row: dict) -> None:
        append_calls["n"] += 1
        return real_append(session_id, row)

    hub.author_append_row = counting_append  # type: ignore[method-assign]

    messages = []
    for i in range(40):
        messages.append(_msg("user", f"q{i}", rid=f"u{i}", run=f"run-{i}"))
        messages.append(_msg("assistant", f"a{i}", rid=f"a{i}", run=f"run-{i}"))

    with (
        patch(
            "evoflow.persistence.session_repositories.find_session_key_by_thread_id",
            return_value="agent:main:test",
        ),
        patch(
            "evoflow.persistence.session_repositories.is_session_deleted",
            return_value=False,
        ),
        patch("app.gateway.v4.hydration._load_messages", return_value=messages),
    ):
        loaded = hydrate_session_from_transcript(hub, "thread-seed-1")

    assert loaded > 0
    assert append_calls["n"] == 0, "hydrate must not call author_append_row per row"
    sess = hub.get_session("thread-seed-1")
    assert sess is not None
    assert len(sess.rows) == loaded
    # No per-row deltas inflated into the retention log.
    assert len(sess.delta_log) == 0


def test_author_seed_rows_skips_when_session_already_has_rows() -> None:
    hub = V4ConversationHub()
    hub.author_append_row(
        "thread-seed-2",
        {
            "rowId": 1,
            "turnId": "t",
            "kind": "userInput",
            "text": "keep",
            "createdAt": 1,
            "createdAtSeq": 0,
        },
    )
    n = hub.author_seed_rows(
        "thread-seed-2",
        [
            {
                "rowId": 2,
                "turnId": "t2",
                "kind": "userInput",
                "text": "should-not-land",
                "createdAt": 2,
                "createdAtSeq": 0,
            }
        ],
    )
    assert n == 0
    sess = hub.get_session("thread-seed-2")
    assert sess is not None
    assert list(sess.rows.keys()) == [1]
