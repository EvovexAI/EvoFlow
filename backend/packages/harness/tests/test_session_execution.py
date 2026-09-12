"""Tests for evoflow.session_execution commands."""

from __future__ import annotations

import asyncio
import tempfile
from unittest.mock import AsyncMock, patch

import pytest

from evoflow.persistence import session_repositories as sess_repo
from evoflow.persistence.db import get_db, reset_db_for_tests
from evoflow.persistence.session_run_state import RUN_STATUS_CANCELLED, RUN_STATUS_DONE, RUN_STATUS_RUNNING, mark_session_run_started
from evoflow.session_execution.commands import mark_session_idle, stop_session_execution


@pytest.fixture
def sqlite_tmp(monkeypatch: pytest.MonkeyPatch):
    with tempfile.TemporaryDirectory() as tmp:
        monkeypatch.setenv("EVOFLOW_HOME", tmp)
        reset_db_for_tests()
        get_db()
        yield
        reset_db_for_tests()


from evoflow.session_execution.lifecycle import force_end_session_turn, start_session_turn
from evoflow.session_execution.queries import derive_executing


def test_start_session_turn_delegates(sqlite_tmp: None) -> None:
    del sqlite_tmp
    sk = "agent:main:test-lifecycle-start"
    sess_repo.upsert_session_row(sk, thread_id="tid-lc", title="t")
    assert start_session_turn(session_key=sk, run_id="run-lc", source="test")
    row = sess_repo.get_session_row_for_ui(sk)
    assert row is not None
    assert row["runStatus"] == RUN_STATUS_RUNNING


def test_force_end_session_turn_delegates(sqlite_tmp: None) -> None:
    del sqlite_tmp
    sk = "agent:main:test-lifecycle-end"
    sess_repo.upsert_session_row(sk, thread_id="tid-lc2", title="t")
    start_session_turn(session_key=sk, run_id="run-lc2", source="test")
    assert force_end_session_turn(session_key=sk, source="test")
    row = sess_repo.get_session_row_for_ui(sk)
    assert row is not None
    assert row["runStatus"] == RUN_STATUS_DONE


def test_derive_executing_from_db_run_status() -> None:
    assert derive_executing(run_status="running") is True
    assert derive_executing(run_status="pending") is True
    assert derive_executing(run_status="done") is False


def test_build_session_execution_state_db_only(sqlite_tmp: None) -> None:
    del sqlite_tmp
    sk = "agent:main:test-exec-state"
    sess_repo.upsert_session_row(sk, thread_id="tid-state", title="t")
    mark_session_run_started(session_key=sk, run_id="run-state", status=RUN_STATUS_RUNNING)

    async def _run() -> None:
        from evoflow.session_execution.queries import build_session_execution_state

        st = await build_session_execution_state(sk)
        assert st["schemaVersion"] == 4
        assert st["runStatus"] == RUN_STATUS_RUNNING
        assert st["runStatusRaw"] == RUN_STATUS_RUNNING
        assert st["executing"] is True
        assert st["runId"] == "run-state"
        assert st["currentTurnStartedAt"]
        assert st["currentTurnEndedAt"] is None
        assert st["gatewayStreamActive"] is False
        assert st["langgraphActive"] is True
        # R0-3: 运行中不应误报 recently_completed
        assert st["recently_completed"] is False
        assert st["recently_completed_run_id"] is None
        assert st["recently_completed_status"] is None

    asyncio.run(_run())


