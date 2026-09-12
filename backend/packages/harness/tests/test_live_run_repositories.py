"""Tests for live run snapshot repository."""

from __future__ import annotations

import tempfile
from pathlib import Path

import pytest

from evoflow.persistence import live_run_repositories as live_repo
from evoflow.persistence.db import get_db, reset_db_for_tests
from evoflow.persistence.schema import ensure_app_schema


@pytest.fixture
def sqlite_tmp(monkeypatch: pytest.MonkeyPatch):
    with tempfile.TemporaryDirectory() as tmp:
        monkeypatch.setenv("EVOFLOW_HOME", tmp)
        reset_db_for_tests()
        yield Path(tmp) / "evoflow.db"
        reset_db_for_tests()


def test_live_run_upsert_get_delete(sqlite_tmp) -> None:
    del sqlite_tmp
    reset_db_for_tests()
    conn = get_db()
    ensure_app_schema(conn)

    sk = "sess-live-1"
    live_repo.upsert_live_run_snapshot(
        sk,
        run_id="run-a",
        thread_id="thread-a",
        partial_text="partial hello",
        partial_tools=[{"name": "read_file"}],
        last_event_at_ms=1234,
    )
    row = live_repo.get_live_run_snapshot(sk)
    assert row is not None
    assert row["runId"] == "run-a"
    assert row["partialText"] == "partial hello"
    assert row["partialTools"][0]["name"] == "read_file"

    live_repo.upsert_live_run_snapshot(
        sk,
        run_id="run-a",
        partial_display_segments=[
            {"kind": "text", "text": "plan", "seq": 1},
            {"kind": "reasoning", "text": "think", "seq": 2},
        ],
        last_event_at_ms=2345,
    )
    row3 = live_repo.get_live_run_snapshot(sk)
    assert row3 is not None
    assert len(row3["partialDisplaySegments"]) == 2
    assert row3["partialDisplaySegments"][1]["kind"] == "reasoning"

    live_repo.upsert_live_run_snapshot(
        sk,
        run_id="run-a",
        partial_text="partial updated",
        last_event_at_ms=5678,
    )
    row2 = live_repo.get_live_run_snapshot(sk)
    assert row2["partialText"] == "partial updated"
    assert row2["lastEventAtMs"] == 5678
    assert "T" in row2["lastEventAt"]

    assert live_repo.delete_live_run_snapshot(sk) is True
    assert live_repo.get_live_run_snapshot(sk) is None
