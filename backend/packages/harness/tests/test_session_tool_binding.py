"""Tests for per-session / per-mode tool binding persistence."""

from __future__ import annotations

import gc
import tempfile
from pathlib import Path

import pytest

from evoflow.agents.lead_agent.intent_tool_profile import (
    SESSION_MODE_BOUND_TOOLS,
    bound_tools_for_session_mode,
)
from evoflow.persistence.db import get_db, reset_db_for_tests
from evoflow.persistence.session_repositories import upsert_session_row
from evoflow.persistence.session_tool_binding_repositories import (
    get_chat_session_tool_snapshot,
    get_loaded_deferred_for_scenario,
    list_full_scenario_bindings_for_session,
    list_scenario_bindings_for_session,
)
from evoflow.session_tool_binding.service import (
    build_session_tool_binding_view,
    on_scenario_tool_success,
    persist_tool_search_loaded,
    primary_scenario_key,
    repair_session_tool_state,
    resolve_current_binding_mode,
    resolve_persisted_binding_mode,
    seed_session_tool_bindings,
    sync_loaded_deferred_state,
)

_EVOFLOW_ROOT = Path(__file__).resolve().parents[4]


@pytest.fixture
def sqlite_tmp(monkeypatch: pytest.MonkeyPatch):
    with tempfile.TemporaryDirectory() as tmp:
        monkeypatch.setenv("EVOFLOW_HOME", tmp)
        monkeypatch.setenv("EVOFLOW_CONFIG_PATH", str(_EVOFLOW_ROOT / "config.yaml"))
        reset_db_for_tests()
        get_db()
        yield tmp
        reset_db_for_tests()
        gc.collect()


def _seed_session(session_key: str, *, session_mode: str = "ask") -> None:
    upsert_session_row(session_key, session_mode=session_mode)


def test_schema_creates_binding_tables(sqlite_tmp: str) -> None:
    del sqlite_tmp
    # New design: single append-only trajectory table (legacy two-table design dropped).
    row = get_db().execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='evoflow_session_scenario_trajectory'"
    ).fetchone()
    assert row is not None
    col = get_db().execute(
        "SELECT 1 FROM pragma_table_info('evoflow_chat_sessions') WHERE name='active_tools_json'"
    ).fetchone()
    assert col is not None
    # Legacy tables must be gone.
    for legacy in (
        "evoflow_session_scenario_tool_bindings",
        "evoflow_session_tool_state",
        "evoflow_session_binding_events",
    ):
        gone = get_db().execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name=?", (legacy,)
        ).fetchone()
        assert gone is None


def test_new_session_seeds_all_mode_tool_rows(sqlite_tmp: str) -> None:
    del sqlite_tmp
    session_key = "agent:main:sess-new"
    _seed_session(session_key, session_mode="ask")
    from evoflow.session_tool_binding.agent_tools import bound_tools_for_session_agent

    # New design: only the current scenario gets a session_init trajectory row
    # (no three-mode pre-seed). The ask mode row must carry the ask eager tools.
    catalog = list_full_scenario_bindings_for_session(session_key)
    assert "ask" in catalog
    assert catalog["ask"]["eager_tools"] == bound_tools_for_session_agent(session_key, "ask")
    state = get_chat_session_tool_snapshot(session_key)
    assert state is not None
    assert state["current_mode"] == "ask"
    assert state["bound_tools"] == bound_tools_for_session_agent(session_key, "ask")


def test_seed_tool_state_not_left_on_last_catalog_mode(sqlite_tmp: str) -> None:
    del sqlite_tmp
    session_key = "agent:main:sess-seed-order"
    upsert_session_row(session_key, session_mode="ask")
    seed_session_tool_bindings(session_key)
    state = get_chat_session_tool_snapshot(session_key)
    assert state is not None
    assert state["current_mode"] != "plan"
    assert state["current_mode"] == "ask"


