"""Unattended automation scenario bootstrap."""

from __future__ import annotations

import tempfile

import pytest

from evoflow.agents.automation_runtime import (
    AUTOMATION_TRIGGER,
    automation_default_scenario_keys,
    bootstrap_unattended_automation_scenarios,
    is_unattended_automation,
    triggered_by_automation,
)
from evoflow.persistence.db import get_db, reset_db_for_tests


@pytest.fixture
def sqlite_tmp(monkeypatch: pytest.MonkeyPatch):
    with tempfile.TemporaryDirectory() as tmp:
        monkeypatch.setenv("EVOFLOW_HOME", tmp)
        reset_db_for_tests()
        get_db()
        yield
        reset_db_for_tests()


def test_triggered_by_automation() -> None:
    from evoflow.agents.automation_runtime import UNATTENDED_TASK_QUEUE_TRIGGER

    assert triggered_by_automation({"triggered_by": AUTOMATION_TRIGGER}) is True
    assert triggered_by_automation({"triggered_by": UNATTENDED_TASK_QUEUE_TRIGGER}) is True
    assert triggered_by_automation({"triggered_by": "user"}) is False


def test_is_unattended_automation_from_runtime() -> None:
    from types import SimpleNamespace

    rt = SimpleNamespace(context={"triggered_by": AUTOMATION_TRIGGER})
    assert is_unattended_automation(rt) is True


def test_automation_default_scenario_keys() -> None:
    keys = automation_default_scenario_keys()
    assert keys == ["agent"]


def test_bootstrap_unattended_automation_scenarios(sqlite_tmp) -> None:
    from evoflow.persistence import session_repositories as sess_repo
    from evoflow.tools.builtins.scenario_activation import get_activated_scenarios

    sk = "automation:test:run-1"
    tid = "thread-auto-1"
    sess_repo.upsert_session_row(sk, thread_id=tid, title="t", created_at_ms=1, updated_at_ms=1)
    out = bootstrap_unattended_automation_scenarios(thread_id=tid, session_key=sk, scenarios=["agent"])
    assert out == ["agent"]
    assert sess_repo.get_session_activated_scenarios(sk) == ["agent"]
    assert set(get_activated_scenarios()) == {"agent"}
