"""Lead agent must reload chat models from SQLite (LangGraph process cache)."""

from __future__ import annotations

import tempfile
from pathlib import Path

import pytest

from evoflow.agents.lead_agent.agent import _resolve_model_name
from evoflow.config import get_app_config
from evoflow.persistence import config_repositories as cfg_repo
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


def test_resolve_model_name_reloads_when_in_memory_cache_empty(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    cfg_repo.replace_models(
        [
            {
                "name": "db-model",
                "use": "langchain_openai:ChatOpenAI",
                "model": "gpt-test",
                "api_key": "sk-test",
            }
        ]
    )
    cfg_repo.set_app_setting("primary_model", "db-model")

    stale = get_app_config()
    stale.models = []
    stale.primary_model = None

    assert _resolve_model_name() == "db-model"
    assert get_app_config().models
