"""Activated scenarios persist on evoflow_chat_sessions (per session_key)."""

from __future__ import annotations

import tempfile
from unittest.mock import patch

import pytest

from evoflow.persistence import session_repositories as sess_repo
from evoflow.persistence.db import get_db, reset_db_for_tests
from evoflow.tools.builtins.scenario_activation import (
    _persist_activated_scenarios,
    get_activated_scenarios,
    hydrate_activated_scenarios_context_var_from_disk,
    replace_activated_scenarios_from_mission_list,
    reset_activated_scenario,
)


@pytest.fixture
def sqlite_tmp(monkeypatch: pytest.MonkeyPatch):
    with tempfile.TemporaryDirectory() as tmp:
        monkeypatch.setenv("EVOFLOW_HOME", tmp)
        reset_db_for_tests()
        get_db()
        yield
        reset_db_for_tests()


@pytest.fixture(autouse=True)
def _clear_scenario_state() -> None:
    reset_activated_scenario()
    yield
    reset_activated_scenario()


def test_session_defaults_empty_scenarios(sqlite_tmp) -> None:
    del sqlite_tmp
    sk = "agent:main:test-scenario-default"
    now = 1_700_000_000_000
    sess_repo.upsert_session_row(sk, thread_id="tid-default", created_at_ms=now, updated_at_ms=now)
    assert sess_repo.get_session_activated_scenarios(sk) == []
    row = sess_repo.get_session_row_for_ui(sk)
    assert row is not None
    assert row.get("activatedScenarios") == []


def test_set_and_load_session_activated_scenarios(sqlite_tmp) -> None:
    del sqlite_tmp
    sk = "agent:main:test-scenario-set"
    tid = "tid-set-1"
    now = 1_700_000_000_000
    sess_repo.upsert_session_row(sk, thread_id=tid, created_at_ms=now, updated_at_ms=now)
    sess_repo.set_session_activated_scenarios(sk, ["agent"])
    assert sess_repo.get_session_activated_scenarios(sk) == ["agent"]
    assert sess_repo.get_session_activated_scenarios_for_thread(tid) == ["agent"]


def test_persist_activated_scenarios_writes_chat_session(sqlite_tmp) -> None:
    del sqlite_tmp
    sk = "agent:main:test-scenario-persist"
    tid = "tid-persist-1"
    now = 1_700_000_000_000
    sess_repo.upsert_session_row(sk, thread_id=tid, created_at_ms=now, updated_at_ms=now)
    replace_activated_scenarios_from_mission_list(["web"])
    with patch(
        "langgraph.config.get_config",
        return_value={"configurable": {"thread_id": tid, "session_key": sk}},
    ):
        _persist_activated_scenarios(["plan"])
    assert sess_repo.get_session_activated_scenarios(sk) == ["plan"]


def test_hydrate_empty_session_does_not_restore_mission_legacy(sqlite_tmp) -> None:
    del sqlite_tmp
    sk = "agent:main:test-scenario-empty-chat"
    tid = "tid-empty-chat-1"
    now = 1_700_000_000_000
    sess_repo.upsert_session_row(sk, thread_id=tid, created_at_ms=now, updated_at_ms=now)
    sess_repo.set_session_activated_scenarios(sk, [])
    replace_activated_scenarios_from_mission_list(["web"])
    with patch(
        "evoflow.agents.mission_state.storage.load_mission_state",
        return_value=type(
            "MS",
            (),
            {"activated_scenarios": ["agent"]},
        )(),
    ):
        hydrate_activated_scenarios_context_var_from_disk(tid)
    assert get_activated_scenarios() == []


def test_hydrate_from_chat_session(sqlite_tmp) -> None:
    del sqlite_tmp
    sk = "agent:main:test-scenario-hydrate"
    tid = "tid-hydrate-1"
    now = 1_700_000_000_000
    sess_repo.upsert_session_row(sk, thread_id=tid, created_at_ms=now, updated_at_ms=now)
    sess_repo.set_session_activated_scenarios(sk, ["manage"])
    reset_activated_scenario()
    hydrate_activated_scenarios_context_var_from_disk(tid)
    # legacy manage 场景已退役，hydrate 时丢弃
    assert get_activated_scenarios() == []


def test_hydrate_legacy_web_maps_to_workspace(sqlite_tmp) -> None:
    del sqlite_tmp
    sk = "agent:main:test-scenario-hydrate-web"
    tid = "tid-hydrate-web"
    now = 1_700_000_000_002
    sess_repo.upsert_session_row(sk, thread_id=tid, created_at_ms=now, updated_at_ms=now)
    sess_repo.set_session_activated_scenarios(sk, ["web"])
    reset_activated_scenario()
    hydrate_activated_scenarios_context_var_from_disk(tid)
    assert get_activated_scenarios() == ["agent"]


def test_hydrate_drops_legacy_evolve_scenario(sqlite_tmp) -> None:
    del sqlite_tmp
    sk = "agent:main:test-scenario-hydrate-evolve"
    tid = "tid-hydrate-evolve"
    now = 1_700_000_000_001
    sess_repo.upsert_session_row(sk, thread_id=tid, created_at_ms=now, updated_at_ms=now)
    sess_repo.set_session_activated_scenarios(sk, ["evolve"])
    reset_activated_scenario()
    hydrate_activated_scenarios_context_var_from_disk(tid)
    assert get_activated_scenarios() == []


def test_hydrate_drops_legacy_trae_scenario(sqlite_tmp) -> None:
    del sqlite_tmp
    sk = "agent:main:test-scenario-hydrate-trae"
    tid = "tid-hydrate-trae"
    now = 1_700_000_000_003
    sess_repo.upsert_session_row(sk, thread_id=tid, created_at_ms=now, updated_at_ms=now)
    sess_repo.set_session_activated_scenarios(sk, ["trae"])
    reset_activated_scenario()
    hydrate_activated_scenarios_context_var_from_disk(tid)
    assert get_activated_scenarios() == []
