"""Additional tests for expanded evoflow admin + CLI."""

from __future__ import annotations

import gc
import json
import tempfile
from pathlib import Path

import pytest

from evoflow.admin import agents as agents_admin
from evoflow.admin import automation as automation_admin
from evoflow.admin import experience as experience_admin
from evoflow.admin import profile as profile_admin
from evoflow.admin.errors import NotFoundError
from evoflow.cli.main import main
from evoflow.persistence.db import get_db, reset_db_for_tests


@pytest.fixture
def sqlite_tmp(monkeypatch: pytest.MonkeyPatch):
    from evoflow.config.app_config import reset_app_config

    with tempfile.TemporaryDirectory() as tmp:
        monkeypatch.setenv("EVOFLOW_HOME", tmp)
        reset_app_config()
        reset_db_for_tests()
        get_db()
        yield Path(tmp)
        reset_db_for_tests()
        reset_app_config()
        gc.collect()


def test_experience_crud(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    saved = experience_admin.save_experience(
        {
            "title": "Fix flaky test",
            "category": "coding/python",
            "tags": ["pytest"],
            "problem": "Random failure",
            "solution": "Use fixed seed",
        }
    )
    exp_id = saved["id"]
    listed = experience_admin.list_experiences(query="flaky")
    assert listed["total"] >= 1
    got = experience_admin.get_experience(exp_id)
    assert got["title"] == "Fix flaky test"
    experience_admin.mark_experience_used(exp_id)
    experience_admin.delete_experience(exp_id)
    with pytest.raises(NotFoundError):
        experience_admin.get_experience(exp_id)


def test_profile_roundtrip(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    profile_admin.update_user_profile_dimension(
        "preferences",
        "Likes TypeScript",
        mode="append",
    )
    shown = profile_admin.get_user_profile()
    dims = shown.get("dimensions") or {}
    assert "TypeScript" in (dims.get("preferences.md") or "")


def test_automation_crud(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    created = automation_admin.create_automation(
        {"name": "Daily report", "prompt": "Summarize inbox", "schedule": "@daily"}
    )
    task_id = created["id"]
    listed = automation_admin.list_automations()
    assert any(a["id"] == task_id for a in listed["automations"])
    automation_admin.set_automation_status(task_id, status="paused")
    automation_admin.delete_automation(task_id)


def test_cli_agents_list_tag_filter(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    from evoflow.persistence import config_repositories as cfg_repo

    cfg_repo.upsert_agent(
        "tag-cli-bot",
        {"agent_code": "tag-cli-bot", "agent_type": "custom", "tags": ["调试"]},
    )
    listed = agents_admin.list_agents(tag="调试")
    codes = {a["agent_code"] for a in listed["agents"]}
    assert "tag-cli-bot" in codes


def test_cli_experience_list(capsys, sqlite_tmp: Path) -> None:
    del sqlite_tmp
    experience_admin.save_experience({"title": "CLI exp", "problem": "x", "solution": "y"})
    code = main(["experience", "list", "--query", "CLI"])
    assert code == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["total"] >= 1
