"""Tests for panel session heuristics and client cleanup."""

from __future__ import annotations

import asyncio
import tempfile
from unittest.mock import AsyncMock, patch

import pytest

from evoflow.persistence import session_repositories as sess_repo
from evoflow.persistence.db import get_db, reset_db_for_tests
from evoflow.persistence.session_run_state import RUN_STATUS_CANCELLED, RUN_STATUS_DONE, RUN_STATUS_RUNNING, mark_session_run_started
from evoflow.session_execution.panel_sessions import is_panel_attached_session_key


@pytest.fixture
def sqlite_tmp(monkeypatch: pytest.MonkeyPatch):
    with tempfile.TemporaryDirectory() as tmp:
        monkeypatch.setenv("EVOFLOW_HOME", tmp)
        reset_db_for_tests()
        get_db()
        yield
        reset_db_for_tests()


def test_is_panel_attached_session_key() -> None:
    assert is_panel_attached_session_key("agent:main:main") is True
    assert is_panel_attached_session_key("agent:main:web:test-1") is True
    assert is_panel_attached_session_key("agent:main:feishu:chat-1") is False
    assert is_panel_attached_session_key("agent:main:telegram:123") is False


def test_stop_all_panel_chat_sessions_skips_im(sqlite_tmp: None) -> None:
    del sqlite_tmp
    from evoflow.session_execution.client_cleanup import stop_all_panel_chat_sessions

    panel_sk = "agent:main:web:panel-1"
    im_sk = "agent:main:feishu:im-1"
    sess_repo.upsert_session_row(panel_sk, thread_id="t-panel", title="panel")
    sess_repo.upsert_session_row(im_sk, thread_id="t-im", title="im")
    mark_session_run_started(session_key=panel_sk, run_id="run-panel")
    mark_session_run_started(session_key=im_sk, run_id="run-im")

    async def _run() -> None:
        with patch(
            "evoflow.session_execution.commands.stop_session_execution",
            new_callable=AsyncMock,
        ) as stop_mock:
            stopped = await stop_all_panel_chat_sessions(reason="test")
        assert stopped == [panel_sk]
        stop_mock.assert_awaited_once_with(panel_sk, user_initiated=False, reason="test")

    asyncio.run(_run())


def test_stop_all_panel_chat_sessions_idles_db(sqlite_tmp: None) -> None:
    del sqlite_tmp
    from evoflow.session_execution.client_cleanup import stop_all_panel_chat_sessions

    sk = "agent:main:main"
    sess_repo.upsert_session_row(sk, thread_id="t-main", title="main")
    mark_session_run_started(session_key=sk, run_id="run-main")

    async def _run() -> None:
        with patch(
            "evoflow.session_execution.commands.sweep_langgraph_runs_until_idle",
            new_callable=AsyncMock,
            return_value=([], []),
        ):
            stopped = await stop_all_panel_chat_sessions(reason="test")
        assert stopped == [sk]
        row = sess_repo.get_session_row_for_ui(sk)
        assert row is not None
        assert row["runStatus"] == RUN_STATUS_DONE

    asyncio.run(_run())
