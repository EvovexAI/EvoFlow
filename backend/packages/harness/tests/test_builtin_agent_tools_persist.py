"""Builtin agent materialize must not wipe user-edited tool whitelists."""

from __future__ import annotations

import gc
import tempfile
from pathlib import Path

import pytest

_EVOFLOW_ROOT = Path(__file__).resolve().parents[4]


@pytest.fixture
def sqlite_tmp(monkeypatch: pytest.MonkeyPatch):
    with tempfile.TemporaryDirectory() as tmp:
        monkeypatch.setenv("EVOFLOW_HOME", tmp)
        monkeypatch.setenv("EVOFLOW_CONFIG_PATH", str(_EVOFLOW_ROOT / "config.yaml"))
        from evoflow.persistence.db import get_db, reset_db_for_tests

        reset_db_for_tests()
        get_db()
        # Allow materialize to run again in this process.
        import evoflow.config.agents_config as ac

        ac._builtin_agents_materialized = False
        yield Path(tmp)
        reset_db_for_tests()
        ac._builtin_agents_materialized = False
        gc.collect()


def test_code_agent_user_tools_survive_rematerialize(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    from evoflow.config.agents_config import (
        ensure_builtin_agents_materialized,
        load_agent_config,
        save_agent_config,
    )
    import evoflow.config.agents_config as ac

    ensure_builtin_agents_materialized()
    cfg = load_agent_config("code-agent")
    assert cfg is not None

    custom_tools = ["read", "rg", "terminal", "write"]
    full = cfg.model_dump(mode="python", exclude_none=False)
    full["tools"] = list(custom_tools)
    save_agent_config("code-agent", full)

    saved = load_agent_config("code-agent")
    assert saved is not None
    assert list(saved.tools or []) == custom_tools

    # Simulate Gateway restart: process flag resets, materialize runs again.
    ac._builtin_agents_materialized = False
    ensure_builtin_agents_materialized()

    after = load_agent_config("code-agent")
    assert after is not None
    assert list(after.tools or []) == custom_tools
