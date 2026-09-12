# -*- coding: utf-8 -*-
"""Admin agents.create/update/delete validation (BUG report 2026-08-19)."""

from __future__ import annotations

import gc
import tempfile
from pathlib import Path

import pytest

from evoflow.admin import agents as agents_admin
from evoflow.admin import employees as employees_admin
from evoflow.admin.errors import ConflictError, NotFoundError, ValidationError
from evoflow.admin.platform_handlers import agents_update, agents_list
from evoflow.config.app_config import reset_app_config
from evoflow.persistence.db import get_db, reset_db_for_tests
from evoflow.proactive.repositories import ProactiveRepository
from unittest.mock import patch


@pytest.fixture
def sqlite_tmp(monkeypatch: pytest.MonkeyPatch):
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        db_path = root / "data" / "app" / "evoflow.db"
        db_path.parent.mkdir(parents=True, exist_ok=True)
        monkeypatch.setenv("EVOFLOW_HOME", str(root))
        monkeypatch.setenv("EVOFLOW_DB_PATH", str(db_path))
        monkeypatch.delenv("EVOFLOW_DATA_DIR", raising=False)
        reset_app_config()
        reset_db_for_tests()
        get_db()
        yield root
        reset_db_for_tests()
        reset_app_config()
        gc.collect()