def test_build_session_execution_state_idle_when_db_done(sqlite_tmp: None) -> None:
    del sqlite_tmp
    sk = "agent:main:test-exec-state-idle"
    sess_repo.upsert_session_row(sk, thread_id="tid-idle", title="t")

    async def _run() -> None:
        from evoflow.session_execution.queries import build_session_execution_state

        st = await build_session_execution_state(sk)
        assert st["schemaVersion"] == 4
        assert st["executing"] is False
        assert st["attachRecommended"] is False
        assert st["langgraphActive"] is False
        assert st["runStatus"] not in ("running", "pending")
        assert st["currentTurnStartedAt"] is None
        assert st["currentTurnEndedAt"] is None
        # R0-3: 无 turn_ended 时不应误报 recently_completed
        assert st["recently_completed"] is False
        assert st["recently_completed_run_id"] is None
        assert st["recently_completed_status"] is None

    asyncio.run(_run())


def test_mark_session_idle_clears_running(sqlite_tmp: None) -> None:
    del sqlite_tmp
    sk = "agent:main:test-exec-idle"
    sess_repo.upsert_session_row(sk, thread_id="tid-exec-idle", title="t")
    mark_session_run_started(session_key=sk, run_id="run-1", status=RUN_STATUS_RUNNING)

    async def _run() -> None:
        with patch("evoflow.session_execution.commands._clear_live_snapshot"), patch(
            "evoflow.session_execution.lifecycle.end_session_turn",
            new_callable=AsyncMock,
        ) as mock_end:
            mock_end.return_value = True
            result = await mark_session_idle(sk)
        assert result.ok is True
        assert result.session_key == sk
        mock_end.assert_awaited_once()

    asyncio.run(_run())
    row = sess_repo.get_session_row_for_ui(sk)
    assert row is not None


def test_stop_session_execution_cancels_and_idles(sqlite_tmp: None) -> None:
    del sqlite_tmp
    sk = "agent:main:test-exec-stop"
    tid = "tid-exec-stop"
    sess_repo.upsert_session_row(sk, thread_id=tid, title="t")
    mark_session_run_started(session_key=sk, run_id="run-stop", status=RUN_STATUS_RUNNING)

    async def _run() -> None:
        with patch(
            "evoflow.session_execution.commands.sweep_langgraph_runs_until_idle",
            new_callable=AsyncMock,
            return_value=(["run-stop"], []),
        ) as mock_sweep, patch(
            "evoflow.session_execution.commands.mark_session_idle",
            new_callable=AsyncMock,
        ) as mock_idle:
            idle_result = type("R", (), {
                "ok": True,
                "session_key": sk,
                "run_id": "run-stop",
                "phase": RUN_STATUS_CANCELLED,
                "cancelled_run_ids": [],
                "session": {"runStatus": RUN_STATUS_CANCELLED},
            })()
            mock_idle.return_value = idle_result
            result = await stop_session_execution(sk)

        mock_sweep.assert_awaited_once()
        mock_idle.assert_awaited_once_with(sk, reason="user_stop")
        assert result.cancelled_run_ids == ["run-stop"]
        assert result.phase == RUN_STATUS_CANCELLED

    asyncio.run(_run())


def test_stop_session_execution_send_prep_skips_mark_idle(sqlite_tmp: None) -> None:
    del sqlite_tmp
    sk = "agent:main:test-exec-send-prep"
    tid = "tid-send-prep"
    sess_repo.upsert_session_row(sk, thread_id=tid, title="t")
    mark_session_run_started(session_key=sk, run_id="run-prep", status=RUN_STATUS_RUNNING)

    async def _run() -> None:
        with patch(
            "evoflow.session_execution.commands.cancel_langgraph_runs_before_send",
            new_callable=AsyncMock,
            return_value=["run-prep"],
        ) as mock_prep, patch(
            "evoflow.session_execution.commands.mark_session_idle",
            new_callable=AsyncMock,
        ) as mock_idle:
            result = await stop_session_execution(sk, user_initiated=False)

        mock_prep.assert_awaited_once()
        mock_idle.assert_not_awaited()
        assert result.cancelled_run_ids == ["run-prep"]

    asyncio.run(_run())
    row = sess_repo.get_session_row_for_ui(sk)
    assert row is not None
    assert row["runStatus"] == RUN_STATUS_RUNNING
