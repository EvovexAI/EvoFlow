"""Runtime identity injection for LangGraph runs / session stamps."""

from __future__ import annotations

import gc
import tempfile
from pathlib import Path

import pytest

from evoflow.persistence.db import get_db, reset_db_for_tests
from evoflow.persistence.schema import ensure_app_schema

_EVOFLOW_ROOT = Path(__file__).resolve().parents[4]


@pytest.fixture
def sqlite_tmp(monkeypatch: pytest.MonkeyPatch):
    with tempfile.TemporaryDirectory() as tmp:
        monkeypatch.setenv("EVOFLOW_HOME", tmp)
        monkeypatch.setenv("EVOFLOW_CONFIG_PATH", str(_EVOFLOW_ROOT / "config.yaml"))
        reset_db_for_tests()
        yield tmp
        reset_db_for_tests()
        gc.collect()


def test_enrich_from_explicit_principal() -> None:
    from evoflow.authz.runtime_identity import enrich_run_context_identity

    out = enrich_run_context_identity({"principal_id": "user:alice"})
    assert out["principal_id"] == "user:alice"
    assert out["created_by"] == "user:alice"
    assert out["owner_scope_id"] == "personal:user:alice"


def test_enrich_from_session_and_automation(sqlite_tmp: str) -> None:
    del sqlite_tmp
    from evoflow.authz import principals as principals_mod
    from evoflow.authz.runtime_identity import (
        enrich_run_context_identity,
        resolve_identity_from_automation,
        stamp_session_from_identity,
    )
    from evoflow.authz.scope import personal_scope
    from evoflow.authz.session_ownership import stamp_session_ownership
    from evoflow.persistence import automation_repositories, session_repositories as sess_repo

    ensure_app_schema(get_db())
    alice = principals_mod.create_principal(display_name="Alice", principal_id="user:alice")
    a_scope = personal_scope("user:alice")

    sess_repo.upsert_session_row("agent:main:alice-run", title="t", thread_id="tid-a")
    stamp_session_ownership("agent:main:alice-run", alice, force=True)

    enriched = enrich_run_context_identity({"session_key": "agent:main:alice-run"})
    assert enriched["principal_id"] == "user:alice"
    assert enriched["owner_scope_id"] == a_scope

    automation_repositories.save_automation(
        "cron_alice",
        {"name": "Cron", "prompt": "hi", "schedule": "0 9 * * *", "status": "active"},
    )
    automation_repositories.set_automation_owner_scope(
        "cron_alice", org_id="local", owner_scope_id=a_scope, created_by="user:alice"
    )
    ident = resolve_identity_from_automation("cron_alice")
    assert ident["principal_id"] == "user:alice"

    sess_repo.upsert_session_row("automation:cron_alice", title="auto", thread_id="tid-auto")
    assert stamp_session_from_identity("automation:cron_alice", ident)
    again = enrich_run_context_identity(
        {"session_key": "automation:cron_alice", "automation_task_id": "cron_alice"}
    )
    assert again["principal_id"] == "user:alice"


def test_enrich_from_agent_owner(sqlite_tmp: str) -> None:
    del sqlite_tmp
    from evoflow.authz import principals as principals_mod
    from evoflow.authz.runtime_identity import enrich_run_context_identity, resolve_identity_from_agent
    from evoflow.authz.scope import personal_scope
    from evoflow.persistence import config_repositories
    from evoflow.persistence.schema import ensure_app_schema

    ensure_app_schema(get_db())
    principals_mod.create_principal(display_name="Alice", principal_id="user:alice")
    # Minimal agent row
    get_db().execute(
        """
        INSERT OR REPLACE INTO evoflow_agents (agent_code, agent_name, updated_at)
        VALUES ('alice-bot', 'Alice Bot', datetime('now'))
        """
    )
    get_db().commit()
    # Columns may vary — set_agent_owner_scope handles missing cols
    try:
        config_repositories.set_agent_owner_scope(
            "alice-bot", org_id="local", owner_scope_id=personal_scope("user:alice")
        )
    except Exception:
        get_db().execute(
            "UPDATE evoflow_agents SET owner_scope_id = ?, org_id = ? WHERE agent_code = ?",
            (personal_scope("user:alice"), "local", "alice-bot"),
        )
        get_db().commit()

    ident = resolve_identity_from_agent("alice-bot")
    assert ident.get("principal_id") == "user:alice"
    out = enrich_run_context_identity({"proactive_agent_code": "alice-bot"})
    assert out["principal_id"] == "user:alice"


def test_lead_agent_from_mapping_enriches() -> None:
    from evoflow.agents.lead_agent.runtime_context import LeadAgentRuntimeContext

    ctx = LeadAgentRuntimeContext.from_mapping(
        {"session_key": "x", "principal_id": "user:bob", "thread_id": "t1"}
    )
    assert ctx.principal_id == "user:bob"
    assert ctx.created_by == "user:bob"
    assert ctx.owner_scope_id == "personal:user:bob"


def test_merge_configurable_enriches_identity() -> None:
    from evoflow.langgraph_run_config import merge_configurable_into_context

    cfg, ctx = merge_configurable_into_context(
        {"recursion_limit": 10},
        {"principal_id": "user:carol", "session_key": "s1"},
    )
    assert "configurable" not in cfg
    assert ctx["principal_id"] == "user:carol"
    assert ctx["owner_scope_id"] == "personal:user:carol"
