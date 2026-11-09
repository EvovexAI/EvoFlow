"""Regression: a heartbeat lease must make long-running steps read as ``live``.

The health probe joins session rows to decide ``live`` vs ``interrupted``. A
workflow main task has ``thread_id = None``, so the only durable proof that a
worker is still alive is the heartbeat lease. That lease used to live only in
the in-process bundle cache: the hot-patch whitelist did not include
``lease_until_ts``, so a heartbeat wrote ``extra_json``-less updates and a
reader saw nothing — every step older than the 20s startup grace read as
「已中断」while it was actually running.
"""

from __future__ import annotations

import datetime
import json
import os
import time
import uuid

import pytest


@pytest.fixture()
def health_db(tmp_path, monkeypatch):
    db_path = tmp_path / f"health_{uuid.uuid4().hex[:8]}.db"
    monkeypatch.setenv("EVOFLOW_DB_PATH", str(db_path))
    from evoflow.persistence.db import get_db, reset_db_for_tests
    from evoflow.persistence.schema import ensure_app_schema

    reset_db_for_tests()
    conn = get_db()
    ensure_app_schema(conn)
    yield conn
    reset_db_for_tests()
    monkeypatch.delenv("EVOFLOW_DB_PATH", raising=False)


def _iso(ts: float) -> str:
    return datetime.datetime.fromtimestamp(ts, datetime.timezone.utc).isoformat()


def test_hot_patch_persists_lease_into_extra_json(health_db):
    from evoflow.persistence import task_repositories as tr

    health_db.execute(
        """INSERT INTO evoflow_collab_subtasks
           (main_task_id, parent_task_id, subtask_id, name, description, status,
            created_at, updated_at, extra_json)
           VALUES ('M1','M1','S1','步骤一','d','executing','t0','t0','{}')"""
    )
    health_db.commit()

    lease = time.time() + 120
    assert tr.patch_subtask_hot_fields(
        "M1", "S1", {"lease_until_ts": lease, "last_heartbeat_ts": time.time()}
    )

    row = health_db.execute(
        "SELECT extra_json FROM evoflow_collab_subtasks WHERE subtask_id='S1'"
    ).fetchone()
    data = json.loads(row[0])
    assert "lease_until_ts" in data
    assert abs(float(data["lease_until_ts"]) - lease) < 1.0


def test_lease_survives_row_mapper(health_db):
    """The reader side merges extra_json back onto the row dict."""
    from evoflow.persistence import task_repositories as tr
    from evoflow.persistence.task_row_mappers import _merge_extra

    health_db.execute(
        """INSERT INTO evoflow_collab_subtasks
           (main_task_id, parent_task_id, subtask_id, name, description, status,
            created_at, updated_at, extra_json)
           VALUES ('M2','M2','S2','步骤二','d','executing','t0','t0','{}')"""
    )
    health_db.commit()
    lease = time.time() + 300
    tr.patch_subtask_hot_fields("M2", "S2", {"lease_until_ts": lease})

    row = health_db.execute(
        "SELECT extra_json FROM evoflow_collab_subtasks WHERE subtask_id='S2'"
    ).fetchone()
    out: dict = {}
    _merge_extra(out, row[0])
    assert out.get("lease_until_ts") is not None


def test_hot_patch_refuses_terminal_to_active_race(health_db):
    """Stale heartbeat that still thinks the row is executing must not undo done().

    Regression: COALESCE(?, status) let a late progress/lease tick overwrite
    ``completed`` back to ``executing`` after the worker already wrote final.md
    and reported outcome — UI showed the leaf stuck executing while the run
    had already closed.
    """
    from evoflow.persistence import task_repositories as tr

    health_db.execute(
        """INSERT INTO evoflow_collab_subtasks
           (main_task_id, parent_task_id, subtask_id, name, description, status,
            created_at, updated_at, progress, extra_json)
           VALUES ('M3','M3','S3','节点3','d','completed','t0','t0',100,'{}')"""
    )
    health_db.commit()

    assert tr.patch_subtask_hot_fields(
        "M3",
        "S3",
        {
            "status": "executing",
            "progress": 95,
            "lease_until_ts": time.time() + 60,
            "last_heartbeat_ts": time.time(),
        },
    )

    row = health_db.execute(
        "SELECT status, progress, extra_json FROM evoflow_collab_subtasks WHERE subtask_id='S3'"
    ).fetchone()
    assert row[0] == "completed"
    assert int(row[1]) == 95  # progress/lease may still refresh
    data = json.loads(row[2])
    assert "lease_until_ts" in data


def test_long_running_step_with_lease_is_live():
    """600s-old step + valid lease must not be reported as interrupted."""
    from evoflow.collab.task_runtime_health import resolve_task_runtime_health

    now = time.time()
    old = _iso(now - 600)
    task = {
        "id": "T",
        "status": "executing",
        "thread_id": None,
        "started_at": old,
        "subtasks": [
            {"subtask_id": "S1", "status": "executing", "started_at": old, "lease_until_ts": now + 120}
        ],
    }
    empty = {"by_task_id": set(), "by_thread_id": set()}
    assert resolve_task_runtime_health(task, active_index=empty, now_ts=now) == "live"


def test_long_running_step_without_lease_still_alerts():
    """No lease and no session ⇒ genuine 「进程失联」 must still be reported."""
    from evoflow.collab.task_runtime_health import resolve_task_runtime_health

    now = time.time()
    old = _iso(now - 600)
    task = {
        "id": "T2",
        "status": "executing",
        "thread_id": None,
        "started_at": old,
        "subtasks": [{"subtask_id": "S2", "status": "executing", "started_at": old}],
    }
    empty = {"by_task_id": set(), "by_thread_id": set()}
    assert resolve_task_runtime_health(task, active_index=empty, now_ts=now) == "interrupted"


def test_expired_lease_is_interrupted():
    from evoflow.collab.task_runtime_health import resolve_task_runtime_health

    now = time.time()
    old = _iso(now - 600)
    task = {
        "id": "T3",
        "status": "executing",
        "thread_id": None,
        "started_at": old,
        "subtasks": [
            {"subtask_id": "S3", "status": "executing", "started_at": old, "lease_until_ts": now - 300}
        ],
    }
    empty = {"by_task_id": set(), "by_thread_id": set()}
    assert resolve_task_runtime_health(task, active_index=empty, now_ts=now) == "interrupted"
