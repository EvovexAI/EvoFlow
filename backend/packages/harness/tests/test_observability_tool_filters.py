"""Tests for internal tool filtering in observability aggregates."""

from __future__ import annotations

import gc
import tempfile
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from evoflow.agents.middlewares.round_trace_middleware import _tool_binding_snapshot
from evoflow.observability.queries import fetch_overview, list_tool_invocations
from evoflow.observability.recorder import get_observability_recorder, reset_observability_store_for_tests
from evoflow.observability.tool_filters import (
    is_internal_tool_invocation,
    llm_tool_visibility_sql,
    tool_invocation_and_suffix,
    tool_invocation_where,
)
from evoflow.persistence.db import reset_db_for_tests

_EVOFLOW_ROOT = Path(__file__).resolve().parents[4]


@pytest.fixture
def sqlite_tmp(monkeypatch: pytest.MonkeyPatch):
    with tempfile.TemporaryDirectory() as tmp:
        monkeypatch.setenv("EVOFLOW_HOME", tmp)
        reset_db_for_tests()
        yield tmp
        reset_db_for_tests()
        gc.collect()


@pytest.fixture
def obs_tmp(sqlite_tmp: str, monkeypatch: pytest.MonkeyPatch):
    del sqlite_tmp
    monkeypatch.setenv("EVOFLOW_CONFIG_PATH", str(_EVOFLOW_ROOT / "config.yaml"))
    from evoflow.config.app_config import get_app_config, reset_app_config, set_app_config

    with tempfile.TemporaryDirectory() as tmp:
        obs_path = f"{tmp}/obs.db"
        reset_app_config()
        reset_observability_store_for_tests()
        base = get_app_config()
        custom = base.model_copy(deep=True)
        custom.observability = custom.observability.model_copy(
            update={"enabled": True, "sqlite_path": obs_path}
        )
        set_app_config(custom)
        yield obs_path
        reset_observability_store_for_tests()
        reset_app_config()
        gc.collect()


def test_is_internal_tool_invocation() -> None:
    assert is_internal_tool_invocation("scheduler:post_search_read") is True
    assert is_internal_tool_invocation("Scheduler:Foo") is True
    assert is_internal_tool_invocation("read") is False
    assert is_internal_tool_invocation("") is False
    assert is_internal_tool_invocation(None) is False


def test_llm_tool_visibility_sql_fragments() -> None:
    assert llm_tool_visibility_sql() == "tool_name NOT LIKE 'scheduler:%'"
    assert llm_tool_visibility_sql(include_internal=True) == "1=1"
    assert "scheduler" in tool_invocation_where()
    assert tool_invocation_and_suffix("status = 'error'").startswith(" AND ")


def test_list_tool_invocations_excludes_scheduler_by_default(obs_tmp: str) -> None:
    del obs_tmp
    thread_id = str(uuid.uuid4())
    rec = get_observability_recorder()
    rec.record_tool_invocation(
        thread_id=thread_id,
        run_id="run-1",
        tool_call_id="tc-read",
        tool_name="read",
        started_at="2026-06-12T10:00:01Z",
        ended_at="2026-06-12T10:00:02Z",
        duration_ms=100.0,
        status="ok",
        input_obj={},
        output_text="ok",
    )
    rec.record_tool_invocation(
        thread_id=thread_id,
        run_id="run-1",
        tool_call_id="tc-sched",
        tool_name="scheduler:post_search_read",
        started_at="2026-06-12T10:00:02Z",
        ended_at="2026-06-12T10:00:02Z",
        duration_ms=0.0,
        status="ok",
        input_obj={},
        output_text="",
    )

    default_page = list_tool_invocations(thread_id=thread_id, page_size=50)
    assert default_page["total"] == 1
    assert default_page["items"][0]["tool_name"] == "read"

    with_internal = list_tool_invocations(thread_id=thread_id, page_size=50, include_internal=True)
    assert with_internal["total"] == 2


def test_fetch_overview_excludes_scheduler(obs_tmp: str) -> None:
    del obs_tmp
    thread_id = str(uuid.uuid4())
    rec = get_observability_recorder()
    rec.record_tool_invocation(
        thread_id=thread_id,
        run_id="run-1",
        tool_call_id="tc1",
        tool_name="terminal",
        started_at="2026-06-12T10:00:01Z",
        ended_at="2026-06-12T10:00:02Z",
        duration_ms=500.0,
        status="ok",
        input_obj={},
        output_text="ok",
    )
    rec.record_tool_invocation(
        thread_id=thread_id,
        run_id="run-1",
        tool_call_id="tc2",
        tool_name="scheduler:post_search_read",
        started_at="2026-06-12T10:00:02Z",
        ended_at="2026-06-12T10:00:02Z",
        duration_ms=0.0,
        status="ok",
        input_obj={},
        output_text="",
    )

    overview = fetch_overview()
    assert overview["enabled"] is True
    assert overview["tool_invocations"] == 1


def test_tool_binding_snapshot_bound_vs_deferred() -> None:
    deferred_entries = [
        SimpleNamespace(name="worker"),
        SimpleNamespace(name="process"),
    ]
    registry = SimpleNamespace(entries=deferred_entries)

    with patch(
        "evoflow.tools.builtins.tool_search.get_deferred_registry",
        return_value=registry,
    ):
        snap = _tool_binding_snapshot(
            ["read", "rg", "worker"],
            ["worker"],
        )

    assert snap["model_bound_tools"] == ["read", "rg", "worker"]
    assert snap["loaded_deferred_tools"] == ["worker"]
    assert snap["deferred_catalog_tools"] == ["process", "worker"]
    assert snap["deferred_not_yet_loaded"] == ["process"]
