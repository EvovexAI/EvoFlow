"""Collab follow-up waves must inherit the lead session model, not primary default."""

from __future__ import annotations

import tempfile
from pathlib import Path
from types import SimpleNamespace

import pytest

from evoflow.agents.lead_agent.runtime_context import resolve_session_model_name_from_runtime
from evoflow.collab.thread_ids import collab_subtask_executor_thread_id
from evoflow.persistence.db import reset_db_for_tests
from evoflow.tools.builtins.supervisor import execution as exec_mod


@pytest.fixture
def sqlite_tmp(monkeypatch: pytest.MonkeyPatch):
    with tempfile.TemporaryDirectory() as tmp:
        db = Path(tmp) / "test_evolflow.db"
        monkeypatch.setenv("EVOFLOW_HOME", tmp)
        reset_db_for_tests()
        yield db
        reset_db_for_tests()


def _runtime(*, thread_id: str, metadata: dict | None = None, configurable: dict | None = None):
    return SimpleNamespace(
        context={"thread_id": thread_id},
        config={
            "metadata": metadata or {},
            "configurable": {"thread_id": thread_id, **(configurable or {})},
        },
    )


def test_resolve_session_model_from_metadata():
    rt = _runtime(thread_id="lead-1", metadata={"model_name": "session-model"})
    assert resolve_session_model_name_from_runtime(rt) == "session-model"


def test_resolve_session_model_from_configurable_when_metadata_missing():
    rt = _runtime(thread_id="lead-1", configurable={"model_name": "cfg-model"})
    assert resolve_session_model_name_from_runtime(rt) == "cfg-model"


def test_resolve_session_model_prefers_context_over_metadata():
    rt = _runtime(
        thread_id="lead-1",
        metadata={"model_name": "primary-stale"},
    )
    rt.context = {"thread_id": "lead-1", "model_name": "session-selected"}
    assert resolve_session_model_name_from_runtime(rt) == "session-selected"


def test_resolve_session_model_ignores_primary_model_name_in_context():
    rt = _runtime(thread_id="lead-1")
    rt.context = {"thread_id": "lead-1", "primary_model_name": "global-primary"}
    assert resolve_session_model_name_from_runtime(rt) is None


def test_resolve_session_model_uses_pinned_main_task_model():
    rt = _runtime(thread_id="lead-1", metadata={"model_name": "primary-stale"})
    assert (
        resolve_session_model_name_from_runtime(
            rt,
            pinned_model_name="pinned-session-model",
        )
        == "pinned-session-model"
    )


def test_resolve_session_model_from_lead_thread_id_db(sqlite_tmp, monkeypatch):
    from evoflow.persistence.session_repositories import upsert_session_row

    upsert_session_row("sk-model", thread_id="lead-db", model_name="db-model")
    worker_tid = collab_subtask_executor_thread_id("lead-db", "Sub_2")
    rt = _runtime(thread_id=worker_tid)
    assert resolve_session_model_name_from_runtime(rt, lead_thread_id="lead-db") == "db-model"


def test_resolve_session_model_from_session_key_db(sqlite_tmp):
    from evoflow.persistence.session_repositories import upsert_session_row

    upsert_session_row("sk-by-key", thread_id="lead-sk", model_name="session-key-model")
    rt = _runtime(thread_id="orphan-thread")
    assert resolve_session_model_name_from_runtime(rt, session_key="sk-by-key") == "session-key-model"


def test_register_collab_lead_runtime_skips_subtask_worker():
    exec_mod._collab_lead_runtime_strong.clear()
    exec_mod._collab_lead_runtime_by_task.clear()
    lead = _runtime(thread_id="lead-x", metadata={"model_name": "lead-model"})
    worker_tid = collab_subtask_executor_thread_id("lead-x", "Sub_1")
    worker = _runtime(thread_id=worker_tid)

    exec_mod._register_collab_lead_runtime("Task_model", lead)
    exec_mod._register_collab_lead_runtime("Task_model", worker)

    assert exec_mod._collab_lead_runtime_strong["Task_model"] is lead


def test_resolve_collab_followup_runtime_prefers_pinned_lead_over_worker():
    exec_mod._collab_lead_runtime_strong.clear()
    lead = _runtime(thread_id="lead-y", metadata={"model_name": "lead-model"})
    worker_tid = collab_subtask_executor_thread_id("lead-y", "Sub_1")
    worker = _runtime(thread_id=worker_tid)
    exec_mod._collab_lead_runtime_strong["Task_follow"] = lead

    resolved = exec_mod._resolve_collab_followup_runtime(worker, "Task_follow")
    assert resolved is lead