def test_persisted_mode_prefers_activated_scenarios_over_auto(sqlite_tmp: str) -> None:
    del sqlite_tmp
    session_key = "sess-auto-agent"
    upsert_session_row(session_key, session_mode="auto", activated_scenarios=["agent"])
    assert resolve_persisted_binding_mode(session_key) == "agent"
    repair_session_tool_state(session_key)
    state = get_chat_session_tool_snapshot(session_key)
    assert state is not None
    assert state["current_mode"] == "agent"
    assert "read" in state["bound_tools"]


def test_resolve_current_binding_mode_defaults_to_ask(sqlite_tmp: str) -> None:
    del sqlite_tmp
    _seed_session("sess-ask", session_mode="ask")
    assert resolve_current_binding_mode("sess-ask", []) == "ask"
    _seed_session("sess-agent", session_mode="agent")
    assert resolve_current_binding_mode("sess-agent", []) == "agent"
    assert resolve_current_binding_mode("sess-agent", ["plan"]) == "plan"


def test_primary_scenario_key_defaults_to_ask_without_session() -> None:
    assert primary_scenario_key([]) == "ask"


def test_persist_and_restore_agent_deferred(sqlite_tmp: str) -> None:
    del sqlite_tmp
    session_key = "sess-bind-1"
    _seed_session(session_key, session_mode="agent")

    saved = persist_tool_search_loaded(
        session_key=session_key,
        active_scenarios=["agent"],
        loaded_names=["worker", "process"],
    )
    assert "worker" in saved
    assert get_loaded_deferred_for_scenario(session_key, "agent") == saved


def test_mode_switch_restores_previous_agent_bindings(sqlite_tmp: str) -> None:
    del sqlite_tmp
    session_key = "sess-bind-2"
    _seed_session(session_key, session_mode="agent")

    persist_tool_search_loaded(
        session_key=session_key,
        active_scenarios=["agent"],
        loaded_names=["worker"],
    )

    restored_ask = on_scenario_tool_success(
        session_key=session_key,
        current_loaded=["worker"],
        payload={
            "status": "success",
            "action": "activate",
            "scenario_key": "ask",
            "previous_scenarios": ["agent"],
            "all_active_scenarios": [],
        },
    )
    assert restored_ask == []
    assert get_loaded_deferred_for_scenario(session_key, "agent") == ["worker"]

    restored_agent = on_scenario_tool_success(
        session_key=session_key,
        current_loaded=[],
        payload={
            "status": "success",
            "action": "activate",
            "scenario_key": "agent",
            "previous_scenarios": [],
            "all_active_scenarios": ["agent"],
        },
    )
    assert restored_agent == ["worker"]


def test_sync_loaded_deferred_state_restores_from_db(sqlite_tmp: str) -> None:
    del sqlite_tmp
    session_key = "sess-bind-4"
    _seed_session(session_key, session_mode="agent")

    persist_tool_search_loaded(
        session_key=session_key,
        active_scenarios=["agent"],
        loaded_names=["worker"],
    )
    aligned = sync_loaded_deferred_state(
        session_key=session_key,
        active_scenarios=["agent"],
        state_loaded=[],
    )
    assert aligned == ["worker"]
    # New design: append-only trajectory, only scenarios with at least one row
    # appear. Here only "agent" has a row (ask was never seeded for this session).
    bindings = list_full_scenario_bindings_for_session(session_key)
    assert "agent" in bindings
    assert bindings["agent"]["loaded_deferred"] == ["worker"]


