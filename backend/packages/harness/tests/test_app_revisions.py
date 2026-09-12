"""App revisions + task provenance (source_app_id)."""

from __future__ import annotations

import tempfile
from pathlib import Path

import pytest

from evoflow.persistence.db import get_db, reset_db_for_tests


@pytest.fixture
def sqlite_tmp(monkeypatch: pytest.MonkeyPatch):
    with tempfile.TemporaryDirectory() as tmp:
        monkeypatch.setenv("EVOFLOW_HOME", tmp)
        reset_db_for_tests()
        yield Path(tmp)
        reset_db_for_tests()
        import gc

        gc.collect()


def test_save_app_writes_revision(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    from evoflow.persistence import app_repositories

    get_db()
    app_repositories.save_app(
        "App_rev1",
        {
            "name": "Rev Demo",
            "steps": [{"ref": "1", "goal": "g", "tools": "a,b", "depends_on": []}],
            "parameters": [{"name": "topic", "label": "主题"}],
            "goal_template": "do {{topic}}",
            "version": 1,
            "status": "draft",
        },
    )
    rev = app_repositories.load_revision("App_rev1", 1)
    assert rev is not None
    assert rev["snapshot"]["steps"][0]["tools"] == ["a", "b"]
    assert "canvas" not in rev["snapshot"]["steps"][0]
    assert rev["snapshot"]["parameters"][0]["name"] == "topic"

    app_repositories.save_app(
        "App_rev1",
        {
            **app_repositories.load_app("App_rev1"),
            "version": 2,
            "status": "published",
            "goal_template": "do {{topic}} v2",
        },
    )
    listed = app_repositories.list_revisions("App_rev1")
    assert [r["version"] for r in listed] == [2, 1]
    assert app_repositories.load_revision("App_rev1", 1)["snapshot"]["goal_template"] == "do {{topic}}"
    assert app_repositories.load_revision("App_rev1", 2)["snapshot"]["status"] == "published"


def test_stamp_helpers_set_source_fields() -> None:
    from evoflow.collab.app_runner import _stamp_task_app_source

    task: dict = {"id": "Task_x", "name": "n"}
    _stamp_task_app_source(
        task, app_id="App_1", run_id="Run_1", app_version=3, app_name="Demo"
    )
    assert task["source_app_id"] == "App_1"
    assert task["source_run_id"] == "Run_1"
    assert task["source_app_version"] == 3
    assert task["source_app_name"] == "Demo"


def test_restore_app_from_revision(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    from evoflow.persistence import app_repositories

    get_db()
    app_repositories.save_app(
        "App_restore1",
        {
            "name": "V1",
            "steps": [{"ref": "1", "goal": "old", "tools": ["a"], "depends_on": []}],
            "parameters": [{"name": "topic", "label": "主题"}],
            "goal_template": "do {{topic}}",
            "version": 1,
            "status": "draft",
        },
    )
    app_repositories.save_app(
        "App_restore1",
        {
            **app_repositories.load_app("App_restore1"),
            "name": "V2",
            "goal_template": "do {{topic}} v2",
            "steps": [{"ref": "1", "goal": "new", "tools": ["b"], "depends_on": []}],
            "version": 2,
            "status": "published",
        },
    )
    restored = app_repositories.restore_app_from_revision("App_restore1", 1, as_draft=True)
    assert restored["version"] == 3
    assert restored["status"] == "draft"
    assert restored["goal_template"] == "do {{topic}}"
    assert restored["steps"][0]["goal"] == "old"
    assert restored["name"] == "V1"
    # Old snapshots immutable
    assert app_repositories.load_revision("App_restore1", 1)["snapshot"]["goal_template"] == "do {{topic}}"
    assert app_repositories.load_revision("App_restore1", 2)["snapshot"]["name"] == "V2"
    assert app_repositories.load_revision("App_restore1", 3)["note"] == "restore from v1"
