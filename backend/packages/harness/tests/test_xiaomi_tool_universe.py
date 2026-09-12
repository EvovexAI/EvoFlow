"""Xiaomi front-desk tool universe must survive session/duty allowlists."""

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
        import evoflow.config.agents_config as ac

        ac._builtin_agents_materialized = False
        yield Path(tmp)
        reset_db_for_tests()
        ac._builtin_agents_materialized = False
        gc.collect()


def test_xiaomi_tool_universe_not_empty_when_config_tools_empty(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    from evoflow.agents.xiaomi.tool_policy import XIAOMI_SYSTEM_TOOL_NAMES
    from evoflow.config.agents_config import ensure_builtin_agents_materialized
    from evoflow.session_tool_binding.agent_tools import (
        bound_tools_for_session_agent,
        resolve_agent_tool_names_for_agent,
    )
    from evoflow.persistence.session_repositories import upsert_session_row

    ensure_builtin_agents_materialized()

    names = resolve_agent_tool_names_for_agent("xiaomi")
    assert names == frozenset(XIAOMI_SYSTEM_TOOL_NAMES)
    assert "xiaomi_dispatch" in names
    assert "read" not in names

    sk = "proactive:xiaomi"
    upsert_session_row(sk, session_mode="agent", agent_id="xiaomi")
    bound = bound_tools_for_session_agent(sk, "agent")
    assert set(bound) == set(XIAOMI_SYSTEM_TOOL_NAMES)


def test_proactive_allowlist_includes_xiaomi_tools(sqlite_tmp: Path) -> None:
    del sqlite_tmp
    from evoflow.agents.middlewares.proactive_tool_middleware import (
        _mode_agent_full_catalog,
        patch_proactive_tools,
    )
    from evoflow.agents.xiaomi.tool_policy import XIAOMI_SYSTEM_TOOL_NAMES
    from evoflow.config.agents_config import ensure_builtin_agents_materialized
    from evoflow.persistence.session_repositories import upsert_session_row

    ensure_builtin_agents_materialized()
    sk = "proactive:xiaomi"
    upsert_session_row(sk, session_mode="agent", agent_id="xiaomi")

    allow = _mode_agent_full_catalog(sk, "agent")
    assert allow == set(XIAOMI_SYSTEM_TOOL_NAMES)

    class _T:
        def __init__(self, name: str) -> None:
            self.name = name

    tools = [_T(n) for n in sorted(XIAOMI_SYSTEM_TOOL_NAMES)] + [_T("read"), _T("terminal")]
    patched = patch_proactive_tools(tools, allow_names=allow)
    # Duty finalize always injects tasks (+ mind_map allow) even for 小V catalog
    patched_names = {t.name for t in patched}
    assert set(XIAOMI_SYSTEM_TOOL_NAMES).issubset(patched_names)
    assert "tasks" in patched_names
    assert "read" not in patched_names
    assert "terminal" not in patched_names
