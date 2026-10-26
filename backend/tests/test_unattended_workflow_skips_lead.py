"""Workflow-bound (App/DAG) tasks must never enter the Lead planning path.

A published App already carries its plan (``app_definition_snapshot``), so the
unattended queue only has to dispatch -> collect -> finalize. Before this guard
the pipeline still created a LangGraph thread and hydrated the ``plan`` scenario
for pure DAG runs, which cost a full Lead Agent context (dozens of model calls,
hundreds of k tokens) for tasks that need no agent at all.
"""

from __future__ import annotations

import pytest

from app.gateway import unattended_task_pipeline as pipeline

WORKFLOW_TASK = {
    "id": "wf1",
    "run_mode": "unattended",
    "status": "planned",
    "app_definition_snapshot": {"app_id": "App_x", "steps": [{"ref": "s1"}]},
    "plan_goal": "run the app",
    "plan_steps": [{"ref": "s1", "name": "s1", "goal": "g", "assigned_agent": "general-purpose"}],
    "subtasks": [],
}

LEAD_TASK = {
    "id": "lead1",
    "run_mode": "unattended",
    "status": "planned",
    "plan_steps": [{"ref": "s1", "name": "s1", "goal": "g", "assigned_agent": "general-purpose"}],
    "subtasks": [],
}


def test_is_workflow_bound_detects_app_run():
    assert pipeline._is_workflow_bound(WORKFLOW_TASK) is True
    assert pipeline._is_workflow_bound({"source_app_id": "App_y"}) is True
    assert pipeline._is_workflow_bound(LEAD_TASK) is False
    assert pipeline._is_workflow_bound(None) is False


@pytest.mark.asyncio
async def test_workflow_dispatch_failure_does_not_fall_into_lead_path(monkeypatch: pytest.MonkeyPatch):
    """A failed dispatch must return, not continue to _ensure_langgraph_thread."""
    monkeypatch.setattr(pipeline, "find_main_task", lambda _s, _t: ({"id": "p"}, dict(WORKFLOW_TASK)))
    monkeypatch.setattr(pipeline, "get_project_storage", lambda: object())
    monkeypatch.setattr(pipeline, "is_unattended_task", lambda _t: True)
    monkeypatch.setattr(pipeline, "is_task_execution_authorized", lambda _s, _t: True)
    async def _noop_finalize(_t):
        return None

    monkeypatch.setattr(pipeline, "_finalize_executing_task", _noop_finalize)

    ensure_thread_calls: list[str] = []

    async def _ensure_thread(task_id, _task):
        ensure_thread_calls.append(task_id)
        return "thread-should-not-be-created"

    monkeypatch.setattr(pipeline, "_ensure_langgraph_thread", _ensure_thread)
    monkeypatch.setattr(
        "evoflow.collab.app_runner.dispatch_workflow_task_now",
        _async_return({"success": False, "error": "boom"}),
    )
    monkeypatch.setattr("evoflow.collab.app_runner._dispatch_result_ok", lambda _p: False)

    out = await pipeline.advance_unattended_task("wf1")

    assert ensure_thread_calls == [], "workflow run must not create a LangGraph thread"
    assert out["ok"] is False
    assert out["error"] == "boom"


