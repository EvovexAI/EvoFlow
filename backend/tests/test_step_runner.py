"""Shared Step Runner: claim uses SubtaskStateMachine; terminal rows stay claimed-out."""

from __future__ import annotations

from unittest.mock import MagicMock

from evoflow.collab.step_runner import claim_subtasks_for_delegation, revert_claimed_subtasks_to_pending


def test_claim_skips_terminal_and_claims_pending(monkeypatch):
    import evoflow.collab.storage as st

    subs = [
        {"id": "a", "status": "completed", "progress": 100},
        {"id": "b", "status": "pending", "progress": 0},
    ]
    task = {"id": "mt1", "subtasks": subs}
    project = {"id": "p1", "tasks": [task]}
    store = MagicMock()
    store.save_project.return_value = True

    monkeypatch.setattr(st, "find_main_task", lambda *_a, **_k: (project, task))
    monkeypatch.setattr(
        "evoflow.collab.storage.main_task_mutation_lock",
        lambda _mid: MagicMock(__enter__=lambda s: s, __exit__=lambda *a: False),
    )
    monkeypatch.setattr(
        "evoflow.subagents.runtime_guard.is_subtask_background_executor_active",
        lambda _st: False,
    )

    claimed = claim_subtasks_for_delegation(store, "mt1", ["a", "b"])
    assert claimed == ["b"]
    assert subs[0]["status"] == "completed"
    assert subs[1]["status"] == "executing"
    store.save_project.assert_called_once()


def test_revert_executing_to_pending(monkeypatch):
    import evoflow.collab.storage as st

    subs = [{"id": "b", "status": "executing", "progress": 5}]
    task = {"id": "mt1", "subtasks": subs}
    project = {"id": "p1", "tasks": [task]}
    store = MagicMock()
    store.save_project.return_value = True
    monkeypatch.setattr(st, "find_main_task", lambda *_a, **_k: (project, task))
    monkeypatch.setattr(
        "evoflow.collab.storage.main_task_mutation_lock",
        lambda _mid: MagicMock(__enter__=lambda s: s, __exit__=lambda *a: False),
    )

    revert_claimed_subtasks_to_pending(store, "mt1", ["b"], reason="bridge down")
    assert subs[0]["status"] == "pending"
    assert "bridge down" in str(subs[0].get("error") or "")
