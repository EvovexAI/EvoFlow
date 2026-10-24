"""Terminal subtask status must not be patched back to active (peer-wake / late start)."""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest


def test_patch_refuses_completed_to_executing():
    import evoflow.collab.storage as st

    sub = {
        "id": "st1",
        "status": "completed",
        "progress": 100,
        "background_task_id": "old-bg",
    }
    task = {"id": "mt1", "subtasks": [sub]}
    project = {"id": "p1", "tasks": [task]}
    store = MagicMock()
    store.save_project.return_value = True

    original = st.find_main_task
    st.find_main_task = lambda *_a, **_k: (project, task)  # type: ignore[assignment]
    try:
        ok = st.patch_collab_subtask_in_project_storage(
            store,
            "mt1",
            "st1",
            {
                "status": "executing",
                "progress": 95,
                "background_task_id": "PeerWake_new",
            },
        )
    finally:
        st.find_main_task = original  # type: ignore[assignment]

    assert ok is True
    row = task["subtasks"][0]
    assert row["status"] == "completed"
    assert row["background_task_id"] == "PeerWake_new"
    assert row["progress"] == 95  # non-status fields still apply
    store.save_project.assert_called_once()


def test_patch_allow_flag_permits_downgrade():
    from evoflow.collab import storage as st

    sub = {"id": "st1", "status": "completed", "progress": 100}
    task = {"id": "mt1", "subtasks": [sub]}
    project = {"id": "p1", "tasks": [task]}
    store = MagicMock()
    store.save_project.return_value = True

    original = st.find_main_task
    st.find_main_task = lambda *_a, **_k: (project, task)  # type: ignore[assignment]
    try:
        ok = st.patch_collab_subtask_in_project_storage(
            store,
            "mt1",
            "st1",
            {"status": "pending"},
            allow_terminal_status_downgrade=True,
        )
    finally:
        st.find_main_task = original  # type: ignore[assignment]

    assert ok is True
    assert task["subtasks"][0]["status"] == "pending"


def test_sync_run_from_task_maps_pending_to_running(monkeypatch: pytest.MonkeyPatch):
    from evoflow.collab import app_runner

    updates: list[tuple] = []

    def _upd(run_id, status, **fields):
        updates.append((run_id, status, fields))

    monkeypatch.setattr(app_runner.app_repositories, "update_run_status", _upd)

    run = {"id": "run1", "status": "executing", "progress": 98}
    effective = app_runner._sync_run_from_task(run, task_status="pending", progress=0)
    assert effective == "running"
    assert updates == [("run1", "running", {"progress": 0})]
    assert run["status"] == "running"
    assert run["progress"] == 0


def test_sync_linked_app_run_on_requeue_helper(monkeypatch: pytest.MonkeyPatch):
    from app.gateway import unattended_task_pipeline as pipe

    calls: list[tuple] = []

    class _Repo:
        @staticmethod
        def load_run_by_task_id(_tid):
            return None

        @staticmethod
        def update_run_status(run_id, status, **fields):
            calls.append((run_id, status, fields))

    monkeypatch.setattr(
        "evoflow.persistence.app_repositories.load_run_by_task_id",
        _Repo.load_run_by_task_id,
    )
    monkeypatch.setattr(
        "evoflow.persistence.app_repositories.update_run_status",
        _Repo.update_run_status,
    )

    pipe._sync_linked_app_run(
        {"id": "mt1", "source_run_id": "run_abc"},
        status="running",
        progress=0,
        error=None,
    )
    assert calls == [("run_abc", "running", {"progress": 0, "error": None})]


@pytest.mark.asyncio
async def test_peer_wake_skips_terminal_completed(monkeypatch: pytest.MonkeyPatch):
    from evoflow.collab.peer import wake as wake_mod

    st = {"id": "st1", "status": "completed", "outcome_reported_at": "2026-01-01T00:00:00Z"}
    monkeypatch.setattr("evoflow.collab.storage.get_project_storage", lambda: object())
    monkeypatch.setattr("evoflow.collab.storage.find_subtask_by_ids", lambda *_a, **_k: st)

    called = {"delegate": False}

    async def _boom(*_a, **_k):
        called["delegate"] = True
        return {"ok": True}

    monkeypatch.setattr(
        "evoflow.tools.builtins.supervisor.execution.delegate_collab_subtask_peer_wake",
        _boom,
    )

    out = await wake_mod.wake_collab_subtask_for_peer(
        main_task_id="mt1",
        to_subtask_id="st1",
        thread_key="st2::st1",
        trigger_message_id="m1",
        reason="peer_question",
    )
    assert out.get("skipped") is True
    assert out.get("reason") == "terminal_no_redispatch"
    assert called["delegate"] is False


def test_rollup_prompt_bans_peer_to_completed_upstream():
    from evoflow.collab.app_rollup import build_rollup_subtask_spec

    spec = build_rollup_subtask_spec({"steps": [{"ref": "a"}, {"ref": "b"}]}, goal="g")
    text = str(spec.get("instruction") or "")
    assert "禁止" in text
    assert "peer_send" in text
    assert "Upstream dependency" in text


def test_heal_run_invariant_empty_subs_resets_progress(monkeypatch: pytest.MonkeyPatch):
    from evoflow.collab import app_runner

    updates: list[tuple] = []

    def _upd(run_id, status, **fields):
        updates.append((run_id, status, fields))

    monkeypatch.setattr(app_runner.app_repositories, "update_run_status", _upd)

    run = {"id": "run1", "status": "executing", "progress": 98}
    out = app_runner._heal_run_invariant(
        run,
        task_status="pending",
        progress=0,
        subtasks=[],
    )
    assert out == "running"
    assert run["progress"] == 0
    assert updates and updates[0][1] == "running"


def test_push_app_run_from_main_task_write_path(monkeypatch: pytest.MonkeyPatch):
    from evoflow.collab import app_runner

    updates: list[tuple] = []

    def _upd(run_id, status, **fields):
        updates.append((run_id, status, fields))

    monkeypatch.setattr(app_runner.app_repositories, "update_run_status", _upd)
    monkeypatch.setattr(
        app_runner.app_repositories,
        "load_run",
        lambda rid: {"id": rid, "status": "executing", "progress": 50},
    )

    out = app_runner.push_app_run_from_main_task(
        {
            "id": "mt1",
            "source_app_id": "App_x",
            "source_run_id": "run1",
            "status": "completed",
            "progress": 100,
        }
    )
    assert out == "completed"
    assert updates and updates[0][:2] == ("run1", "completed")


def test_light_lease_shorter_than_full():
    from evoflow.subagents.runtime_guard import collab_subtask_lease_seconds

    full = collab_subtask_lease_seconds(600)
    light = collab_subtask_lease_seconds(600, reporting_mode="light")
    assert full >= 300
    assert light <= 300
    assert light < full
    assert light >= 120
