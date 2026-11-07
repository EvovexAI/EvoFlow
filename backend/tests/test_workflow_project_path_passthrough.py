"""Regression: workflow ``project_path`` must survive create → plan → subtask rows.

Three defects found by driving a real tool-using workflow run:

1. ``workflow.create`` accepted a top-level ``project_path`` (it is advertised in
   ``workflow.schema``) but ``create_app`` had no such kwarg, so the handler
   dropped it silently and the app row persisted ``''``.
2. ``run_app_workflow`` wrote the working dir onto ``task_data``/``project_data``,
   but ``evoflow_collab_tasks`` has no ``project_path`` column, so the value was
   discarded on the DB round-trip.
3. ``sync_subtasks_from_plan_steps`` therefore read the working dir back from the
   row, got ``None``, and every step row persisted ``project_path = NULL`` —
   each worker then picked its own base directory.
"""

from __future__ import annotations

import inspect
import uuid

import pytest


@pytest.fixture()
def workflow_db(tmp_path, monkeypatch):
    db_path = tmp_path / f"wf_{uuid.uuid4().hex[:8]}.db"
    monkeypatch.setenv("EVOFLOW_DB_PATH", str(db_path))
    from evoflow.persistence.db import get_db, reset_db_for_tests
    from evoflow.persistence.schema import ensure_app_schema

    reset_db_for_tests()
    conn = get_db()
    ensure_app_schema(conn)
    yield conn
    reset_db_for_tests()
    monkeypatch.delenv("EVOFLOW_DB_PATH", raising=False)


def test_create_app_persists_project_path(workflow_db, tmp_path):
    """Defect 1: the top-level project_path must reach the saved app row."""
    from evoflow.admin import apps as apps_admin

    workspace = str(tmp_path / "workspace")
    data = apps_admin.create_app(
        name="路径透传",
        steps=[{"ref": "s1", "name": "步骤一", "goal": "做事", "assigned_agent": "agent"}],
        project_path=workspace,
    )
    app_id = data["appId"]
    assert data["app"]["project_path"] == workspace

    reloaded = apps_admin.get_app(app_id)
    assert reloaded["app"]["project_path"] == workspace


def test_create_app_blank_project_path_stays_empty(workflow_db):
    """Blank stays blank so the run falls back to the resolved default."""
    from evoflow.admin import apps as apps_admin

    data = apps_admin.create_app(
        name="无路径",
        steps=[{"ref": "s1", "name": "步骤一", "assigned_agent": "agent"}],
    )
    assert data["app"]["project_path"] == ""


def test_platform_workflow_create_passes_project_path(workflow_db, tmp_path):
    """Defect 1 (handler layer): the platform action must forward the arg."""
    from evoflow.admin import platform_handlers

    workspace = str(tmp_path / "handler-ws")
    out = platform_handlers.workflow_create(
        {
            "name": "handler 透传",
            "steps": [{"ref": "s1", "name": "步骤一", "assigned_agent": "agent"}],
            "project_path": workspace,
        }
    )
    assert out["app"]["project_path"] == workspace
    assert out["appId"]


def test_sync_subtasks_accepts_explicit_project_path(workflow_db, tmp_path):
    """Defect 2+3: an explicit run path must land on every step row."""
    import inspect

    from evoflow.collab import plan_subtasks_sync

    sig = inspect.signature(plan_subtasks_sync.sync_subtasks_from_plan_steps)
    assert "project_path" in sig.parameters, "sync must accept an explicit working dir"


def test_sync_subtasks_falls_back_to_row_when_arg_absent(workflow_db):
    """Absent argument keeps the old behaviour (row value still honoured)."""
    from evoflow.collab import plan_subtasks_sync

    src = inspect.getsource(plan_subtasks_sync.sync_subtasks_from_plan_steps)
    assert 'task.get("project_path")' in src, "row fallback must be preserved"
