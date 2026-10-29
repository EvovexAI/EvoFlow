"""Employee / agent capability edits must hit live runtime without restart."""

from __future__ import annotations

from evoflow.config.agents_config import get_agent_kb_vault_ids


def test_get_agent_kb_vault_ids_extra_json_authoritative_including_empty(monkeypatch):
    """Removing vaults must stick: empty mirror list must not union AgentConfig leftovers."""

    def fake_extra(_code):
        return {"knowledge_vault_ids": []}

    class _Cfg:
        knowledge_vault_ids = ["kb_stale"]

    monkeypatch.setattr(
        "evoflow.persistence.config_repositories.get_agent_extra_json",
        fake_extra,
    )
    monkeypatch.setattr(
        "evoflow.config.agents_config.load_agent_config",
        lambda _code: _Cfg(),
    )
    assert get_agent_kb_vault_ids("duty_clerk") == []


def test_get_agent_kb_vault_ids_falls_back_when_mirror_absent(monkeypatch):
    def fake_extra(_code):
        return {"other": 1}

    class _Cfg:
        knowledge_vault_ids = ["kb_from_agent"]

    monkeypatch.setattr(
        "evoflow.persistence.config_repositories.get_agent_extra_json",
        fake_extra,
    )
    monkeypatch.setattr(
        "evoflow.config.agents_config.load_agent_config",
        lambda _code: _Cfg(),
    )
    assert get_agent_kb_vault_ids("duty_clerk") == ["kb_from_agent"]


def test_refresh_agent_runtime_invalidates_and_clears(monkeypatch):
    from evoflow.admin import agents as agents_admin

    calls: list[str] = []
    monkeypatch.setattr(
        agents_admin,
        "_refresh_sessions_tool_state_for_agent",
        lambda code: calls.append(f"sessions:{code}") or 0,
    )
    monkeypatch.setattr(
        "evoflow.config.agents_config.invalidate_agent_config_cache",
        lambda code=None: calls.append(f"invalidate:{code}"),
    )
    monkeypatch.setattr(
        "evoflow.agents.lead_agent.graph_cache.clear_lead_agent_graph_cache",
        lambda: calls.append("graph_clear"),
    )
    agents_admin.refresh_agent_runtime_after_capability_change("duty_clerk")
    assert "invalidate:duty_clerk" in calls
    assert "sessions:duty_clerk" in calls
    assert "graph_clear" in calls


def test_update_role_request_accepts_kb_injection():
    from evoflow.proactive.router import UpdateRoleRequest

    req = UpdateRoleRequest(
        knowledge_vault_ids=["kb_a"],
        kb_injection={"mode": "auto", "mount_platform_tools": True},
    )
    assert req.knowledge_vault_ids == ["kb_a"]
    assert req.kb_injection is not None
    assert req.kb_injection.get("mode") == "auto"


def test_refresh_agent_config_if_stale_detects_cross_process_edit(monkeypatch):
    """LangGraph worker must drop TTL caches when Gateway bumps evoflow_agents.updated_at."""
    from evoflow.config import agents_config as ac

    ac._agent_capability_rev.clear()
    ac._agent_config_cache.clear()
    calls: list[str] = []
    stamps = {"duty_clerk": "t1"}

    monkeypatch.setattr(
        ac,
        "probe_agent_capability_revision",
        lambda code: stamps.get(str(code or "").strip().lower(), ""),
    )
    monkeypatch.setattr(
        "evoflow.session_tool_binding.agent_tools.invalidate_agent_tool_names_cache",
        lambda code=None: calls.append(f"tools:{code}"),
    )
    monkeypatch.setattr(
        "evoflow.agents.lead_agent.graph_cache.clear_lead_agent_graph_cache",
        lambda: calls.append("graph_clear"),
    )

    assert ac.refresh_agent_config_if_stale("duty_clerk") == "t1"
    assert calls == []  # first sighting — just record stamp

    stamps["duty_clerk"] = "t2"
    assert ac.refresh_agent_config_if_stale("duty_clerk") == "t2"
    assert "tools:duty_clerk" in calls
    assert "graph_clear" in calls

    calls.clear()
    assert ac.refresh_agent_config_if_stale("duty_clerk") == "t2"
    assert calls == []  # unchanged stamp — no thrash


def test_lead_agent_graph_cache_key_includes_capability_fp():
    from evoflow.agents.lead_agent.graph_cache import LeadAgentGraphCacheKey

    base = dict(
        model_name="m",
        agent_name="duty_clerk",
        thinking_enabled=False,
        reasoning_effort=None,
        session_mode="agent",
        is_plan_mode=False,
        subagent_enabled=False,
        max_concurrent_subagents=1,
        include_search=True,
        use_virtual_paths=False,
        tools_mode=None,
        tool_whitelist=("bash",),
        mcp_servers_unrestricted=False,
        mcp_servers=(),
        skills=(),
        custom_system_prompt_hash="",
        summarization_enabled=False,
        token_usage_enabled=False,
        mission_state_middleware=False,
        is_bootstrap=False,
    )
    a = LeadAgentGraphCacheKey(**base, capability_fp="t1")
    b = LeadAgentGraphCacheKey(**base, capability_fp="t2")
    assert a.as_tuple() != b.as_tuple()
