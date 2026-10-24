"""Subtask status machine: terminal must not roll back to active."""

from __future__ import annotations

from unittest.mock import MagicMock

from evoflow.collab.subtask_state_machine import (
    advance_subtask_row_status,
    can_advance_subtask_status,
    filter_status_from_updates,
)


def test_reject_completed_to_executing():
    ok, reason = can_advance_subtask_status("completed", "executing")
    assert ok is False
    assert "terminal_to_active" in reason


def test_allow_pending_to_executing():
    ok, reason = can_advance_subtask_status("pending", "executing")
    assert ok is True


def test_allow_explicit_downgrade():
    ok, _ = can_advance_subtask_status(
        "failed",
        "pending",
        allow_terminal_downgrade=True,
    )
    assert ok is True


def test_filter_strips_illegal_status_keeps_other_fields():
    out = filter_status_from_updates(
        "completed",
        {"status": "executing", "background_task_id": "bg1", "progress": 95},
    )
    assert "status" not in out
    assert out["background_task_id"] == "bg1"
    assert out["progress"] == 95


def test_advance_row_mutates_when_ok():
    row = {"status": "planned", "progress": 0}
    ok, _ = advance_subtask_row_status(row, "executing", progress=5)
    assert ok is True
    assert row["status"] == "executing"
    assert row["progress"] == 5


def test_advance_row_rejects_terminal_downgrade():
    row = {"status": "completed", "progress": 100}
    ok, reason = advance_subtask_row_status(row, "executing")
    assert ok is False
    assert row["status"] == "completed"
    assert "terminal_to_active" in reason


def test_patch_storage_uses_state_machine():
    import evoflow.collab.storage as st

    sub = {"id": "st1", "status": "completed", "progress": 100}
    task = {"id": "mt1", "subtasks": [sub]}
    project = {"id": "p1", "tasks": [task]}
    store = MagicMock()
    store.save_project.return_value = True
    original = st.find_main_task
    st.find_main_task = lambda *_a, **_k: (project, task)  # type: ignore[assignment]
    try:
        st.patch_collab_subtask_in_project_storage(
            store,
            "mt1",
            "st1",
            {"status": "executing", "background_task_id": "x"},
        )
    finally:
        st.find_main_task = original  # type: ignore[assignment]
    assert task["subtasks"][0]["status"] == "completed"
    assert task["subtasks"][0]["background_task_id"] == "x"