def test_create_rejects_duplicate_agent_name(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    agents_admin.create_agent(
        {"agent_code": "dup-n1", "agent_name": "同名测试", "skills": []}
    )
    with pytest.raises(ConflictError, match="already used"):
        agents_admin.create_agent(
            {"agent_code": "dup-n2", "agent_name": "同名测试", "skills": []}
        )


def test_create_allows_apostrophe_in_agent_name(sqlite_tmp: Path) -> None:
    """SQL-looking strings are stored safely via parameterized queries."""
    del sqlite_tmp
    row = agents_admin.create_agent(
        {"agent_code": "sqli", "agent_name": "Test' OR '1'='1"}
    )
    assert row["agent_name"] == "Test' OR '1'='1"


def test_create_rejects_control_chars(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    with pytest.raises(ValidationError, match="control"):
        agents_admin.create_agent({"agent_code": "nl", "agent_name": "Line1\nLine2"})
    with pytest.raises(ValidationError, match="control"):
        agents_admin.create_agent({"agent_code": "tab", "agent_name": "Tab\tTest"})


def test_create_emoji_name_ok(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    row = agents_admin.create_agent(
        {
            "agent_code": "emoji",
            "agent_name": "Rocket Unicode Fire",
            "tags": ["测试", "目标"],
        }
    )
    assert row["agent_code"] == "emoji"


def test_create_dedupes_skills(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    row = agents_admin.create_agent(
        {"agent_code": "dup-sk", "skills": ["aihot", "aihot", "aihot"]}
    )
    assert row["skills"] == ["aihot"]


def test_create_rejects_unknown_skill(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    with pytest.raises(ValidationError, match="unknown skill"):
        agents_admin.create_agent(
            {"agent_code": "bad-sk", "skills": ["nonexistent-skill"]}
        )


def test_create_rejects_unknown_model(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    with pytest.raises(ValidationError, match="unknown model|unable to validate model"):
        agents_admin.create_agent(
            {"agent_code": "bad-mdl", "model": "nonexistent-model-xyz"}
        )


def test_create_rejects_unknown_mcp(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    with pytest.raises(ValidationError, match="unknown mcp"):
        agents_admin.create_agent(
            {"agent_code": "bad-mcp", "mcp_servers": ["nonexistent-mcp"]}
        )


def test_create_agent_code_empty_vs_blank(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    with pytest.raises(ValidationError, match="cannot be empty"):
        agents_admin.create_agent({"agent_code": "", "agent_name": "t"})
    with pytest.raises(ValidationError, match="cannot be blank"):
        agents_admin.create_agent({"agent_code": " ", "agent_name": "t"})
    with pytest.raises(ValidationError, match="is required"):
        agents_admin.create_agent({"agent_name": "t"})


def test_create_rejects_overlong_agent_code(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    with pytest.raises(ValidationError, match="too long"):
        agents_admin.create_agent({"agent_code": "x" * 200, "agent_name": "long"})


def test_delete_allows_legacy_overlong_agent_code(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    long_code = "legacy-" + ("x" * 80)
    from evoflow.config.agents_config import save_agent_config

    save_agent_config(long_code, {"agent_code": long_code, "agent_type": "custom", "skills": []})
    out = agents_admin.delete_agent(long_code)
    assert "deleted successfully" in out["message"]
    with pytest.raises(NotFoundError):
        agents_admin.get_agent(long_code)


def test_update_rejects_agent_code_rename(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    agents_admin.create_agent({"agent_code": "old-code", "agent_name": "Old"})
    with pytest.raises(ValidationError, match="immutable"):
        agents_update({"name": "old-code", "agent_code": "new-code"})
    with pytest.raises(ValidationError, match="immutable"):
        agents_admin.update_agent("old-code", {"agent_code": "new-code"})


def test_update_null_agent_name_leaves_unchanged(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    agents_admin.create_agent({"agent_code": "keep-name", "agent_name": "Keep"})
    row = agents_admin.update_agent("keep-name", {"agent_name": None, "description": "d"})
    assert row["agent_name"] == "Keep"
    assert row["description"] == "d"
    with pytest.raises(ValidationError, match="cannot be empty"):
        agents_admin.update_agent("keep-name", {"agent_name": ""})


def test_list_rejects_negative_limit(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    with pytest.raises(ValidationError, match="limit"):
        agents_list({"limit": -10})
    listed = agents_admin.list_agents(limit=1)
    assert len(listed["agents"]) == 1


def test_delete_cascades_employee(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    agents_admin.create_agent({"agent_code": "cascade-a", "agent_name": "Cascade"})
    employees_admin.hire({"agent_code": "cascade-a", "role_name": "R"})
    assert ProactiveRepository.get_role("cascade-a") is not None
    with pytest.raises(ValidationError, match="confirm_cascade|keep_employee"):
        agents_admin.delete_agent("cascade-a")
    out = agents_admin.delete_agent("cascade-a", confirm_cascade=True)
    assert out.get("employee_removed") is True
    assert ProactiveRepository.get_role("cascade-a") is None
    with pytest.raises(NotFoundError):
        agents_admin.get_agent("cascade-a")


def test_delete_keep_employee(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    agents_admin.create_agent({"agent_code": "keep-emp", "agent_name": "Keep Emp"})
    employees_admin.hire({"agent_code": "keep-emp", "role_name": "R"})
    out = agents_admin.delete_agent("keep-emp", keep_employee=True)
    assert out.get("employee_kept") is True
    assert ProactiveRepository.get_role("keep-emp") is not None
    with pytest.raises(NotFoundError):
        agents_admin.get_agent("keep-emp")

    agents_admin.create_agent({"agent_code": "keep-emp2", "agent_name": "K2"})
    employees_admin.hire({"agent_code": "keep-emp2", "role_name": "R2"})
    with pytest.raises(ValidationError, match="mutually exclusive"):
        agents_admin.delete_agent(
            "keep-emp2", confirm_cascade=True, keep_employee=True
        )


def test_create_persists_system_prompt_and_identity(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    row = agents_admin.create_agent(
        {
            "agent_code": "sp-id",
            "agent_name": "Prompted",
            "system_prompt": "Test prompt",
            "identity": "Test identity",
            "skills": ["aihot"],
        }
    )
    assert row.get("system_prompt") == "Test prompt"
    assert row.get("identity") == "Test identity"


def test_create_rejects_unknown_avatar_preset(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    with pytest.raises(ValidationError, match="unknown avatar"):
        agents_admin.create_agent(
            {
                "agent_code": "bad-av",
                "agent_name": "BadAv",
                "avatar": "preset:nonexistent-avatar",
            }
        )


def test_create_rejects_invalid_agent_type(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    with pytest.raises(ValidationError, match="agent_type"):
        agents_admin.create_agent(
            {"agent_code": "bad-type", "agent_name": "T", "agent_type": "invalid_type"}
        )


def test_list_tag_limit_offset_and_agent_name(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    agents_admin.create_agent(
        {"agent_code": "tag-a", "agent_name": "Alpha Name", "tags": ["核心"], "skills": []}
    )
    agents_admin.create_agent(
        {"agent_code": "tag-b", "agent_name": "Beta Name", "tags": ["媒体"], "skills": []}
    )
    empty = agents_admin.list_agents(tag="不存在的标签xyz")
    assert empty["agents"] == []
    core = agents_admin.list_agents(tag="核心")
    assert all("核心" in (a.get("tags") or []) for a in core["agents"] if a.get("agent_code") != "main")
    page = agents_admin.list_agents(limit=1, offset=0)
    assert len(page["agents"]) == 1
    by_name = agents_admin.list_agents(agent_name="Alpha Name")
    codes = [a["agent_code"] for a in by_name["agents"]]
    assert "tag-a" in codes
    assert "tag-b" not in codes


def test_description_allows_newlines(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    row = agents_admin.create_agent(
        {
            "agent_code": "nl-desc",
            "agent_name": "NL",
            "description": "Line1\nLine2",
            "skills": [],
        }
    )
    assert "Line1" in (row.get("description") or "")


def test_agent_update_syncs_employee_skills(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    agents_admin.create_agent(
        {"agent_code": "sync-a", "agent_name": "Sync", "skills": ["aihot"], "soul": "初始灵魂"}
    )
    hired = employees_admin.hire({"agent_code": "sync-a"})
    assert hired["config"]["skills"] == ["aihot"]
    assert hired.get("inherits_agent") is True
    agents_admin.update_agent("sync-a", {"skills": ["evoflow-admin"], "soul": "更新后灵魂"})
    got = employees_admin.get_role("sync-a")
    assert got["config"]["skills"] == ["evoflow-admin"]
    assert "更新后灵魂" in (got["config"].get("soul_md") or "")


def test_resume_rejects_archived(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    agents_admin.create_agent({"agent_code": "arch-a", "agent_name": "Arch", "skills": []})
    employees_admin.hire({"agent_code": "arch-a"})
    with patch.object(employees_admin, "_try_gateway_put", return_value=None):
        employees_admin.archive_role("arch-a")
    with pytest.raises(ValidationError, match="archived"):
        employees_admin.resume_role("arch-a")