def test_build_session_tool_binding_view(sqlite_tmp: str) -> None:
    del sqlite_tmp
    session_key = "sess-bind-5"
    _seed_session(session_key, session_mode="agent")

    persist_tool_search_loaded(
        session_key=session_key,
        active_scenarios=["agent"],
        loaded_names=["worker"],
    )
    view = build_session_tool_binding_view(session_key=session_key, active_scenarios=["agent"])
    assert view["current_mode"] == "agent"
    assert view["session_mode"] == "agent"
    assert "worker" in view["loaded_deferred"]
    assert "worker" in view["effective_bound_tools"]
    assert "worker" in view["effective_tools"]
    assert "worker" not in view["pending_activation"]
    assert "worker" not in view["unbound_tools"]
    assert "process" in view["pending_activation"]
    assert view["pending_activation"] == view["unbound_tools"]
    assert view["bindings_by_mode"]["agent"]["loaded_deferred"] == ["worker"]
    # New design: append-only trajectory, only scenarios with rows appear.
    # This session only has an "agent" row.
    assert "agent" in view["bindings_by_mode"]
    assert view["bindings_by_mode"]["agent"]["loaded_deferred"] == ["worker"]
    assert list_scenario_bindings_for_session(session_key)["agent"] == ["worker"]
    state = get_chat_session_tool_snapshot(session_key)
    assert state is not None
    assert state["current_mode"] == "agent"
    assert "worker" in state["loaded_deferred"]
    assert "process" in state["pending_activation"]


def test_session_mode_bound_tools_match_enums() -> None:
    from evoflow.agents.lead_agent.intent_tool_profile import SESSION_MODE_DEFERRED_CATALOG

    assert SESSION_MODE_BOUND_TOOLS["ask"] == bound_tools_for_session_mode("ask")
    assert "read" in SESSION_MODE_BOUND_TOOLS["agent"]
    assert "plan" in SESSION_MODE_BOUND_TOOLS["plan"]
    assert "subagent" in SESSION_MODE_BOUND_TOOLS["plan"]
    assert "read" in SESSION_MODE_BOUND_TOOLS["plan"]
    assert "collab_peer_read" in SESSION_MODE_BOUND_TOOLS["plan"]
    assert "ask_clarification" not in SESSION_MODE_BOUND_TOOLS["ask"]
    assert "ask_clarification" in SESSION_MODE_DEFERRED_CATALOG["ask"]
    assert "ask_clarification" in SESSION_MODE_DEFERRED_CATALOG["agent"]
    assert "ask_clarification" in SESSION_MODE_DEFERRED_CATALOG["plan"]
    assert "terminal" in SESSION_MODE_BOUND_TOOLS["agent"]
    assert "terminal" not in SESSION_MODE_DEFERRED_CATALOG["agent"]
    assert "propose_goal" not in SESSION_MODE_BOUND_TOOLS["plan"]
    assert "invoke_acp_agent" in SESSION_MODE_DEFERRED_CATALOG["agent"]
    assert "session_workspace" in SESSION_MODE_DEFERRED_CATALOG["agent"]
    assert "panel_set" in SESSION_MODE_BOUND_TOOLS["agent"]
    assert "platform" in SESSION_MODE_BOUND_TOOLS["agent"]
    assert "panel_set" not in SESSION_MODE_DEFERRED_CATALOG["agent"]
    assert "platform" not in SESSION_MODE_DEFERRED_CATALOG["agent"]
    assert "knowledge" in SESSION_MODE_DEFERRED_CATALOG["ask"]
    assert "knowledge" in SESSION_MODE_DEFERRED_CATALOG["agent"]
    assert "knowledge" in SESSION_MODE_DEFERRED_CATALOG["plan"]
    assert "search_knowledge_base" not in SESSION_MODE_DEFERRED_CATALOG["agent"]
    assert "search_knowledge_base" not in SESSION_MODE_DEFERRED_CATALOG["ask"]
    assert "search_knowledge_base" not in SESSION_MODE_DEFERRED_CATALOG["plan"]


def test_bound_tools_respect_agent_tool_whitelist(monkeypatch: pytest.MonkeyPatch, sqlite_tmp: str) -> None:
    del sqlite_tmp
    session_key = "agent:main:sess-agent-filter"
    upsert_session_row(session_key, session_mode="agent", agent_id="main")

    def _limited(_sk: str) -> frozenset[str]:
        return frozenset(
            {
                "tool_search",
                "mode_set",
                "ask_clarification",
                "read",
                "process",
                "terminal",
            }
        )

    monkeypatch.setattr(
        "evoflow.session_tool_binding.agent_tools.resolve_agent_tool_names_for_session",
        _limited,
    )
    repair_session_tool_state(session_key)
    view = build_session_tool_binding_view(session_key=session_key, active_scenarios=["agent"])
    assert "read" in view["bound_tools"]
    assert "web_search" not in view["bound_tools"]
    assert "process" in view["pending_activation"]
    assert "web_search" not in view["pending_activation"]
    assert view["agent_id"] == "main"


