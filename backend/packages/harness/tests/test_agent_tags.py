"""Tests for agent tags (schema v82+ + inference helpers)."""

from __future__ import annotations

import tempfile
from pathlib import Path

import pytest

from evoflow.config.agent_tags import infer_tags_for_agent, normalize_tags
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


def test_schema_v82_has_tags_json_no_team_table(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    conn = get_db()
    version = int(conn.execute("PRAGMA user_version").fetchone()[0])
    assert version >= 82

    cols = {str(r[1]) for r in conn.execute("PRAGMA table_info(evoflow_agents)").fetchall()}
    assert "tags_json" in cols
    assert "team_code" not in cols

    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='evoflow_agent_teams'"
    ).fetchone()
    assert row is None


def test_save_agent_infers_and_persists_tags(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    from evoflow.config.agents_config import save_agent_config
    from evoflow.persistence import config_repositories as cfg_repo

    save_agent_config(
        "media-screenwriter",
        {"agent_code": "media-screenwriter", "agent_type": "subagent", "description": "writer"},
    )
    doc = cfg_repo.get_agent_config("media-screenwriter")
    assert doc is not None
    assert doc.get("tags") == ["媒体"]

    save_agent_config(
        "project-planner",
        {"agent_code": "project-planner", "agent_type": "subagent", "description": "plan"},
    )
    plan_doc = cfg_repo.get_agent_config("project-planner")
    assert plan_doc is not None
    assert plan_doc.get("tags") == ["项目"]


def test_infer_tags_for_agent() -> None:
    assert infer_tags_for_agent(agent_code="main", agent_type="custom") == []
    assert infer_tags_for_agent(agent_code="xiaomi", agent_type="custom") == []
    assert infer_tags_for_agent(agent_code="media-artist", agent_type="subagent") == ["媒体"]
    assert infer_tags_for_agent(agent_code="project-implementer", agent_type="subagent") == ["项目"]
    assert infer_tags_for_agent(agent_code="finance-intake", agent_type="subagent") == ["财务"]
    assert infer_tags_for_agent(agent_code="general-purpose", agent_type="subagent") == ["核心", "代码"]
    assert infer_tags_for_agent(agent_code="knowledge-retriever", agent_type="subagent") == ["核心", "文档"]
    assert infer_tags_for_agent(agent_code="knowledge-curator", agent_type="subagent") == ["核心", "文档"]
    assert infer_tags_for_agent(agent_code="marketing-social-media-operation", agent_type="subagent") == [
        "营销",
        "社媒",
    ]
    assert infer_tags_for_agent(agent_code="my-bot", agent_type="custom") == ["自定义"]
    assert infer_tags_for_agent(agent_code="extra-worker", agent_type="subagent") == ["自定义"]


def test_normalize_tags() -> None:
    assert normalize_tags(None) == []
    assert normalize_tags(["核心", "核心", ""]) == ["核心"]
    assert normalize_tags(("代码", "核心")) == ["代码", "核心"]


def test_admin_list_agents_tag_filter(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    from evoflow.admin import agents as agents_admin
    from evoflow.persistence import config_repositories as cfg_repo

    cfg_repo.upsert_agent(
        "media-artist",
        {"agent_code": "media-artist", "agent_type": "subagent", "tags": ["媒体"]},
    )
    cfg_repo.upsert_agent(
        "project-implementer",
        {"agent_code": "project-implementer", "agent_type": "subagent", "tags": ["项目"]},
    )

    media_only = agents_admin.list_agents(tag="媒体")["agents"]
    codes = {a["agent_code"] for a in media_only}
    assert "media-artist" in codes
    assert "project-implementer" not in codes


def test_project_crew_materialized_with_project_tags(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    from evoflow.config.agents_config import ensure_builtin_agents_materialized
    from evoflow.persistence import config_repositories as cfg_repo

    ensure_builtin_agents_materialized()

    expected = (
        "project-architect",
        "project-planner",
        "project-implementer",
        "project-reviewer",
        "project-debugger",
        "project-qa",
    )
    for code in expected:
        assert cfg_repo.agent_exists(code), code
        doc = cfg_repo.get_agent_config(code)
        assert doc is not None
        assert doc.get("tags") == ["项目"]
        assert doc.get("agent_type") == "subagent"

    gp = cfg_repo.get_agent_config("general-purpose")
    assert gp is not None
    assert gp.get("tags") == ["核心", "代码"]
