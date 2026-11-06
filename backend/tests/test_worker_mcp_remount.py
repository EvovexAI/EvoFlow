"""Workflow workers must remount AgentConfig.mcp_servers even when tools[] has no mcp__*."""

from __future__ import annotations

from types import SimpleNamespace

import pytest


def test_resolve_worker_remounts_bound_mcp_from_catalog(monkeypatch: pytest.MonkeyPatch) -> None:
    from evoflow.collab import worker_tool_allowlist as wta

    catalog = {
        "read",
        "write",
        "bash",
        "done",
        "mcp__ecommerce-shangce__health",
        "mcp__ecommerce-shangce__list_projects",
        "mcp__ai-canvas-director__director_list_projects",
    }

    class _Cfg:
        tools = ["read", "write", "bash"]
        mcp_servers = ["ecommerce-shangce"]

    monkeypatch.setattr(wta, "_load_agent_tools_whitelist", lambda _code: list(_Cfg.tools))
    monkeypatch.setattr(
        "evoflow.config.agents_config.load_agent_config",
        lambda _code: _Cfg(),
    )

    out = wta.resolve_worker_tool_allowlist(
        assignee_agent_code="ecommerce-content-operator",
        base_subagent="ecommerce-content-operator",
        subagent_config_tools=list(_Cfg.tools),
        catalog_names=catalog,
    )

    assert "mcp__ecommerce-shangce__health" in out
    assert "mcp__ecommerce-shangce__list_projects" in out
    assert "mcp__ai-canvas-director__director_list_projects" not in out


def test_with_agent_mcp_heals_from_warm_peek_when_catalog_empty(monkeypatch: pytest.MonkeyPatch) -> None:
    from evoflow.collab import worker_tool_allowlist as wta

    class _Cfg:
        tools = ["read", "bash"]
        mcp_servers = ["ecommerce-shangce"]

    monkeypatch.setattr(
        "evoflow.config.agents_config.load_agent_config",
        lambda _code: _Cfg(),
    )
    monkeypatch.setattr(
        "evoflow.mcp.cache.peek_cached_mcp_tools",
        lambda: [
            SimpleNamespace(name="mcp__ecommerce-shangce__health"),
            SimpleNamespace(name="mcp__ai-canvas-director__x"),
        ],
    )

    out = wta._with_agent_mcp_tools(
        ["read", "bash"],
        agent_code="ecommerce-content-operator",
        catalog_names={"read", "bash", "done"},
    )
    assert "mcp__ecommerce-shangce__health" in out
    assert "mcp__ai-canvas-director__x" not in out


def test_partition_tool_names_allows_mcp_by_server_config(monkeypatch: pytest.MonkeyPatch) -> None:
    from evoflow.config import agent_resource_validation as arv

    monkeypatch.setattr(arv, "assignable_tool_names", lambda model_name=None: {"read", "bash"})
    monkeypatch.setattr(
        arv,
        "_mcp_tool_allowed_by_server_config",
        lambda name: name.startswith("mcp__ecommerce-shangce__"),
    )

    known, unknown = arv.partition_tool_names(
        ["read", "mcp__ecommerce-shangce__health", "mcp__nope__x", "ghost"]
    )
    assert known == ["read", "mcp__ecommerce-shangce__health"]
    assert unknown == ["mcp__nope__x", "ghost"]


def test_merge_cached_mcp_tools_into_catalog_appends_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    from evoflow.tools import tools as tools_mod

    monkeypatch.setattr(
        tools_mod,
        "_resolve_mcp_tools_for_catalog",
        lambda: [SimpleNamespace(name="mcp__ecommerce-shangce__health")],
    )
    monkeypatch.setattr(tools_mod._cached_resolve_tools, "cache_clear", lambda: None)

    base = [SimpleNamespace(name="read"), SimpleNamespace(name="bash")]
    merged = tools_mod.merge_cached_mcp_tools_into_catalog(base)
    names = [str(getattr(t, "name", "")) for t in merged]
    assert "read" in names
    assert "mcp__ecommerce-shangce__health" in names
