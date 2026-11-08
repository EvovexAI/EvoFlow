"""``workflow.stop(pause=true)`` must actually stop the DAG.

Live reproduction (2026-11-08, then again on a freshly restarted dev build):
stop( pause=true ) returned ``paused: true``, the run row briefly read
``paused``, and then the in-flight worker finished, released the next wave and
the run sailed to ``completed/100%`` — resume then refused with
``not resumable (status=executing)``.

Root cause: pause only relabelled rows. Nothing on the dispatch path read the
main-task status, so every subsequent wave went out anyway. The gate now lives
in ``dispatch_authorized_main_task_execution`` — the single funnel for the first
wave, follow-up waves and reconcile ticks.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from evoflow.collab import dispatch_authorized_execution as dae


class _Storage:
    def __init__(self, task: dict[str, Any]):
        self._project = {"id": "p1", "tasks": [task]}

    def list_projects(self):
        return [{"id": "p1"}]

    def load_project(self, project_id, *, bypass_cache: bool = False):
        return self._project

    def save_project(self, project):
        self._project = project
        return True


def _task(status: str, *, exec_authorized: bool = True) -> dict[str, Any]:
    return {
        "id": "T_MAIN",
        "status": status,
        "progress": 37,
        "execution_authorized": exec_authorized,
        "subtasks": [
            {"id": "S1", "name": "S1", "status": "completed", "assigned_to": "agent"},
            {"id": "S2", "name": "S2", "status": "planned", "assigned_to": "agent",
             "worker_profile": {"depends_on": ["S1"]}},
        ],
    }


@pytest.fixture()
def _patched(monkeypatch):
    """Stub out the heavy collaborators; record whether a wave was actually sent."""
    sent: list[str] = []

    def _make(status: str):
        storage = _Storage(_task(status))

        import evoflow.collab.storage as storage_mod

        monkeypatch.setattr(storage_mod, "get_project_storage", lambda: storage, raising=False)
        monkeypatch.setattr(dae, "get_project_storage", lambda: storage, raising=False)

        import evoflow.collab.authorize_execution as auth

        monkeypatch.setattr(auth, "is_task_execution_authorized", lambda _s, _t: True, raising=False)

        async def _fake_coroutine(**kwargs):
            sent.append(kwargs.get("action") or "start_execution")
            return '{"success": true, "action": "start_execution", "taskId": "T_MAIN"}'

        # ``supervisor_tool`` is imported *inside* the function, and the
        # ``evoflow.tools.builtins`` package re-exports the StructuredTool object
        # under the module's own name (so ``tools.builtins.supervisor_tool`` is the
        # tool, not the module). Resolve the real module by file and patch the
        # coroutine on the object it holds.
        import importlib

        sup_mod = importlib.import_module("evoflow.tools.builtins.supervisor_tool")
        monkeypatch.setattr(sup_mod.supervisor_tool, "coroutine", _fake_coroutine, raising=False)
        import evoflow.tools.builtins.collab_bridge as bridge

        monkeypatch.setattr(bridge, "ensure_collab_bridge_ready", lambda *a, **k: (True, True), raising=False)
        import evoflow.tools.builtins.supervisor.dependency as dep

        monkeypatch.setattr(
            dep, "requeue_failed_subtasks_ready_for_retry", lambda *a, **k: [], raising=False
        )
        return storage

    return _make, sent


def _dispatch() -> dict[str, Any]:
    return asyncio.run(
        dae.dispatch_authorized_main_task_execution("T_MAIN", authorized_by="test")
    )


def test_paused_run_does_not_dispatch_a_wave(_patched):
    make, sent = _patched
    make("paused")
    out = _dispatch()
    assert out.get("success") is False
    assert out.get("error") == "paused", out
    assert sent == [], f"a wave went out while paused: {sent}"


def test_pausing_state_also_blocks(_patched):
    make, sent = _patched
    make("pausing")
    assert _dispatch().get("error") == "paused"
    assert sent == []


def test_running_run_still_dispatches(_patched):
    """The gate must not become a blanket brake."""
    make, sent = _patched
    make("executing")
    out = _dispatch()
    assert out.get("error") != "paused", out
    assert sent != [], "wave should have been sent for a running task"
@pytest.mark.asyncio
async def test_resume_status_opens_the_gate(monkeypatch):
    """Same task, same call — only ``status`` differs. paused blocks, executing goes.

    That is the whole resume contract: ``resume_run`` writes ``executing`` before
    asking the runtime to dispatch, so the gate cannot brick a resume.
    """
    from evoflow.collab import workflow_scheduler as ws

    called: list[str] = []

    async def _advance_followup(*a, **k):  # never reached while paused
        called.append("followup")
        return {"ok": True}

    monkeypatch.setattr(ws, "is_workflow_scheduler_task", lambda _t: True)
    monkeypatch.setattr(ws, "_load_main_task", lambda _tid: {
        "id": "wf1", "source_app_id": "App_x", "status": "paused",
    })
    out = await ws.advance_dag("wf1", reason="initial")
    assert out["error"] == "paused"
    assert called == []

    monkeypatch.setattr(ws, "_load_main_task", lambda _tid: {
        "id": "wf1", "source_app_id": "App_x", "status": "executing",
    })
    out2 = await ws.advance_dag("wf1", reason="initial")
    assert out2.get("error") != "paused", out2


@pytest.mark.asyncio
async def test_worker_delegation_refused_when_paused():
    """Third (and final) gate: hand-off to a worker.

    This is the path that actually bit us. ``workflow.stop(pause=true)`` leaves an
    already-detached worker running; when it reports done, the claim → delegate
    path re-enters ``delegate_collab_subtasks_for_start_execution`` — which is not
    the scheduler and not ``dispatch_authorized_main_task_execution``. With both
    of those gates installed the run still advanced 3% → 37% → 70%, so the brake
    has to exist here too.
    """
    from evoflow.tools.builtins.supervisor import execution as ex

    delegated: list[str] = []

    class _S:
        def load_project(self, _pid, *, bypass_cache=False):
            return {"id": "p1", "tasks": [{"id": "T", "status": "paused", "subtasks": []}]}

        def list_projects(self):
            return [{"id": "p1"}, {"id": "p1"}]

        def save_project(self, project):
            return True

    import evoflow.collab.storage as storage_mod

    def _fake_find(_storage, tid, **_kw):
        return ({"id": "p1"}, {"id": tid, "status": "paused", "subtasks": []})

    mp = pytest.MonkeyPatch()
    mp.setattr(storage_mod, "find_main_task", _fake_find)
    try:
        out = await ex.delegate_collab_subtasks_for_start_execution(
            None, _S(), "T", ["S1", "S2"]
        )
    finally:
        mp.undo()

    assert isinstance(out, list) and len(out) == 2
    assert all(item.get("error") == "paused" for item in out), out
    assert delegated == []