def test_bound_tools_keep_session_spine_without_whitelist(monkeypatch: pytest.MonkeyPatch, sqlite_tmp: str) -> None:
    del sqlite_tmp
    from evoflow.session_tool_binding.agent_tools import bound_tools_for_session_agent

    session_key = "agent:main:sess-spine-only"
    upsert_session_row(session_key, session_mode="ask", agent_id="main")

    # Universe must already include tool_search if it should appear in bound lists.
    monkeypatch.setattr(
        "evoflow.session_tool_binding.agent_tools.resolve_agent_tool_names_for_session",
        lambda _sk: frozenset({"read", "tool_search"}),
    )
    bound = bound_tools_for_session_agent(session_key, "ask")
    assert "tool_search" in bound
    assert "mode_set" not in bound
    assert "ask_clarification" not in bound
    from evoflow.session_tool_binding.agent_tools import deferred_catalog_for_session_agent

    deferred = deferred_catalog_for_session_agent(session_key, "ask")
    assert "ask_clarification" not in deferred
    assert "read" not in bound


def test_context_agent_id_overrides_session_key_for_deferred_tools(
    monkeypatch: pytest.MonkeyPatch, sqlite_tmp: str
) -> None:
    """In-session role switch must gate deferred tools by context agent_id, not agent:main:…."""
    del sqlite_tmp
    from evoflow.config.agents_config import AgentConfig
    from evoflow.persistence.session_context_fields import flat_fields_from_context
    from evoflow.session_tool_binding.agent_tools import (
        invalidate_agent_tool_names_cache,
        pending_activation_for_session_agent,
        resolve_session_agent_id,
    )

    flat = flat_fields_from_context(
        {"agent_id": "media-short-video-copy"},
        session_key="agent:main:sess-role-switch",
    )
    assert flat["agent_id"] == "media-short-video-copy"

    session_key = "agent:main:sess-role-switch"
    upsert_session_row(
        session_key,
        context={"agent_id": "media-short-video-copy", "session_mode": "agent"},
    )
    assert resolve_session_agent_id(session_key) == "media-short-video-copy"

    cfg = AgentConfig(
        agent_code="media-short-video-copy",
        tools=["read", "rg", "find", "todo", "web_search", "fetch_url"],
    )
    monkeypatch.setattr(
        "evoflow.session_tool_binding.agent_tools.load_agent_config",
        lambda _code: cfg,
    )
    invalidate_agent_tool_names_cache()
    repair_session_tool_state(session_key)
    pending = pending_activation_for_session_agent(session_key, "agent", loaded_deferred=[])
    assert "web_search" in pending
    assert "find" in pending
    assert "browser" not in pending
    assert "invoke_acp_agent" not in pending
    assert "panel_set" not in pending
    assert "ask_clarification" not in pending


def test_disallowed_ask_clarification_not_in_deferred(
    monkeypatch: pytest.MonkeyPatch, sqlite_tmp: str
) -> None:
    """Agents that ban ask_clarification must not see it in deferred lists."""
    del sqlite_tmp
    from evoflow.config.agents_config import AgentConfig
    from evoflow.session_tool_binding.agent_tools import (
        invalidate_agent_tool_names_cache,
        pending_activation_for_session_agent,
    )

    session_key = "agent:main:sess-no-clarify"
    upsert_session_row(
        session_key,
        context={"agent_id": "marketing-social-media-operation", "session_mode": "agent"},
    )
    cfg = AgentConfig(
        agent_code="marketing-social-media-operation",
        tools=["read_file", "terminal"],
        disallowed_tools=["ask_clarification", "tool_search", "plan", "supervisor"],
    )
    monkeypatch.setattr(
        "evoflow.session_tool_binding.agent_tools.load_agent_config",
        lambda _code: cfg,
    )
    invalidate_agent_tool_names_cache()
    repair_session_tool_state(session_key)
    pending = pending_activation_for_session_agent(session_key, "agent", loaded_deferred=[])
    assert "ask_clarification" not in pending
    assert "tool_search" not in pending


