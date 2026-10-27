"""Optimistic-concurrency for whole-bundle rewrites (workflow-audit-roadmap P0-3).

save_task_bundle with ``loaded_updated_at`` must REJECT (raise) when the DB
bundle moved on since the caller's load, instead of logging and overwriting —
the lost-update that kept the workflow reconciler busy. Callers that omit
``loaded_updated_at`` keep the previous behavior (no gate).
"""

from __future__ import annotations

import sqlite3
from unittest.mock import patch

import pytest


@pytest.fixture()
def bundle_db():
    conn = sqlite3.connect(":memory:")
    conn.execute(
        "CREATE TABLE evoflow_collab_tasks (main_task_id TEXT, task_id TEXT, updated_at TEXT)"
    )
    conn.execute("INSERT INTO evoflow_collab_tasks VALUES ('mt1', 'mt1', '2026-01-02T00:00:00Z')")
    yield conn
    conn.close()


def _run_save(db_conn, main_task_id: str, document: dict, loaded_updated_at: str | None):
    import evoflow.persistence.db as db_mod
    import evoflow.persistence.task_repositories as repo

    with (
        patch.object(repo, "get_db", return_value=db_conn),
        patch.object(db_mod, "run_db_with_retry", side_effect=lambda fn: fn()),
    ):
        repo.save_task_bundle(main_task_id, document, loaded_updated_at=loaded_updated_at)


class _SentinelReached(Exception):
    pass


def test_stale_loaded_updated_at_is_rejected(bundle_db):
    """db_ts != seen_ts → StaleBundleWriteError, and nothing is deleted/rewritten."""
    from evoflow.persistence.task_repositories import StaleBundleWriteError

    with pytest.raises(StaleBundleWriteError):
        _run_save(
            bundle_db,
            "mt1",
            {"id": "mt1", "tasks": []},
            loaded_updated_at="2026-01-01T00:00:00Z",
        )
    # The stale rewrite must not have touched the DB row.
    row = bundle_db.execute(
        "SELECT updated_at FROM evoflow_collab_tasks WHERE main_task_id = 'mt1'"
    ).fetchone()
    assert row == ("2026-01-02T00:00:00Z",)


def test_matching_loaded_updated_at_passes_the_gate(bundle_db):
    """Same timestamp → gate passes (we prove it by reaching bundle_to_rows)."""
    import evoflow.persistence.task_row_mappers as m
    import evoflow.persistence.task_repositories as repo

    def _boom(document):
        raise _SentinelReached

    with patch.object(m, "bundle_to_rows", side_effect=_boom), pytest.raises(_SentinelReached):
        _run_save(
            bundle_db,
            "mt1",
            {"id": "mt1", "tasks": []},
            loaded_updated_at="2026-01-02T00:00:00Z",
        )


def test_missing_loaded_updated_at_keeps_old_behavior(bundle_db):
    """No token passed (direct evoflow.collab callers) → no gate, old behavior."""
    import evoflow.persistence.task_row_mappers as m

    def _boom(document):
        raise _SentinelReached

    with patch.object(m, "bundle_to_rows", side_effect=_boom), pytest.raises(_SentinelReached):
        _run_save(bundle_db, "mt1", {"id": "mt1", "tasks": []}, loaded_updated_at=None)


def test_storage_save_project_survives_rejection_and_invalidates_cache():
    """storage.save_project returns False (not raise) on rejection and drops the cache."""
    from unittest.mock import MagicMock

    import evoflow.collab.storage as st
    from evoflow.persistence.task_repositories import StaleBundleWriteError

    store = st.get_project_storage()
    pid = "proj-stale-reject-test"
    try:
        store._project_cache[pid] = {"id": pid, "tasks": []}
        store._project_cache_ts[pid] = 1.0

        repo = MagicMock()
        repo.save_task_bundle.side_effect = StaleBundleWriteError("bundle moved on")
        repo.load_task_bundle.return_value = None
        with patch("evoflow.persistence.repositories.save_task_bundle", repo.save_task_bundle):
            ok = store.save_project({"id": pid, "tasks": []})

        assert ok is False
        assert pid not in store._project_cache, "stale cache entry must be invalidated"
    finally:
        store._project_cache.pop(pid, None)
        store._project_cache_ts.pop(pid, None)


def test_save_project_uses_load_stamp_even_if_updated_at_was_bumped():
    """patch_collab bumps project.updated_at before save; must not self-reject.

    Prod symptom (2026-10-27 emp-99974783): every tasks.progress/state returned
    ``Failed to save task`` while the employee had already finished the work.
    """
    from unittest.mock import MagicMock

    import evoflow.collab.storage as st

    store = st.get_project_storage()
    pid = "proj-progress-stamp-test"
    db_ts = "2026-10-27T10:32:16.229565+08:00"
    try:
        project = {
            "id": pid,
            "updated_at": "2026-10-27T10:33:21.000000+08:00",  # already bumped by patch
            "_loaded_updated_at": db_ts,
            "tasks": [{"id": pid, "status": "pending", "progress": 0}],
        }
        captured: dict = {}

        def _capture(main_task_id, document, loaded_updated_at=None):
            captured["loaded_updated_at"] = loaded_updated_at
            captured["document_updated_at"] = document.get("updated_at")

        with patch("evoflow.persistence.repositories.save_task_bundle", side_effect=_capture):
            ok = store.save_project(project)

        assert ok is True
        assert captured["loaded_updated_at"] == db_ts
        assert captured["document_updated_at"] != db_ts
        assert project.get("_loaded_updated_at") == captured["document_updated_at"]
    finally:
        store._project_cache.pop(pid, None)
        store._project_cache_ts.pop(pid, None)
