"""Session run_status and token totals on evoflow_chat_sessions."""

from __future__ import annotations

import tempfile

import pytest

from evoflow.persistence import session_repositories as sess_repo
from evoflow.persistence.db import get_db, reset_db_for_tests
from evoflow.persistence.session_run_state import (
    RUN_STATUS_DONE,
    RUN_STATUS_RUNNING,
    add_session_token_usage,
    list_active_sessions_for_keys,
    list_all_active_sessions,
    mark_session_run_ended,
    mark_session_run_started,
)


@pytest.fixture
def sqlite_tmp(monkeypatch: pytest.MonkeyPatch):
    with tempfile.TemporaryDirectory() as tmp:
        monkeypatch.setenv("EVOFLOW_HOME", tmp)
        monkeypatch.setenv("EVOFLOW_STREAM_MIRROR", "1")
        reset_db_for_tests()
        get_db()
        yield
        reset_db_for_tests()


def test_schema_v19_run_and_token_columns(sqlite_tmp: None) -> None:
    del sqlite_tmp
    cols = {r[1] for r in get_db().execute("PRAGMA table_info(evoflow_chat_sessions)").fetchall()}
    assert int(get_db().execute("PRAGMA user_version").fetchone()[0]) >= 19
    for name in ("run_status", "current_run_id", "input_tokens", "output_tokens", "total_tokens"):
        assert name in cols


def test_run_status_and_tokens_roundtrip(sqlite_tmp: None) -> None:
    del sqlite_tmp
    sk = "agent:main:test-run-state"
    tid = "thread-run-state-1"
    sess_repo.upsert_session_row(sk, thread_id=tid, title="t", updated_at_ms=1_700_000_111_000)
    assert mark_session_run_started(session_key=sk, run_id="run-abc", status=RUN_STATUS_RUNNING)
    active = list_active_sessions_for_keys([sk])
    assert len(active) == 1
    assert active[0]["session_key"] == sk
    assert active[0]["run_id"] == "run-abc"
    # Lifecycle start must not rewrite sidebar activity time.
    assert sess_repo.get_session_row_for_ui(sk)["updatedAt"] == 1_700_000_111_000
    add_session_token_usage(sk, input_tokens=100, output_tokens=40)
    row = sess_repo.get_session_row_for_ui(sk)
    assert row is not None
    assert row["runStatus"] == RUN_STATUS_RUNNING
    assert row["inputTokens"] == 100
    assert row["outputTokens"] == 40
    assert row["totalTokens"] == 140
    activity_after_tokens = row["updatedAt"]
    assert activity_after_tokens >= 1_700_000_111_000
    assert mark_session_run_ended(session_key=sk)
    row2 = sess_repo.get_session_row_for_ui(sk)
    assert row2 is not None
    assert row2["runStatus"] == RUN_STATUS_DONE
    # Startup reconcile ends runs with a shared clock — must keep activity time.
    assert row2["updatedAt"] == activity_after_tokens
    assert list_active_sessions_for_keys([sk]) == []


def test_run_status_by_thread_id(sqlite_tmp: None) -> None:
    del sqlite_tmp
    sk = "agent:main:test-run-thread"
    tid = "thread-only-bind"
    sess_repo.upsert_session_row(sk, thread_id=tid)
    assert mark_session_run_started(thread_id=tid)
    assert list_active_sessions_for_keys([sk])
    assert mark_session_run_ended(thread_id=tid)
    row = sess_repo.get_session_row_for_ui(sk)
    assert row is not None
    assert row["runStatus"] == RUN_STATUS_DONE


def test_patch_session_current_run_id_keeps_mirror(sqlite_tmp: None) -> None:
    del sqlite_tmp
    from evoflow.persistence.session_run_state import patch_session_current_run_id
    from evoflow.persistence.stream_mirror_repositories import append_mirror_frame, get_mirror_meta

    sk = "agent:main:test-run-id-patch"
    tid = "thread-run-id-patch"
    client_rid = "d0450ab3-8533-42fc-a542-f65d6878136d"
    lg_rid = "019ef073-b7df-7263-9b80-e47afcaf1b38"
    sess_repo.upsert_session_row(sk, thread_id=tid)
    mark_session_run_started(session_key=sk, run_id=client_rid, thread_id=tid)
    append_mirror_frame(sk, thread_id=tid, run_id=client_rid, raw_frame="event: ag-ui\ndata: {}\n\n")
    assert patch_session_current_run_id(thread_id=tid, run_id=lg_rid) is True
    row = sess_repo.get_session_row_for_ui(sk)
    assert row is not None
    assert row["currentRunId"] == lg_rid
    meta = get_mirror_meta(sk)
    assert meta is not None
    assert int(meta.get("frameCount") or 0) == 1