def test_legacy_read_file_whitelist_maps_to_read(
    monkeypatch: pytest.MonkeyPatch, sqlite_tmp: str
) -> None:
    """Agent configs with legacy read_file must still bind host-direct ``read``."""
    del sqlite_tmp
    from evoflow.config.agents_config import AgentConfig
    from evoflow.session_tool_binding.agent_tools import (
        bound_tools_for_session_agent,
        invalidate_agent_tool_names_cache,
        resolve_agent_tool_names_for_session,
    )

    session_key = "agent:main:sess-read-alias"
    upsert_session_row(
        session_key,
        context={"agent_id": "marketing-social-media-operation", "session_mode": "agent"},
    )
    cfg = AgentConfig(
        agent_code="marketing-social-media-operation",
        tools=["read_file", "terminal"],
        disallowed_tools=["ask_clarification", "tool_search"],
    )
    monkeypatch.setattr(
        "evoflow.session_tool_binding.agent_tools.load_agent_config",
        lambda _code: cfg,
    )
    invalidate_agent_tool_names_cache()
    universe = resolve_agent_tool_names_for_session(session_key)
    assert "read" in universe
    assert "terminal" in universe
    assert "read_file" not in universe
    bound = bound_tools_for_session_agent(session_key, "agent")
    assert "read" in bound
    assert "terminal" in bound
    assert bound != ["terminal"]


def test_role_switch_persists_agent_id_and_rewrites_tool_columns(
    monkeypatch: pytest.MonkeyPatch, sqlite_tmp: str
) -> None:
    """In-session switch must write flat agent_id and narrow active/pending tools."""
    del sqlite_tmp
    from evoflow.config.agents_config import AgentConfig
    from evoflow.persistence.session_repositories import get_session_row_for_ui
    from evoflow.session_tool_binding.agent_tools import invalidate_agent_tool_names_cache
    from evoflow.session_tool_binding.service import repair_session_tool_state

    session_key = "agent:main:sess-role-switch-persist"
    upsert_session_row(session_key, context={"session_mode": "agent", "agent_id": "main"})
    repair_session_tool_state(session_key)
    before = get_session_row_for_ui(session_key) or {}
    assert before.get("agentId") == "main"
    assert "tool_search" in (before.get("activeTools") or [])

    cfg = AgentConfig(
        agent_code="marketing-social-media-operation",
        tools=["read_file", "terminal"],
        disallowed_tools=["ask_clarification", "tool_search", "subagent"],
    )
    monkeypatch.setattr(
        "evoflow.session_tool_binding.agent_tools.load_agent_config",
        lambda _code: cfg,
    )
    invalidate_agent_tool_names_cache()

    upsert_session_row(
        session_key,
        context={
            "agent_id": "marketing-social-media-operation",
            "agent_name": "marketing-social-media-operation",
            "use_claude_code_chat": False,
        },
    )
    repair_session_tool_state(session_key)
    after = get_session_row_for_ui(session_key) or {}
    assert after.get("agentId") == "marketing-social-media-operation"
    assert (after.get("context") or {}).get("agent_id") == "marketing-social-media-operation"
    assert after.get("activeTools") == ["read", "terminal"]
    assert "ask_clarification" not in (after.get("pendingTools") or [])
    assert "browser" not in (after.get("pendingTools") or [])
    assert "subagent" not in (after.get("pendingTools") or [])

    # Stale columns must not win over derivation after a bad overwrite.
    from evoflow.persistence.db import get_db

    get_db().execute(
        """
        UPDATE evoflow_chat_sessions
        SET active_tools_json = ?, pending_tools_json = ?
        WHERE session_key = ?
        """,
        (
            '["delete","mind_map","read","replace","rg","terminal","tool_search","write"]',
            '["ask_clarification","browser","subagent"]',
            session_key,
        ),
    )
    get_db().commit()
    healed = get_session_row_for_ui(session_key) or {}
    assert healed.get("activeTools") == ["read", "terminal"]
    assert "browser" not in (healed.get("pendingTools") or [])


