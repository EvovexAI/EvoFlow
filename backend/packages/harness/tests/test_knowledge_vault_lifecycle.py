"""Lifecycle unit tests for Knowledge Vault MCP sessions (no live Node required)."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from evoflow.knowledge.vault import mcp_runtime as rt
from evoflow.knowledge.vault.constants import MCP_RESTART_MAX
from evoflow.knowledge.vault.models import AccessMode, KnowledgeVaultConfig


def _cfg(vid: str = "v1", path: str = "/tmp/vault") -> KnowledgeVaultConfig:
    return KnowledgeVaultConfig.model_validate(
        {
            "id": vid,
            "name": vid,
            "vaultPath": path,
            "enabled": True,
            "accessMode": AccessMode.read_only.value,
        }
    )


def test_ensure_session_reuses_singleton():
    cfg = _cfg()
    fake = rt.VaultMcpSession(vault_id="v1", search_tools={"t": object()}, search_error=None)
    fake.search_capabilities = MagicMock(search_tool="evo_kb_search", missing_required=[])

    async def _run():
        with patch.object(rt, "_SESSIONS", {"v1": fake}):
            a = await rt.ensure_session(cfg)
            b = await rt.ensure_session(cfg)
        return a, b

    a, b = asyncio.run(_run())
    assert a is fake
    assert b is fake


def test_two_vaults_isolated_sessions():
    s1 = rt.VaultMcpSession(vault_id="a", search_tools={"x": 1})
    s2 = rt.VaultMcpSession(vault_id="b", search_tools={"y": 2})
    with patch.object(rt, "_SESSIONS", {"a": s1, "b": s2}):
        assert rt.get_session("a") is s1
        assert rt.get_session("b") is s2
        assert rt.get_session("a").search_tools != rt.get_session("b").search_tools


def test_drop_session_clears_registry():
    s1 = rt.VaultMcpSession(vault_id="a", managed_pids=[999001])

    async def _run():
        with (
            patch.object(rt, "_SESSIONS", {"a": s1}),
            patch.object(rt, "_close_session_resources", new_callable=AsyncMock) as closer,
        ):
            await rt.drop_session("a")
            closer.assert_awaited()
            assert rt.get_session("a") is None

    asyncio.run(_run())


def test_restart_budget_not_infinite():
    assert MCP_RESTART_MAX == 3
    assert MCP_RESTART_MAX < 100


def test_start_with_backoff_stops_after_max():
    calls = {"n": 0}

    async def boom():
        calls["n"] += 1
        raise RuntimeError("fail")

    async def _run():
        with pytest.raises(Exception):
            await rt._start_with_backoff(label="test", starter=boom, restarts_so_far=0)

    asyncio.run(_run())
    assert calls["n"] == MCP_RESTART_MAX


def test_search_stdio_uses_openai_env_keys():
    cfg = KnowledgeVaultConfig.model_validate(
        {
            "id": "e",
            "name": "e",
            "vaultPath": "C:/vault",
            "enabled": True,
            "embeddingMode": "openai_compatible",
            "embeddingBaseUrl": "http://127.0.0.1:9/v1",
            "embeddingModel": "text-embedding-3-small",
        }
    )
    plan = MagicMock(kind="private", command="node", args=["server.js"], cwd="/r", message="ok")
    with (
        patch("evoflow.knowledge.vault.mcp_runtime.build_search_launch_plan", return_value=plan),
        patch("evoflow.knowledge.vault.mcp_runtime.vault_secrets.get_secret", return_value=""),
    ):
        params = rt.build_search_stdio_config(cfg)
    env = params["env"]
    assert env["OPENAI_BASE_URL"] == "http://127.0.0.1:9/v1"
    assert env["OPENAI_EMBEDDING_MODEL"] == "text-embedding-3-small"
    assert "OBSIDIAN_EMBEDDING_BASE_URL" not in env
    assert "PATH" in env or "Path" in env


def test_cleanup_orphans_kills_listed_pids(tmp_path, monkeypatch):
    monkeypatch.setenv("EVOFLOW_KB_RUNTIME_ROOT", str(tmp_path))
    with (
        patch.object(rt, "_read_pidfile", return_value={"v1": [12345]}),
        patch.object(rt, "_pid_alive", side_effect=lambda pid: pid == 12345),
        patch.object(rt, "_kill_pid") as killer,
        patch.object(rt, "_write_pidfile") as writer,
    ):
        out = rt.cleanup_orphaned_managed_processes()
    killer.assert_called()
    assert 12345 in out["killed"] or writer.called
