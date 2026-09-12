"""Automations in SQLite."""

from __future__ import annotations

import tempfile

import pytest

from evoflow.persistence import automation_repositories as auto_repo
from evoflow.persistence.db import get_db, reset_db_for_tests


@pytest.fixture
def sqlite_tmp(monkeypatch: pytest.MonkeyPatch):
    with tempfile.TemporaryDirectory() as tmp:
        monkeypatch.setenv("EVOFLOW_HOME", tmp)
        reset_db_for_tests()
        get_db()
        yield
        reset_db_for_tests()


def test_automation_save_load(sqlite_tmp) -> None:
    del sqlite_tmp
    auto_repo.save_automation("t1", {"name": "daily", "prompt": "hi", "status": "active", "schedule": "0 9 * * *"})
    doc = auto_repo.load_automation("t1")
    assert doc is not None
    assert doc["name"] == "daily"
    auto_repo.append_automation_run("t1", {"status": "success"})
    runs = auto_repo.list_automation_runs("t1", limit=10)
    assert len(runs) == 1


def test_automation_runs_newest_first_and_summary(sqlite_tmp) -> None:
    del sqlite_tmp
    auto_repo.save_automation("t2", {"name": "n", "prompt": "p", "status": "active", "schedule": "0 9 * * *"})
    auto_repo.append_automation_run(
        "t2",
        {"run_id": "old", "status": "success", "started_at": "2026-01-01T00:00:00Z", "output": "langgraph: ok"},
    )
    auto_repo.append_automation_run(
        "t2",
        {
            "run_id": "new",
            "status": "success",
            "started_at": "2026-08-12T12:00:00Z",
            "summary": "今日巡检完成：一切正常",
            "duration_seconds": 42,
            "output": "langgraph: ok\npush:feishu: ok",
        },
    )
    runs = auto_repo.list_automation_runs("t2", limit=10)
    assert [r.get("run_id") for r in runs] == ["new", "old"]
    assert runs[0].get("summary") == "今日巡检完成：一切正常"
    assert runs[0].get("duration_seconds") == 42

    from evoflow.admin import automation as auto_admin

    hist = auto_admin.get_automation_history("t2", limit=1)
    assert hist["total"] == 2
    assert len(hist["runs"]) == 1
    assert hist["runs"][0].get("run_id") == "new"
    assert hist["runs"][0].get("summary") == "今日巡检完成：一切正常"