def test_prompt_pending_tools_exclude_loaded_deferred(monkeypatch: pytest.MonkeyPatch, sqlite_tmp: str) -> None:
    del sqlite_tmp
    from evoflow.agents.lead_agent.prompt import (
        get_deferred_tools_prompt_section,
        resolve_pending_tools_for_prompt,
    )

    session_key = "agent:main:sess-prompt-pending"
    upsert_session_row(session_key, session_mode="agent", agent_id="main")
    repair_session_tool_state(session_key)
    persist_tool_search_loaded(
        session_key=session_key,
        active_scenarios=["agent"],
        loaded_names=["worker"],
    )

    pending = resolve_pending_tools_for_prompt(
        session_key=session_key,
        active_scenarios=["agent"],
        loaded_tool_names=["read", "worker"],
        loaded_deferred=["worker"],
    )
    assert "worker" not in pending
    assert "process" in pending

    monkeypatch.setattr(
        "evoflow.config.get_app_config",
        lambda: type("Cfg", (), {"tool_search": type("TS", (), {"enabled": True})()})(),
    )
    section = get_deferred_tools_prompt_section(pending_names=pending)
    assert "worker" not in section
    assert "process" in section


def test_resolve_runtime_tool_mode_uses_persisted_session_mode(sqlite_tmp: str) -> None:
    del sqlite_tmp
    from evoflow.session_tool_binding.service import resolve_runtime_tool_mode

    session_key = "agent:main:sess-plan-persist"
    upsert_session_row(session_key, session_mode="plan")
    assert resolve_runtime_tool_mode(session_key, []) == "plan"
    assert resolve_runtime_tool_mode(session_key, ["agent"]) == "agent"


def test_runtime_snapshot_uses_persisted_mode_when_scenarios_empty(sqlite_tmp: str) -> None:
    del sqlite_tmp
    from evoflow.agents.lead_agent.intent_tool_profile import CORE_TOOL_NAMES
    from evoflow.persistence.session_tool_binding_repositories import get_chat_session_tool_snapshot
    from evoflow.session_tool_binding.service import sync_runtime_tool_snapshot

    session_key = "agent:main:sess-runtime-plan"
    upsert_session_row(session_key, session_mode="plan")
    seed_session_tool_bindings(session_key)

    sync_runtime_tool_snapshot(
        session_key=session_key,
        active_scenarios=[],
        model_bound_tools=list(CORE_TOOL_NAMES),
        loaded_deferred=[],
    )
    after = get_chat_session_tool_snapshot(session_key)
    assert after is not None
    assert after["current_mode"] == "plan"
    assert "plan" in after["bound_tools"]
    assert "supervisor" in after["bound_tools"]
    assert "read" in after["bound_tools"]
    assert "collab_peer_read" in after["bound_tools"]


def test_runtime_snapshot_matches_bootstrap_tools(sqlite_tmp: str) -> None:
    del sqlite_tmp
    from evoflow.agents.lead_agent.intent_tool_profile import CORE_TOOL_NAMES
    from evoflow.persistence.session_tool_binding_repositories import get_chat_session_tool_snapshot
    from evoflow.session_tool_binding.service import sync_runtime_tool_snapshot

    session_key = "agent:main:sess-runtime-snapshot"
    upsert_session_row(session_key, session_mode="agent", agent_id="main")
    repair_session_tool_state(session_key)

    before = get_chat_session_tool_snapshot(session_key)
    assert before is not None
    assert "read" in before["active_tools"]

    sync_runtime_tool_snapshot(
        session_key=session_key,
        active_scenarios=["agent"],
        model_bound_tools=list(CORE_TOOL_NAMES),
        loaded_deferred=[],
    )
    after = get_chat_session_tool_snapshot(session_key)
    assert after is not None
    assert after["current_mode"] == "agent"
    assert set(after["active_tools"]) == set(CORE_TOOL_NAMES)


