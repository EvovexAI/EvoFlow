"""Session thread binding must never persist collab executor composite ids."""

from __future__ import annotations

import pytest

from evoflow.collab.thread_ids import collab_subtask_executor_thread_id
from evoflow.persistence import session_repositories as sess_repo


@pytest.fixture
def session_db(tmp_path, monkeypatch):
    monkeypatch.setenv("EVOFLOW_DATA_DIR", str(tmp_path))
    from evoflow.persistence.db import reset_db_for_tests

    reset_db_for_tests()
    return tmp_path


def test_repair_session_thread_binding_normalizes_executor_to_lead(session_db) -> None:
    lead = "c5525aa9-d737-46f8-973c-fa82d8a9641d"
    executor = collab_subtask_executor_thread_id(lead, "Subtask_20260531080703_623573")
    sk = "agent:main:test-repair"
    now = 1_700_000_000_000
    sess_repo.upsert_session_row(sk, thread_id=lead, created_at_ms=now, updated_at_ms=now)

    ok = sess_repo.repair_session_thread_binding(sk, executor)
    assert ok is True
    row = sess_repo.load_session_map().get(sk) or {}
    assert row.get("threadId") == lead