def test_same_run_rebind_keeps_mirror(sqlite_tmp: None) -> None:
    del sqlite_tmp
    from evoflow.persistence.stream_mirror_repositories import append_mirror_frame, get_mirror_meta

    sk = "agent:main:test-mirror-rebind"
    tid = "thread-mirror-rebind"
    rid = "run-same"
    sess_repo.upsert_session_row(sk, thread_id=tid)
    mark_session_run_started(session_key=sk, run_id=rid, thread_id=tid)
    append_mirror_frame(sk, thread_id=tid, run_id=rid, raw_frame="event: evf\ndata: {}\n\n")
    meta = get_mirror_meta(sk)
    assert meta is not None
    assert int(meta.get("frameCount") or 0) == 1
    mark_session_run_started(session_key=sk, run_id=rid, thread_id=tid)
    meta2 = get_mirror_meta(sk)
    assert meta2 is not None
    assert int(meta2.get("frameCount") or 0) == 1


def test_same_run_rebind_preserves_turn_started_at(sqlite_tmp: None) -> None:
    del sqlite_tmp
    sk = "agent:main:test-turn-start-rebind"
    tid = "thread-turn-start-rebind"
    rid = "run-turn-same"
    sess_repo.upsert_session_row(sk, thread_id=tid)
    assert mark_session_run_started(session_key=sk, run_id=rid, thread_id=tid)
    row1 = sess_repo.get_session_row_for_ui(sk)
    assert row1 is not None
    started = row1.get("currentTurnStartedAt")
    assert started
    assert mark_session_run_started(session_key=sk, run_id=rid, thread_id=tid)
    row2 = sess_repo.get_session_row_for_ui(sk)
    assert row2 is not None
    assert row2.get("currentTurnStartedAt") == started
    assert row2.get("currentTurnEndedAt") is None


def test_ui_session_row_exposes_turn_timing_fields(sqlite_tmp: None) -> None:
    del sqlite_tmp
    sk = "agent:main:test-turn-ui-fields"
    sess_repo.upsert_session_row(sk, thread_id="tid-turn-ui", title="t")
    mark_session_run_started(session_key=sk, run_id="run-turn-ui")
    row = sess_repo.get_session_row_for_ui(sk)
    assert row is not None
    assert "currentTurnStartedAt" in row
    assert "currentTurnEndedAt" in row
    assert row["currentTurnStartedAt"]
    assert row["currentTurnEndedAt"] is None
    listed = sess_repo.list_sessions_for_ui(limit=10)
    match = next((r for r in listed if r.get("sessionKey") == sk), None)
    assert match is not None
    assert match.get("currentTurnStartedAt") == row["currentTurnStartedAt"]


def test_append_message_rolls_up_normalized_session_tokens(sqlite_tmp: None) -> None:
    del sqlite_tmp
    from evoflow.persistence.chat_session_service import append_message_and_touch_session

    sk = "agent:main:test-token-rollup"
    tid = "thread-token-rollup"
    sess_repo.upsert_session_row(sk, thread_id=tid, title="t")
    append_message_and_touch_session(
        sk,
        role="assistant",
        content="hi",
        thread_id=tid,
        raw={
            "type": "ai",
            "response_metadata": {
                "usage": {
                    "input_tokens": 200,
                    "output_tokens": 350,
                    "cache_read_input_tokens": 2000,
                }
            },
        },
    )
    row = sess_repo.get_session_row_for_ui(sk)
    assert row is not None
    assert row["inputTokens"] == 2200
    assert row["outputTokens"] == 350
    assert row["totalTokens"] == 2550
    assert row["cacheReadTokens"] == 2000
    assert row["cacheMissTokens"] == 200


def test_list_all_active_sessions(sqlite_tmp: None) -> None:
    del sqlite_tmp
    sk1 = "agent:main:all-active-1"
    sk2 = "agent:main:all-active-2"
    sk3 = "agent:main:all-idle"
    sess_repo.upsert_session_row(sk1, thread_id="t1")
    sess_repo.upsert_session_row(sk2, thread_id="t2")
    sess_repo.upsert_session_row(sk3, thread_id="t3")
    mark_session_run_started(session_key=sk1, run_id="run-1")
    mark_session_run_started(session_key=sk2, run_id="run-2")
    mark_session_run_ended(session_key=sk3)
    active = list_all_active_sessions()
    keys = {r["session_key"] for r in active}
    assert sk1 in keys
    assert sk2 in keys
    assert sk3 not in keys


def test_append_message_syncs_run_active(sqlite_tmp: None) -> None:
    del sqlite_tmp
    from evoflow.persistence.chat_session_service import append_message_and_touch_session

    sk = "agent:main:transcript-sync"
    tid = "thread-transcript-sync"
    sess_repo.upsert_session_row(sk, thread_id=tid, title="t")
    mark_session_run_ended(session_key=sk)

    append_message_and_touch_session(
        sk,
        role="assistant",
        content="tool call pending",
        run_id="run-sync-1",
        thread_id=tid,
    )
    row = sess_repo.get_session_row_for_ui(sk) or {}
    assert row.get("runStatus") == RUN_STATUS_RUNNING
    assert row.get("currentRunId") == "run-sync-1"