def test_seed_session_tool_bindings_idempotent(sqlite_tmp: str) -> None:
    del sqlite_tmp
    session_key = "sess-seed"
    seed_session_tool_bindings(session_key)
    first = list_full_scenario_bindings_for_session(session_key)
    seed_session_tool_bindings(session_key)
    second = list_full_scenario_bindings_for_session(session_key)
    assert first.keys() == second.keys()


def test_scenario_switch_roundtrip_restores_loaded_deferred_from_trajectory(sqlite_tmp: str) -> None:
    """agent -> ask -> agent: the second switch back restores the deferred tools
    persisted during the first agent window from the append-only trajectory table."""
    del sqlite_tmp
    session_key = "sess-trajectory-roundtrip"
    _seed_session(session_key, session_mode="agent")

    # First agent window: load worker as a deferred tool (writes a tool_search_load row).
    persist_tool_search_loaded(
        session_key=session_key,
        active_scenarios=["agent"],
        loaded_names=["worker"],
    )
    assert get_loaded_deferred_for_scenario(session_key, "agent") == ["worker"]

    # Switch agent -> ask: switch-out row records worker; switch-in restores [] for ask.
    restored_ask = on_scenario_tool_success(
        session_key=session_key,
        current_loaded=["worker"],
        payload={
            "status": "success",
            "action": "activate",
            "scenario_key": "ask",
            "previous_scenarios": ["agent"],
            "all_active_scenarios": [],
        },
    )
    assert restored_ask == []
    # The agent scenario still carries worker (trajectory append-only).
    assert get_loaded_deferred_for_scenario(session_key, "agent") == ["worker"]

    # Switch ask -> agent: switch-in row must restore worker from the latest
    # agent trajectory row (the one written during the first agent window).
    restored_agent = on_scenario_tool_success(
        session_key=session_key,
        current_loaded=[],
        payload={
            "status": "success",
            "action": "activate",
            "scenario_key": "agent",
            "previous_scenarios": [],
            "all_active_scenarios": ["agent"],
        },
    )
    assert restored_agent == ["worker"]
    assert get_loaded_deferred_for_scenario(session_key, "agent") == ["worker"]

    # The trajectory table accumulated multiple rows for the agent scenario;
    # the latest one carries the restored deferred set.
    rows = get_db().execute(
        "SELECT event_type, loaded_deferred_json FROM evoflow_session_scenario_trajectory "
        "WHERE session_key = ? AND scenario_key = 'agent' ORDER BY id ASC",
        (session_key,),
    ).fetchall()
    assert len(rows) >= 2
    event_types = [str(r[0]) for r in rows]
    assert "tool_search_load" in event_types
    assert "scenario_switch_in" in event_types
    import json as _json

    last = _json.loads(str(rows[-1][1]))
    assert last == ["worker"]


def test_persist_tool_search_load_appends_trajectory_row(sqlite_tmp: str) -> None:
    """Loading a deferred worker appends exactly one tool_search_load trajectory row
    carrying the loaded tool name; the scenario's latest binding reflects it."""
    del sqlite_tmp
    from evoflow.persistence.session_tool_binding_repositories import get_scenario_binding

    session_key = "sess-trajectory-toolload"
    _seed_session(session_key, session_mode="agent")

    before = get_db().execute(
        "SELECT COUNT(*) FROM evoflow_session_scenario_trajectory WHERE session_key = ?",
        (session_key,),
    ).fetchone()
    before_count = int(before[0]) if before else 0

    saved = persist_tool_search_loaded(
        session_key=session_key,
        active_scenarios=["agent"],
        loaded_names=["worker"],
    )
    assert "worker" in saved

    after = get_db().execute(
        "SELECT COUNT(*) FROM evoflow_session_scenario_trajectory WHERE session_key = ?",
        (session_key,),
    ).fetchone()
    after_count = int(after[0]) if after else 0
    assert after_count == before_count + 1

    row = get_db().execute(
        "SELECT event_type, loaded_deferred_json, scenario_key "
        "FROM evoflow_session_scenario_trajectory "
        "WHERE session_key = ? ORDER BY id DESC LIMIT 1",
        (session_key,),
    ).fetchone()
    assert row is not None
    assert str(row[0]) == "tool_search_load"
    import json as _json

    assert _json.loads(str(row[1])) == ["worker"]
    assert str(row[2]) == "agent"

    # Latest binding for the agent scenario reflects the loaded deferred tool.
    binding = get_scenario_binding(session_key, "agent")
    assert binding is not None
    assert binding["loaded_deferred"] == ["worker"]