@pytest.mark.asyncio
async def test_workflow_dispatch_success_returns_dispatched(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(pipeline, "find_main_task", lambda _s, _t: ({"id": "p"}, dict(WORKFLOW_TASK)))
    monkeypatch.setattr(pipeline, "get_project_storage", lambda: object())
    monkeypatch.setattr(pipeline, "is_unattended_task", lambda _t: True)
    monkeypatch.setattr(pipeline, "is_task_execution_authorized", lambda _s, _t: True)
    async def _noop_finalize(_t):
        return None

    monkeypatch.setattr(pipeline, "_finalize_executing_task", _noop_finalize)
    monkeypatch.setattr(pipeline, "_patch_task", lambda _tid, _fn: None)

    ensure_thread_calls: list[str] = []

    async def _ensure_thread(task_id, _task):
        ensure_thread_calls.append(task_id)
        return "thread-should-not-be-created"

    monkeypatch.setattr(pipeline, "_ensure_langgraph_thread", _ensure_thread)
    monkeypatch.setattr(
        "evoflow.collab.app_runner.dispatch_workflow_task_now",
        _async_return({"success": True}),
    )
    monkeypatch.setattr("evoflow.collab.app_runner._dispatch_result_ok", lambda _p: True)

    out = await pipeline.advance_unattended_task("wf1")

    assert ensure_thread_calls == []
    assert out["action"] == "dispatched"


@pytest.mark.asyncio
async def test_workflow_failure_skips_lead_followup(monkeypatch: pytest.MonkeyPatch):
    """Subtask failure on a workflow run must not trigger a Lead Agent follow-up."""
    follow_calls: list[str] = []

    async def _follow(*, thread_id, main_task_id, recommendation):
        follow_calls.append(main_task_id)

    monkeypatch.setattr(
        "evoflow.tools.builtins.supervisor.monitor._trigger_lead_follow_run",
        _follow,
    )

    task = dict(WORKFLOW_TASK, thread_id="11111111-1111-1111-1111-111111111111")
    await pipeline._notify_lead_agent_task_failed("wf1", task)

    assert follow_calls == [], "workflow run has no Lead Agent to follow up"


def _async_return(value):
    async def _inner(*_args, **_kwargs):
        return value

    return _inner


# --- Unified project_path for workflow runs -------------------------------


def test_resolve_workflow_project_path_env_override(monkeypatch: pytest.MonkeyPatch):
    from evoflow.collab.app_runner import _resolve_workflow_project_path

    monkeypatch.setenv("EVOFLOW_WORKFLOW_PROJECT_PATH", "/tmp/explicit-root")
    assert _resolve_workflow_project_path() == "/tmp/explicit-root"


def test_resolve_workflow_project_path_finds_repo_root():
    """The run cwd must contain backend/ — not just any parent directory."""
    import os

    from evoflow.collab.app_runner import _resolve_workflow_project_path

    resolved = _resolve_workflow_project_path()
    assert resolved, "workflow runs must get a cwd anchor"
    assert os.path.isdir(os.path.join(resolved, "backend")), resolved


def test_artifact_verification_silent_when_no_outputs_declared(monkeypatch: pytest.MonkeyPatch, caplog):
    """A task with no expected_outputs must not warn about missing project_path."""
    import logging as _logging

    from evoflow.collab import execution_kernel

    task = {"id": "t1", "subtasks": [{"id": "s1", "status": "completed", "worker_profile": {}}]}
    monkeypatch.setattr(execution_kernel, "find_main_task", None, raising=False)
    monkeypatch.setattr(
        "evoflow.collab.storage.find_main_task",
        lambda _s, _t: ({"id": "p"}, task),
    )

    with caplog.at_level(_logging.WARNING):
        execution_kernel.verify_upstream_artifacts_before_followup(object(), "t1")

    assert "project_path is empty" not in caplog.text


def test_artifact_verification_warns_when_outputs_declared(monkeypatch: pytest.MonkeyPatch, caplog):
    """A task that DOES declare expected_outputs must surface the missing anchor."""
    import logging as _logging

    from evoflow.collab import execution_kernel

    task = {
        "id": "t1",
        "subtasks": [
            {
                "id": "s1",
                "status": "completed",
                "worker_profile": {"expected_outputs": ["report.md"]},
            }
        ],
    }
    monkeypatch.setattr(
        "evoflow.collab.storage.find_main_task",
        lambda _s, _t: ({"id": "p"}, task),
    )

    with caplog.at_level(_logging.WARNING):
        execution_kernel.verify_upstream_artifacts_before_followup(object(), "t1")

    assert "project_path is empty" in caplog.text


# --- Observability must be bounded by the task's own run window -----------


def test_task_observation_window_uses_task_times():
    from evoflow.collab.task_observability import _task_observation_window

    task = {"started_at": "2026-10-25T22:48:03", "completed_at": "2026-10-25T22:52:39"}
    assert _task_observation_window(task) == ("2026-10-25T22:48:03", "2026-10-25T22:52:39")


def test_task_observation_window_open_ended_while_running():
    from evoflow.collab.task_observability import _task_observation_window

    start, end = _task_observation_window({"started_at": "2026-10-25T22:48:03"})
    assert start == "2026-10-25T22:48:03"
    assert end is None


def test_task_observation_window_empty_without_start():
    from evoflow.collab.task_observability import _task_observation_window

    assert _task_observation_window({}) == (None, None)
    assert _task_observation_window(None) == (None, None)


def _capture_breakdown_sql(monkeypatch, **kwargs) -> str:
    from evoflow.observability import queries

    captured: list[str] = []

    class _FakeConn:
        def execute(self, sql, params=()):  # noqa: ANN001
            captured.append(sql)

            class _R:
                def fetchall(self_inner):
                    return []

            return _R()

    class _FakeStore:
        def _connection(self):
            return _FakeConn()

    monkeypatch.setattr(queries, "_store", lambda: _FakeStore())
    queries.fetch_observability_breakdown_by_thread(["t1"], **kwargs)
    return " ".join(captured)


def test_breakdown_accepts_run_window(monkeypatch: pytest.MonkeyPatch):
    """The run window must narrow the query range, not be silently ignored."""
    sqls = _capture_breakdown_sql(
        monkeypatch,
        since_hours=None,
        window_start="2026-10-25T22:48:03",
        window_end="2026-10-25T22:52:39",
    )
    assert "requested_at >= ?" in sqls and "requested_at <= ?" in sqls
    assert "ended_at >= ?" in sqls and "ended_at <= ?" in sqls


def test_breakdown_without_window_has_no_upper_bound(monkeypatch: pytest.MonkeyPatch):
    sqls = _capture_breakdown_sql(monkeypatch, since_hours=None)
    assert "requested_at >=" not in sqls


def test_subtask_inherits_run_project_path():
    """A step without its own project_path must fall back to the run directory."""
    import inspect

    from evoflow.collab import plan_subtasks_sync as pss

    src = inspect.getsource(pss.sync_subtasks_from_plan_steps)
    assert 'project_path = str(step.get("project_path") or "").strip() or run_project_path' in src
    assert 'task.get("project_path") or project.get("project_path")' in src


# --- Workflow runs must not inherit the invoker's thread -------------------


def test_workflow_task_has_no_thread_id():
    """An App run must not carry a thread_id — it would share the chat's obs bucket."""
    import inspect

    from evoflow.collab import app_runner

    src = inspect.getsource(app_runner.run_app_workflow)
    assert 'task_data.pop("thread_id", None)' in src
    assert 'task_data.pop("current_execution_thread_id", None)' in src


@pytest.mark.asyncio
async def test_dispatch_for_task_workflow_ignores_thread(monkeypatch: pytest.MonkeyPatch):
    from evoflow.collab import workflow_runtime

    seen: dict[str, object] = {}

    async def _start(task_id, *, authorized_by="api", thread_id=None):
        seen["thread_id"] = thread_id
        return {"ok": True, "dispatch": {"success": True}}

    monkeypatch.setattr(workflow_runtime, "start", _start)
    monkeypatch.setattr(
        workflow_runtime,
        "_load_main_task",
        lambda _t: {"id": "wf1", "app_definition_snapshot": {"app_id": "App_x"}},
    )

    await workflow_runtime.dispatch_for_task("wf1", thread_id="chat-thread-should-be-dropped")
    assert seen["thread_id"] is None


@pytest.mark.asyncio
async def test_scheduler_advance_ignores_thread(monkeypatch: pytest.MonkeyPatch):
    from evoflow.collab import workflow_scheduler

    seen: dict[str, object] = {}

    async def _dispatch(task_id, *, thread_id=None, authorized_by="api"):
        seen["thread_id"] = thread_id
        return {"success": True, "delegatedSubtasks": [{"ok": True}]}

    monkeypatch.setattr(
        workflow_scheduler,
        "_load_main_task",
        lambda _t: {
            "id": "wf1",
            "app_definition_snapshot": {"app_id": "App_x"},
            "subtasks": [],
        },
    )
    monkeypatch.setattr(workflow_scheduler, "_push_app_run", lambda *a, **k: None)
    monkeypatch.setattr(
        "evoflow.collab.dispatch_authorized_execution.dispatch_authorized_main_task_execution",
        _dispatch,
    )
    monkeypatch.setattr(workflow_scheduler, "is_workflow_scheduler_task", lambda _t: True)

    await workflow_scheduler.advance_dag("wf1", reason="initial", thread_id="chat-thread")
    assert seen.get("thread_id") is None


# --- The write path that actually leaked the chat thread ------------------


def test_pin_session_model_skips_thread_for_workflow(monkeypatch: pytest.MonkeyPatch):
    """_pin_collab_session_model_on_main_task must not stamp thread on App runs."""
    import inspect

    from evoflow.tools.builtins.supervisor import execution

    src = inspect.getsource(execution._pin_collab_session_model_on_main_task)
    assert "_is_workflow_bound_main_task" in src
    assert 'patch["thread_id"] = lead_tid' in src


def test_is_workflow_bound_main_task_detects_app(monkeypatch: pytest.MonkeyPatch):
    from evoflow.tools.builtins.supervisor import execution

    monkeypatch.setattr(
        "evoflow.collab.storage.find_main_task",
        lambda _s, _t: ({"id": "p"}, {"id": "t1", "app_definition_snapshot": {"app_id": "A"}}),
    )
    assert execution._is_workflow_bound_main_task(object(), "t1") is True

    monkeypatch.setattr(
        "evoflow.collab.storage.find_main_task",
        lambda _s, _t: ({"id": "p"}, {"id": "t2"}),
    )
    assert execution._is_workflow_bound_main_task(object(), "t2") is False


def test_reconcile_skips_workflow_task(monkeypatch: pytest.MonkeyPatch):
    """Chat reconcile must not bind a thread onto an App run."""
    from evoflow.collab import conversation_persist

    saved: list[dict] = []

    class _Store:
        def save_project(self, project):  # noqa: ANN001
            saved.append(project)
            return True

    task = {"id": "t1", "app_definition_snapshot": {"app_id": "A"}, "thread_id": None}
    monkeypatch.setattr(
        conversation_persist, "find_main_task", lambda _s, _t: ({"id": "p"}, task)
    )

    count = conversation_persist.reconcile_lead_conversation_from_chat(_Store(), "t1", "chat-thread")
    assert count == 0
    assert task["thread_id"] is None
    assert saved == []


def test_persist_strips_workflow_thread():
    """The persistence layer is the last guard: workflow rows never keep a thread."""
    import inspect

    from evoflow.persistence import task_repositories as tr

    src = inspect.getsource(tr.save_task_bundle)
    assert "workflow_thread_stripped" in src
    assert 'tr["thread_id"] = None' in src
    assert "_is_app" in src
