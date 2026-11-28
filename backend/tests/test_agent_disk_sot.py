"""Agent system_prompt / tools: disk SoT (system.md + capabilities.json) over SQLite."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from evoflow.assets import paths as assets_paths
from evoflow.assets.paths import EntityRef, profile_path
from evoflow.config.agents_config import (
    invalidate_agent_config_cache,
    load_agent_config,
    save_agent_config,
)
from evoflow.persistence import config_repositories as cfg_repo


@pytest.fixture()
def agent_code(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    code = "disk-sot-bot"
    monkeypatch.setattr(assets_paths, "assets_root", lambda: tmp_path)
    save_agent_config(
        code,
        {
            "agent_code": code,
            "agent_name": "磁盘权威测试",
            "agent_type": "custom",
            "system_prompt": "FROM_DB_PROMPT",
            "tools": ["bash", "read"],
            "mcp_servers": [],
            "skills": ["skill-a"],
        },
    )
    invalidate_agent_config_cache(code)
    yield code
    try:
        cfg_repo.delete_agent(code)
    except Exception:
        pass
    invalidate_agent_config_cache(code)


def test_system_md_wins_over_db(agent_code: str):
    path = profile_path(EntityRef("agent", agent_code), "system.md")
    assert path.is_file()
    path.write_text("FROM_DISK_PROMPT\n", encoding="utf-8")
    invalidate_agent_config_cache(agent_code)
    cfg = load_agent_config(agent_code)
    assert cfg is not None
    assert str(cfg.system_prompt or "").strip() == "FROM_DISK_PROMPT"


def test_capabilities_json_wins_over_db(agent_code: str):
    path = profile_path(EntityRef("agent", agent_code), "capabilities.json")
    assert path.is_file()
    path.write_text(
        json.dumps(
            {
                "tools": ["write"],
                "mcp_servers": ["demo-mcp"],
                "skills": [],
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    invalidate_agent_config_cache(agent_code)
    cfg = load_agent_config(agent_code)
    assert cfg is not None
    assert cfg.tools == ["write"]
    assert cfg.mcp_servers == ["demo-mcp"]
    assert cfg.skills == []


def test_save_agent_config_writes_disk_files(agent_code: str):
    save_agent_config(
        agent_code,
        {
            "agent_code": agent_code,
            "system_prompt": "SAVED_PROMPT",
            "tools": ["bash"],
            "skills": ["s1"],
        },
    )
    sp = profile_path(EntityRef("agent", agent_code), "system.md")
    caps = profile_path(EntityRef("agent", agent_code), "capabilities.json")
    assert sp.read_text(encoding="utf-8") == "SAVED_PROMPT"
    data = json.loads(caps.read_text(encoding="utf-8"))
    assert data.get("tools") == ["bash"]
    assert data.get("skills") == ["s1"]