def test_flat_bound_tool_names_excludes_tool_search() -> None:
    from evoflow.agents.lead_agent.intent_tool_profile import (
        SESSION_MODE_DEFERRED_CATALOG,
        flat_bound_tool_names_for_session_mode,
    )

    ask = flat_bound_tool_names_for_session_mode("ask")
    assert "tool_search" not in ask
    assert "ask_clarification" in ask
    assert "knowledge" in ask

    agent = flat_bound_tool_names_for_session_mode("agent")
    assert "tool_search" not in agent
    assert "read" in agent
    assert "terminal" in agent
    assert "browser" in agent
    for name in SESSION_MODE_DEFERRED_CATALOG["agent"]:
        if name != "tool_search":
            assert name in agent


def test_tool_search_disabled_binds_flat_mode_tools(
    monkeypatch: pytest.MonkeyPatch, sqlite_tmp: str
) -> None:
    del sqlite_tmp
    from evoflow.session_tool_binding.agent_tools import (
        bound_tools_for_session_agent,
        deferred_catalog_for_session_agent,
        pending_activation_for_session_agent,
    )

    session_key = "agent:main:sess-flat-bind"
    upsert_session_row(session_key, session_mode="agent", agent_id="main")

    monkeypatch.setattr(
        "evoflow.session_tool_binding.agent_tools._tool_search_enabled",
        lambda: False,
    )
    monkeypatch.setattr(
        "evoflow.session_tool_binding.agent_tools.resolve_agent_tool_names_for_session",
        lambda _sk: frozenset(
            {
                "tool_search",
                "read",
                "terminal",
                "browser",
                "process",
                "ask_clarification",
                "web_search",
            }
        ),
    )

    bound = bound_tools_for_session_agent(session_key, "agent")
    assert "tool_search" not in bound
    assert "read" in bound
    assert "terminal" in bound
    assert "browser" in bound
    assert "process" in bound
    assert "ask_clarification" in bound
    assert deferred_catalog_for_session_agent(session_key, "agent") == []
    assert pending_activation_for_session_agent(session_key, "agent", loaded_deferred=[]) == []


def test_get_available_tools_omits_tool_search_when_disabled(
    monkeypatch: pytest.MonkeyPatch, sqlite_tmp: str
) -> None:
    del sqlite_tmp
    from evoflow.tools.tools import get_available_tools, invalidate_available_tools_cache

    monkeypatch.setattr(
        "evoflow.config.tool_search_config.TOOL_SEARCH_TEMPORARILY_DISABLED",
        True,
    )
    invalidate_available_tools_cache()
    names = {getattr(t, "name", "") for t in get_available_tools(include_search=True)}
    assert "tool_search" not in names


def test_tool_search_feature_temporarily_disabled_skips_injection(
    monkeypatch: pytest.MonkeyPatch, sqlite_tmp: str
) -> None:
    """While TOOL_SEARCH_TEMPORARILY_DISABLED, catalog must not include tool_search."""
    del sqlite_tmp
    from evoflow.tools.tools import get_available_tools, invalidate_available_tools_cache

    monkeypatch.setattr(
        "evoflow.config.tool_search_config.TOOL_SEARCH_TEMPORARILY_DISABLED",
        True,
    )
    invalidate_available_tools_cache()
    names = {getattr(t, "name", "") for t in get_available_tools(include_search=False)}
    assert "tool_search" not in names
