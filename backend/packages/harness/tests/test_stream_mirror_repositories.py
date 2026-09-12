"""Tests for stream mirror repository."""

from __future__ import annotations

import gc
import tempfile
import time

import pytest

from evoflow.persistence import session_repositories as sess_repo
from evoflow.persistence.db import get_db, reset_db_for_tests
from evoflow.persistence.schema import ensure_app_schema
from evoflow.persistence.session_run_state import RUN_STATUS_DONE, RUN_STATUS_RUNNING
from evoflow.persistence.stream_mirror_repositories import (
    append_mirror_frame,
    clear_mirror,
    get_mirror_meta,
    read_mirror_frames,
    shrink_mirror_ttl,
    sweep_expired_idle_mirrors,
)
from evoflow.persistence.timestamps import ms_to_iso_z


@pytest.fixture
def sqlite_tmp(monkeypatch: pytest.MonkeyPatch):
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
        monkeypatch.setenv("EVOFLOW_HOME", tmp)
        monkeypatch.setenv("EVOFLOW_STREAM_MIRROR", "1")
        reset_db_for_tests()
        conn = get_db()
        ensure_app_schema(conn)
        yield conn
        reset_db_for_tests()
        gc.collect()
        time.sleep(0.05)


def test_stream_mirror_append_read_clear(sqlite_tmp) -> None:
    conn = sqlite_tmp

    sk = "sess-mirror-1"
    tid = "thread-m1"
    rid = "run-m1"
    clear_mirror(sk, conn=conn)

    seq1 = append_mirror_frame(
        sk,
        thread_id=tid,
        run_id=rid,
        raw_frame="event: evf\ndata: {\"type\":\"delta\",\"text\":\"hi\"}\n\n",
        conn=conn,
    )
    seq2 = append_mirror_frame(
        sk,
        thread_id=tid,
        run_id=rid,
        raw_frame="event: evf\ndata: {\"type\":\"run_end\"}\n\n",
        is_terminal=True,
        conn=conn,
    )
    assert seq1 == 1
    assert seq2 == 2

    frames = read_mirror_frames(sk, rid, after_seq=0, conn=conn)
    assert len(frames) == 2
    assert frames[0]["seq"] == 1
    assert "delta" in frames[0]["rawFrame"]
    assert frames[1]["isTerminal"]

    tail = read_mirror_frames(sk, rid, after_seq=1, conn=conn)
    assert len(tail) == 1
    assert tail[0]["seq"] == 2

    clear_mirror(sk, conn=conn)
    assert read_mirror_frames(sk, rid, conn=conn) == []


def test_stream_mirror_new_run_clears_old_seq(sqlite_tmp) -> None:
    conn = sqlite_tmp

    sk = "sess-mirror-2"
    append_mirror_frame(sk, thread_id="t1", run_id="run-a", raw_frame="event: ping\ndata: {}\n\n", conn=conn)
    append_mirror_frame(sk, thread_id="t1", run_id="run-b", raw_frame="event: ping\ndata: {}\n\n", conn=conn)
    frames_a = read_mirror_frames(sk, "run-a", conn=conn)
    frames_b = read_mirror_frames(sk, "run-b", conn=conn)
    assert len(frames_a) == 0
    assert len(frames_b) == 1
    assert frames_b[0]["seq"] == 1


def test_stream_mirror_limit_exceeded(sqlite_tmp, monkeypatch: pytest.MonkeyPatch) -> None:
    conn = sqlite_tmp
    import evoflow.persistence.stream_mirror_repositories as mirror_repo

    monkeypatch.setattr(mirror_repo, "STREAM_MIRROR_MAX_FRAMES", 2)
    monkeypatch.setattr(mirror_repo, "STREAM_MIRROR_MAX_BYTES", 999999)

    sk = "sess-mirror-limit"
    from evoflow.persistence.stream_mirror_repositories import get_mirror_meta

    append_mirror_frame(sk, thread_id="t1", run_id="run-l", raw_frame="event: a\ndata: 1\n\n", conn=conn)
    append_mirror_frame(sk, thread_id="t1", run_id="run-l", raw_frame="event: b\ndata: 2\n\n", conn=conn)
    seq3 = append_mirror_frame(sk, thread_id="t1", run_id="run-l", raw_frame="event: c\ndata: 3\n\n", conn=conn)
    assert seq3 is None
    meta = get_mirror_meta(sk, conn=conn)
    assert meta is not None
    unavailable = meta.get("unavailable") or {}
    assert unavailable.get("reason") == "mirrorLimitExceeded"


def test_stream_mirror_shrink_ttl(sqlite_tmp) -> None:
    conn = sqlite_tmp

    sk = "sess-mirror-3"
    append_mirror_frame(sk, thread_id="t1", run_id="run-x", raw_frame="event: ping\ndata: {}\n\n", conn=conn)
    shrink_mirror_ttl(sk, conn=conn)
    from evoflow.persistence.stream_mirror_repositories import get_mirror_meta

    meta = get_mirror_meta(sk, conn=conn)
    assert meta is not None
    assert meta.get("expiresAt")
    assert meta.get("expiresAtMs")


def test_sweep_expired_idle_mirrors(sqlite_tmp) -> None:
    conn = sqlite_tmp
    now_ms = int(time.time() * 1000)
    expired_ms = now_ms - 60_000

    sk_idle = "sess-sweep-idle"
    sk_running = "sess-sweep-running"
    sess_repo.upsert_session_row(sk_idle, thread_id="t-idle", title="idle")
    sess_repo.upsert_session_row(sk_running, thread_id="t-run", title="run")
    conn.execute(
        "UPDATE evoflow_chat_sessions SET run_status = ? WHERE session_key = ?",
        (RUN_STATUS_DONE, sk_idle),
    )
    conn.execute(
        "UPDATE evoflow_chat_sessions SET run_status = ?, current_run_id = ? WHERE session_key = ?",
        (RUN_STATUS_RUNNING, "run-live", sk_running),
    )

    append_mirror_frame(sk_idle, thread_id="t-idle", run_id="run-old", raw_frame="event: a\ndata: 1\n\n", conn=conn)
    append_mirror_frame(sk_running, thread_id="t-run", run_id="run-live", raw_frame="event: b\ndata: 2\n\n", conn=conn)
    expired_at = ms_to_iso_z(expired_ms)
    conn.execute(
        "UPDATE evoflow_chat_stream_mirror_meta SET expires_at = ? WHERE session_key = ?",
        (expired_at, sk_idle),
    )
    conn.execute(
        "UPDATE evoflow_chat_stream_mirror_meta SET expires_at = ? WHERE session_key = ?",
        (expired_at, sk_running),
    )

    stats = sweep_expired_idle_mirrors(now_ms=now_ms, conn=conn)
    assert stats["cleared"] == 1
    assert stats["scanned"] == 1
    assert get_mirror_meta(sk_idle, conn=conn) is None
    assert read_mirror_frames(sk_idle, "run-old", conn=conn) == []
    assert get_mirror_meta(sk_running, conn=conn) is not None
    assert len(read_mirror_frames(sk_running, "run-live", conn=conn)) == 1
