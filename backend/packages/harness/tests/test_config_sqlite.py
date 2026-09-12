"""Config tables in evoflow.db (agents, models, channels)."""

from __future__ import annotations

import tempfile
from pathlib import Path

import pytest

from evoflow.config.agents_config import load_agent_config, save_agent_config
from evoflow.persistence.bootstrap import seed_config_from_app_yaml
from evoflow.persistence.config_repositories import config_tables_seeded, list_models
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


def test_seed_does_not_import_models_from_yaml(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    seed_config_from_app_yaml(
        {
            "models": [{"name": "test-model", "use": "x", "model": "m"}],
            "tools": [{"name": "read_file", "group": "core", "use": "y"}],
            "channels": {"feishu": {"app_id": "cli_test"}},
        }
    )
    assert config_tables_seeded()
    assert list_models() == []


def test_config_tables_seeded_when_only_mcp_present(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    from evoflow.persistence import config_repositories as cfg_repo

    cfg_repo.replace_mcp_servers(
        {
            "github": {
                "enabled": True,
                "type": "stdio",
                "command": "npx",
                "args": [],
            }
        }
    )
    assert config_tables_seeded()
    seed_config_from_app_yaml({"tools": [{"name": "read_file", "group": "core", "use": "y"}]})
    assert cfg_repo.list_tools() == []


def test_apply_config_ignores_yaml_models_when_db_empty(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    from evoflow.persistence.bootstrap import apply_config_from_db

    out = apply_config_from_db(
        {
            "models": [
                {
                    "name": "yaml-only",
                    "use": "langchain_openai:ChatOpenAI",
                    "model": "gpt-yaml",
                }
            ],
            "primary_model": "yaml-only",
        }
    )
    assert out["models"] == []
    assert list_models() == []


def test_apply_config_defaults_tools_mode_host_direct(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    from evoflow.persistence import config_repositories as cfg_repo
    from evoflow.persistence.bootstrap import apply_config_from_db

    out = apply_config_from_db({})
    assert out["tools_mode"] == "host_direct"

    cfg_repo.set_app_setting("tools_mode", "sandbox")
    out2 = apply_config_from_db({})
    assert out2["tools_mode"] == "sandbox"


def test_apply_config_runtime_sections_from_app_settings(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    from evoflow.persistence import config_repositories as cfg_repo
    from evoflow.persistence.bootstrap import apply_config_from_db

    cfg_repo.set_app_setting("runtime.token_usage", {"enabled": False})
    cfg_repo.set_app_setting("runtime.paths", {"base_dir": "/data/evoflow"})
    cfg_repo.set_app_setting("channels.global", {"langgraph_url": "http://lg:2024"})
    cfg_repo.upsert_channel_config("feishu", {"enabled": True, "app_id": "cli_x"})

    out = apply_config_from_db(
        {
            "token_usage": {"enabled": True},
            "paths": {"base_dir": "/yaml/ignored"},
            "channels": {"gateway_url": "http://ignored:8001", "feishu": {"enabled": False}},
        }
    )
    assert out["token_usage"] == {"enabled": False}
    assert out["paths"] == {"base_dir": "/data/evoflow"}
    assert out["channels"]["langgraph_url"] == "http://lg:2024"
    assert out["channels"]["feishu"]["app_id"] == "cli_x"


def test_persist_paths_section_writes_app_settings(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    from evoflow.persistence import config_repositories as cfg_repo
    from evoflow.persistence.runtime_settings import persist_paths_section

    persist_paths_section({"base_dir": "D:/workspace/evoflow-data"})
    stored = cfg_repo.get_app_setting("runtime.paths")
    assert stored == {"base_dir": "D:/workspace/evoflow-data"}


def test_seed_models_providers_nested_yaml(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    from evoflow.persistence.bootstrap import sync_models_from_yaml_to_db

    sync_models_from_yaml_to_db(
        {
            "primary_model": "kimi-k2.5",
            "models": {
                "providers": {
                    "openai": {
                        "vendor": "openai",
                        "use": "langchain_openai:ChatOpenAI",
                        "base_url": "http://example/v1",
                        "api_key": "sk-test",
                        "models": [{"name": "kimi-k2.5", "model": "kimi-k2.5"}],
                    }
                }
            },
        }
    )
    names = [m.get("name") for m in list_models()]
    assert "kimi-k2.5" in names


def test_apply_config_uses_db_not_yaml(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    from evoflow.persistence import config_repositories as cfg_repo
    from evoflow.persistence.bootstrap import apply_config_from_db

    cfg_repo.replace_models(
        [
            {
                "name": "db-only",
                "use": "langchain_openai:ChatOpenAI",
                "model": "gpt-db",
                "api_key": "sk-db",
            }
        ]
    )
    out = apply_config_from_db(
        {
            "models": [
                {
                    "name": "yaml-stale",
                    "use": "langchain_openai:ChatOpenAI",
                    "model": "gpt-yaml",
                }
            ],
            "primary_model": "yaml-stale",
        }
    )
    assert out["models"]
    assert out["models"][0]["name"] == "db-only"


def test_agent_sqlite_roundtrip(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    save_agent_config(
        "demo-agent",
        {
            "agent_type": "custom",
            "description": "hi",
            "tools": ["read_file", "write_file"],
            "mcp_servers": ["filesystem"],
            "env": {"FOO": "bar"},
        },
    )
    cfg = load_agent_config("demo-agent")
    assert cfg is not None
    assert cfg.agent_code == "demo-agent"
    assert cfg.tools == ["read_file", "write_file"]
    assert cfg.mcp_servers == ["filesystem"]
    assert cfg.env == {"FOO": "bar"}


def test_merge_baseline_skills_into_existing_main(sqlite_tmp: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    del sqlite_tmp
    save_agent_config(
        "main",
        {
            "agent_type": "custom",
            "agent_name": "EvoFlow",
            "skills": ["deep-research", "preset-role-assistant"],
        },
    )

    class _Skill:
        def __init__(self, name: str) -> None:
            self.name = name

    monkeypatch.setattr(
        "evoflow.config.agents_config.load_skills",
        lambda enabled_only=True: [_Skill("evoflow-intro"), _Skill("deep-research"), _Skill("preset-role-assistant")],
    )

    from evoflow.config.agents_config import merge_baseline_skills_into_agent

    merge_baseline_skills_into_agent("main")
    cfg = load_agent_config("main")
    assert cfg is not None
    assert cfg.skills is not None
    assert cfg.skills[0] == "evoflow-intro"
    assert "deep-research" in cfg.skills
    assert "preset-role-assistant" in cfg.skills

    merge_baseline_skills_into_agent("main")
    cfg2 = load_agent_config("main")
    assert cfg2 is not None
    assert cfg2.skills == cfg.skills
