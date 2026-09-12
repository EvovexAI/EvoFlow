"""Builtin avatar config backfill / upgrade for existing installs."""

from __future__ import annotations

from pathlib import Path

import pytest

from evoflow.config import agents_config as ac
from evoflow.persistence.db import reset_db_for_tests


@pytest.fixture
def agent_home(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("EVOFLOW_HOME", str(home))
    reset_db_for_tests()
    yield home
    reset_db_for_tests()


def test_should_upgrade_legacy_emoji_to_image() -> None:
    assert ac._should_upgrade_builtin_avatar(None, "image") is True
    assert ac._should_upgrade_builtin_avatar("", "image") is True
    assert ac._should_upgrade_builtin_avatar("emoji:🤖", "image") is True
    assert ac._should_upgrade_builtin_avatar("preset:mochi", "image") is True
    assert ac._should_upgrade_builtin_avatar("image", "image") is False
    assert ac._should_upgrade_builtin_avatar("https://cdn.example/a.png", "image") is False


def test_backfill_upgrades_emoji_when_builtin_default_is_image(agent_home: Path) -> None:
    from evoflow.config.agents_config import save_agent_config
    from evoflow.persistence import config_repositories as cfg_repo

    save_agent_config(
        "code-agent",
        {
            "agent_type": "subagent",
            "agent_name": "代码专家",
            "avatar": "emoji:💻",
        },
    )
    assert cfg_repo.agent_exists("code-agent")
    ac._backfill_missing_agent_avatars()
    cfg = ac.load_agent_config("code-agent")
    assert cfg.avatar == "image"
