"""SessionRunLifecycleMiddleware — mark run_status from after_agent."""

from __future__ import annotations

import tempfile

import pytest

from evoflow.agents.lead_agent.runtime_context import LeadAgentRuntimeContext
from evoflow.agents.middlewares.session_run_lifecycle_middleware import (
    SessionRunLifecycleMiddleware,
    mark_session_ended_from_agent,
    should_hold_session_running,
)
from evoflow.persistence import session_repositories as sess_repo
from evoflow.persistence.db import get_db, reset_db_for_tests
from evoflow.persistence.session_run_state import RUN_STATUS_DONE, RUN_STATUS_RUNNING, mark_session_run_started


@pytest.fixture
def sqlite_tmp(monkeypatch: pytest.MonkeyPatch):
    with tempfile.TemporaryDirectory() as tmp:
        monkeypatch.setenv("EVOFLOW_HOME", tmp)
        reset_db_for_tests()
        get_db()
        yield
        reset_db_for_tests()


def _runtime(session_key: str, thread_id: str = "tid-lifecycle"):
    return type(
        "Rt",
        (),
        {"context": LeadAgentRuntimeContext(session_key=session_key, thread_id=thread_id)},
    )()


def test_should_hold_when_pending_approvals(monkeypatch) -> None:
    monkeypatch.setattr(
        "evoflow.agents.tool_approval_service.thread_has_pending_approvals",
        lambda tid: tid == "tid-hold",
    )
    assert should_hold_session_running("tid-hold") is True
    assert should_hold_session_running("tid-free") is False


def test_mark_session_ended_from_agent_writes_done(sqlite_tmp: None, monkeypatch) -> None:
    sk = "agent:main:lifecycle-end"
    tid = "tid-lifecycle-end"
    sess_repo.upsert_session_row(sk, thread_id=tid, title="t")
    mark_session_run_started(session_key=sk, run_id="run-1", status=RUN_STATUS_RUNNING)
    monkeypatch.setattr(
        "evoflow.agents.middlewares.session_run_lifecycle_middleware.should_hold_session_running",
        lambda _tid: False,
    )
    assert mark_session_ended_from_agent(session_key=sk, thread_id=tid) is True
    row = sess_repo.get_session_row_for_ui(sk) or {}
    assert row.get("runStatus") == RUN_STATUS_DONE
    assert not row.get("currentRunId")


def test_mark_session_ended_skips_when_held(sqlite_tmp: None, monkeypatch) -> None:
    sk = "agent:main:lifecycle-hold"
    tid = "tid-lifecycle-hold"
    sess_repo.upsert_session_row(sk, thread_id=tid, title="t")
    mark_session_run_started(session_key=sk, run_id="run-2", status=RUN_STATUS_RUNNING)
    monkeypatch.setattr(
        "evoflow.agents.middlewares.session_run_lifecycle_middleware.should_hold_session_running",
        lambda _tid: True,
    )
    assert mark_session_ended_from_agent(session_key=sk, thread_id=tid) is False
    row = sess_repo.get_session_row_for_ui(sk) or {}
    assert row.get("runStatus") == RUN_STATUS_RUNNING
    assert row.get("currentRunId") == "run-2"


def test_after_agent_marks_terminal(sqlite_tmp: None, monkeypatch) -> None:
    sk = "agent:main:lifecycle-mw"
    tid = "tid-lifecycle-mw"
    sess_repo.upsert_session_row(sk, thread_id=tid, title="t")
    mark_session_run_started(session_key=sk, run_id="run-3", status=RUN_STATUS_RUNNING)
    monkeypatch.setattr(
        "evoflow.agents.middlewares.session_run_lifecycle_middleware.should_hold_session_running",
        lambda _tid: False,
    )
    mw = SessionRunLifecycleMiddleware()
    assert mw.after_agent({"messages": []}, _runtime(sk, tid)) is None
    row = sess_repo.get_session_row_for_ui(sk) or {}
    assert row.get("runStatus") == RUN_STATUS_DONE
