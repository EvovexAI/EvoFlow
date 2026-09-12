"""Tests for agent tag tools (list_agents tags=, create_agent tags=)."""

from __future__ import annotations

import asyncio
import json
import tempfile
from pathlib import Path
from types import SimpleNamespace

import pytest

from evoflow.persistence.db import reset_db_for_tests


@pytest.fixture
def sqlite_tmp(monkeypatch: pytest.MonkeyPatch):
    with tempfile.TemporaryDirectory() as tmp:
        monkeypatch.setenv("EVOFLOW_HOME", tmp)
        reset_db_for_tests()
        yield Path(tmp)
        reset_db_for_tests()
        import gc

        gc.collect()


def _mock_runtime():
    return SimpleNamespace(context=SimpleNamespace(configurable={}))


def test_list_agents_tool_filters_by_tags(sqlite_tmp) -> None:
    del sqlite_tmp
    from evoflow.persistence import config_repositories as cfg_repo
    from evoflow.tools.builtins.list_agents_tool import list_agents_tool

    cfg_repo.upsert_agent(
        "tagged-bot",
        {"agent_code": "tagged-bot", "agent_type": "custom", "tags": ["核心", "代码"]},
    )

    async def _run():
        return await list_agents_tool.coroutine(runtime=_mock_runtime(), tool_call_id="tc-1", tags=["核心"])

    raw = asyncio.run(_run())
    payload = json.loads(raw) if isinstance(raw, str) else raw
    assert "error" not in payload
    codes = {a["agent_code"] for a in payload["agents"]}
    assert "tagged-bot" in codes


def test_create_agent_tool_sets_tags(sqlite_tmp) -> None:
    del sqlite_tmp
    from evoflow.persistence import config_repositories as cfg_repo
    from evoflow.tools.builtins.create_agent_tool import create_agent_tool

    async def _run():
        return await create_agent_tool.coroutine(
            runtime=_mock_runtime(),
            tool_call_id="tc-2",
            agent_code="my-tagged-bot",
            agent_type="custom",
            description="test",
            tags=["项目", "代码"],
        )

    raw = asyncio.run(_run())
    payload = json.loads(raw) if isinstance(raw, str) else raw
    assert payload.get("success") is True
    doc = cfg_repo.get_agent_config("my-tagged-bot")
    assert doc is not None
    assert doc.get("tags") == ["项目", "代码"]


def test_create_agent_tool_assigns_random_avatar(sqlite_tmp) -> None:
    del sqlite_tmp
    from evoflow.persistence import config_repositories as cfg_repo
    from evoflow.tools.builtins.create_agent_tool import create_agent_tool

    async def _run():
        return await create_agent_tool.coroutine(
            runtime=_mock_runtime(),
            tool_call_id="tc-avatar",
            agent_code="random-avatar-bot",
            agent_type="custom",
            description="test",
        )

    raw = asyncio.run(_run())
    payload = json.loads(raw) if isinstance(raw, str) else raw
    assert payload.get("success") is True
    doc = cfg_repo.get_agent_config("random-avatar-bot")
    assert doc is not None
    assert str(doc.get("avatar") or "").startswith("preset:")
