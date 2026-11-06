"""Regression: a stale-bundle rejection must retry instead of failing the ``done`` tool.

Observed in production: a worker finished its step and called ``done``; the
optimistic save lost a race against a concurrent heartbeat/progress write, so
``save_project`` returned False, ``persist_subtask_runtime_snapshot`` returned
False, and ``done`` answered a bare ``{"ok": false, "error": "persist subtask
snapshot failed"}``. The worker then burned another whole model round
re-reporting the same outcome (12s of wall clock for nothing).

Fix: ``save_project_merge`` reloads the authoritative bundle (bypassing the
cache) and replays the mutation before giving up.
"""

from __future__ import annotations

import os
import uuid

import pytest


@pytest.fixture()
def store(tmp_path, monkeypatch):
    db_path = tmp_path / f"merge_{uuid.uuid4().hex[:8]}.db"
    monkeypatch.setenv("EVOFLOW_DB_PATH", str(db_path))
    from evoflow.persistence.db import get_db, reset_db_for_tests
    from evoflow.persistence.schema import ensure_app_schema

    reset_db_for_tests()
    conn = get_db()
    ensure_app_schema(conn)
    from evoflow.collab.storage import get_project_storage

    reset_db_for_tests()
    conn = get_db()
    ensure_app_schema(conn)
    yield conn
    reset_db_for_tests()
    monkeypatch.delenv("EVOFLOW_DB_PATH", raising=False)


def test_save_project_merge_retries_then_succeeds(store):
    """First save is rejected as stale; the reload+replay wins."""
    from evoflow.collab.storage import get_project_storage
    from evoflow.persistence.task_repositories import StaleBundleWriteError

    storage = get_project_storage()
    pid = f"T_{uuid.uuid4().hex[:8]}"
    project = {
        "id": pid,
        "tasks": [{"id": pid, "name": "步", "status": "planned", "subtasks": []}],
        "updated_at": "2026-01-01T00:00:00Z",
    }
    # Seed the bundle so reload() has something authoritative to read.
    assert storage.save_project(dict(project))

    calls = {"n": 0}
    real_save = storage.save_project

    def flaky_save(data):
        calls["n"] += 1
        if calls["n"] == 1:
            raise StaleBundleWriteError("simulated concurrent write")
        return real_save(data)

    storage.save_project = flaky_save  # type: ignore[assignment]
    try:
        def mutate(p):
            p["tasks"][0]["status"] = "completed"

        assert storage.save_project_merge(dict(project), mutate) is True
        assert calls["n"] >= 2, "must retry after the stale rejection"

        reloaded = storage.load_project(project["id"], bypass_cache=True)
        assert reloaded["tasks"][0]["status"] == "completed"
    finally:
        storage.save_project = real_save  # type: ignore[assignment]


def test_save_project_merge_gives_up_after_budget(store):
    """Persistent contention still fails (no infinite retry)."""
    from evoflow.collab import storage as storage_mod
    from evoflow.persistence.task_repositories import StaleBundleWriteError

    storage = storage_mod.get_project_storage()
    pid = f"T_{uuid.uuid4().hex[:8]}"
    project = {"id": pid, "tasks": [{"id": pid, "subtasks": []}], "updated_at": "2026-01-01T00:00:00Z"}
    assert storage.save_project(dict(project))

    calls = {"n": 0}

    def always_stale(data):
        calls["n"] += 1
        raise StaleBundleWriteError("always")

    real_save = storage.save_project
    storage.save_project = always_stale  # type: ignore[assignment]
    try:
        assert storage.save_project_merge(dict(project), lambda p: None) is False
        assert calls["n"] == storage_mod._SAVE_MERGE_ATTEMPTS
    finally:
        storage.save_project = real_save  # type: ignore[assignment]


def test_persist_subtask_snapshot_survives_one_stale_write(store):
    """End-to-end: the helper the ``done`` tool relies on must not fail spuriously."""
    from evoflow.collab import storage as storage_mod
    from evoflow.collab.storage import get_project_storage, get_task_detail_storage
    from evoflow.persistence.task_repositories import StaleBundleWriteError

    storage = get_project_storage()
    mid = f"T_{uuid.uuid4().hex[:8]}"
    sid = "sub-1"
    # Real shape: the main task row's id == main_task_id, and step rows live
    # directly on its ``subtasks`` list keyed by "id".
    project = {
        "id": mid,
        "tasks": [
            {
                "id": mid,
                "name": "主任务",
                "status": "executing",
                "subtasks": [
                    {"id": sid, "name": "步骤", "status": "executing", "progress": 10}
                ],
            }
        ],
        "updated_at": "2026-01-01T00:00:00Z",
    }
    assert storage.save_project(dict(project))

    real_save = storage.save_project
    state = {"n": 0}

    def flaky(data):
        state["n"] += 1
        if state["n"] == 1:
            raise StaleBundleWriteError("simulated")
        return real_save(data)

    storage.save_project = flaky  # type: ignore[assignment]
    try:
        ok = storage_mod.persist_subtask_runtime_snapshot(
            storage,
            get_task_detail_storage(),
            mid,
            sid,
            status="completed",
            progress=100,
            task_report="done",
        )
    finally:
        storage.save_project = real_save  # type: ignore[assignment]
    assert ok is True, "stale rejection must be retried, not surfaced as failure"

    reloaded = storage.load_project(mid, bypass_cache=True)
    subtasks = reloaded["tasks"][0]["subtasks"]
    assert subtasks[0]["status"] == "completed"
    assert subtasks[0]["progress"] == 100
