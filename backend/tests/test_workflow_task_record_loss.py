"""Regression: workflow task records must not vanish after a successful run.

Root cause chain (prod, 2026-11-06):

1. The background monitor flips a failed/timed-out subtask to ``pending`` and
   re-dispatches it. A task-queue tick landing inside that window sees
   "all subtasks terminal, but not all success" and condemns the whole main
   task (``_finalize_executing_task``).
2. The next tick's ``_requeue`` then wiped ``subtasks`` / ``plan_goal`` /
   ``plan_steps`` and reset ``progress`` / ``execution_authorized`` — so the
   finished steps and their artifacts were erased from the DB.
3. The tick after that routed the workflow task back into the *Lead planning*
   path, parking it at ``planning`` forever.

Both layers are covered here:
- ``_subtasks_awaiting_retry`` must defer the verdict while a retry is in
  flight (unit level).
- ``_protect_missing_subtask_rows`` must never let a stale bundle rewrite
  delete subtask rows that the DB already holds (persistence level).
"""

from __future__ import annotations

import sqlite3
from typing import Any

from app.gateway.unattended_task_pipeline import _subtasks_awaiting_retry
from evoflow.persistence.task_repositories import _protect_missing_subtask_rows


# --------------------------------------------------------------------------
# Layer 1: the pipeline must not condemn a task whose subtask is retrying.
# --------------------------------------------------------------------------


def _sub(status: str, **extra: Any) -> dict[str, Any]:
    return {"id": "s1", "status": status, **extra}


def test_failed_subtask_within_retry_budget_defers_verdict():
    task = {
        "subtasks": [
            _sub("completed"),
            _sub("failed", auto_retry_count=0),
        ]
    }
    assert _subtasks_awaiting_retry(task) is True


def test_failed_subtask_exhausting_retry_budget_does_not_defer():
    task = {
        "subtasks": [
            _sub("completed"),
            _sub("failed", auto_retry_count=99),
        ]
    }
    assert _subtasks_awaiting_retry(task) is False


def test_all_completed_never_defers():
    task = {"subtasks": [_sub("completed"), _sub("completed")]}
    assert _subtasks_awaiting_retry(task) is False


def test_pending_subtask_does_not_defer():
    """A non-terminal subtask is handled by the active-subtask guard."""
    task = {"subtasks": [_sub("pending")]}
    assert _subtasks_awaiting_retry(task) is False


def test_missing_auto_retry_count_counts_as_first_attempt():
    task = {"subtasks": [_sub("failed")]}
    assert _subtasks_awaiting_retry(task) is True


# --------------------------------------------------------------------------
# Layer 2: a stale bundle rewrite must not delete finished subtask rows.
# --------------------------------------------------------------------------


def _conn() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute(
        """
        CREATE TABLE evoflow_collab_tasks (
            main_task_id TEXT,
            task_id TEXT,
            status TEXT
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE evoflow_collab_subtasks (
            main_task_id TEXT,
            subtask_id TEXT,
            status TEXT,
            updated_at TEXT,
            extra_json TEXT,
            sort_order INTEGER
        )
        """
    )
    return conn


def test_missing_subtask_rows_are_restored_when_db_root_is_terminal():
    conn = _conn()
    conn.execute("INSERT INTO evoflow_collab_tasks VALUES ('m1', 'm1', 'completed')")
    conn.execute(
        "INSERT INTO evoflow_collab_subtasks VALUES ('m1', 's1', 'completed', '2026-11-06T19:35:05Z', '{}', 0)"
    )

    parts: dict[str, Any] = {"subtasks": []}
    _protect_missing_subtask_rows(conn, "m1", parts)

    assert len(parts["subtasks"]) == 1
    assert parts["subtasks"][0]["subtask_id"] == "s1"
    assert parts["subtasks"][0]["status"] == "completed"


def test_missing_subtask_rows_survive_non_terminal_db_root():
    """Plan edits may legitimately drop a not-yet-started step."""
    conn = _conn()
    conn.execute("INSERT INTO evoflow_collab_tasks VALUES ('m1', 'm1', 'executing')")
    conn.execute(
        "INSERT INTO evoflow_collab_subtasks VALUES ('m1', 's1', 'planned', '2026-11-06T19:35:05Z', '{}', 0)"
    )

    parts: dict[str, Any] = {"subtasks": []}
    _protect_missing_subtask_rows(conn, "m1", parts)

    assert parts["subtasks"] == []


def test_incoming_subtask_rows_are_not_duplicated():
    conn = _conn()
    conn.execute("INSERT INTO evoflow_collab_tasks VALUES ('m1', 'm1', 'completed')")
    conn.execute(
        "INSERT INTO evoflow_collab_subtasks VALUES ('m1', 's1', 'completed', '2026-11-06T19:35:05Z', '{}', 0)"
    )

    parts: dict[str, Any] = {"subtasks": [{"subtask_id": "s1", "status": "completed"}]}
    _protect_missing_subtask_rows(conn, "m1", parts)

    assert len(parts["subtasks"]) == 1
