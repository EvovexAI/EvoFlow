"""LangGraph ``interrupted`` must not keep SQLite run_status=running forever.

Regression: cancel / GraphRecursionError left LG status=interrupted while
``_ACTIVE_RUN_STATUSES`` treated it as live → end_session_turn / reconcile
never cleared DB → UI gear spun after the turn looked finished.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.gateway import run_status_reconcile as rsr


def test_interrupted_alone_is_not_live_for_ui():
    assert rsr._lg_status_is_live_for_ui("pending", thread_id="t1") is True
    assert rsr._lg_status_is_live_for_ui("running", thread_id="t1") is True
    assert rsr._lg_status_is_live_for_ui("success", thread_id="t1") is False
    assert rsr._lg_status_is_live_for_ui("interrupted", thread_id="t1") is False


def test_interrupted_stays_live_while_stream_proxy_attached(monkeypatch):
    monkeypatch.setattr(rsr, "_thread_has_active_proxy", lambda tid: tid == "t-live")
    monkeypatch.setattr(rsr, "_collab_phase_is_active", lambda _tid: False)
    assert rsr._lg_status_is_live_for_ui("interrupted", thread_id="t-live") is True
    assert rsr._lg_status_is_live_for_ui("interrupted", thread_id="t-dead") is False


@pytest.mark.asyncio
async def test_langgraph_probe_interrupted_without_proxy_is_inactive(monkeypatch):
    monkeypatch.setattr(rsr, "_thread_has_active_proxy", lambda _tid: False)
    monkeypatch.setattr(rsr, "_collab_phase_is_active", lambda _tid: False)
    rsr.invalidate_runs_probe_cache()

    payload = {
        "runs": [
            {"run_id": "run-old", "status": "interrupted"},
            {"run_id": "run-new", "status": "success"},
        ]
    }
    resp = MagicMock()
    resp.status_code = 200
    resp.json = MagicMock(return_value=payload)
    client = SimpleNamespace(get=AsyncMock(return_value=resp))

    active = await rsr._langgraph_has_active_run(client, "thread-1", run_id="run-old")
    assert active is False


@pytest.mark.asyncio
async def test_langgraph_probe_running_still_active(monkeypatch):
    monkeypatch.setattr(rsr, "_thread_has_active_proxy", lambda _tid: False)
    monkeypatch.setattr(rsr, "_collab_phase_is_active", lambda _tid: False)
    rsr.invalidate_runs_probe_cache()

    resp = MagicMock()
    resp.status_code = 200
    resp.json = MagicMock(return_value={"runs": [{"run_id": "run-1", "status": "running"}]})
    client = SimpleNamespace(get=AsyncMock(return_value=resp))

    assert await rsr._langgraph_has_active_run(client, "thread-1", run_id="run-1") is True


@pytest.mark.asyncio
async def test_discover_active_run_id_skips_bare_interrupted(monkeypatch):
    rsr.invalidate_runs_probe_cache()
    resp = MagicMock()
    resp.status_code = 200
    resp.json = MagicMock(
        return_value={
            "runs": [
                {"run_id": "run-int", "status": "interrupted", "created_at": "2026-11-01T10:00:00Z"},
                {"run_id": "run-ok", "status": "success", "created_at": "2026-11-01T10:01:00Z"},
            ]
        }
    )
    client = SimpleNamespace(get=AsyncMock(return_value=resp))
    assert await rsr.discover_active_run_id(client, "thread-1") is None


@pytest.mark.asyncio
async def test_execution_state_heals_sticky_running(monkeypatch):
    from pathlib import Path

    from evoflow.session_execution import queries as q

    rows = {
        "thread_id": "tid-1",
        "run_status": "running",
        "current_run_id": "run-stuck",
        "current_turn_started_at": "2026-11-01T09:00:00+00:00",
        "current_turn_ended_at": None,
    }
    healed_rows = {
        **rows,
        "run_status": "done",
        "current_run_id": None,
        "current_turn_ended_at": "2026-11-01T09:05:00+00:00",
    }
    state = {"n": 0}

    def _read(_sk: str):
        state["n"] += 1
        return rows if state["n"] == 1 else healed_rows

    monkeypatch.setattr(q.sess_repo, "is_session_deleted", lambda _sk: False)
    monkeypatch.setattr(q, "_read_chat_session_run_row", _read)
    monkeypatch.setattr(q, "resolve_evolflow_db_path", lambda: Path("."))

    force = MagicMock(return_value=True)

    async def _inactive(_client, _tid, *, run_id=None):
        return False

    monkeypatch.setattr("evoflow.runtime.ports.is_thread_run_active", _inactive)
    monkeypatch.setattr(
        "evoflow.session_execution.lifecycle.force_end_session_turn",
        force,
    )

    out = await q.build_session_execution_state("agent:main:test")
    assert force.called
    assert out["executing"] is False
    assert out["runStatus"] == "done"
    assert out["langgraphActive"] is False
