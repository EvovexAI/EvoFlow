"""maybe_mark_session_run_ended must not idle while LangGraph run is still active."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, patch

from evoflow.persistence import session_repositories as sess_repo
from evoflow.persistence.session_run_state import (
    RUN_STATUS_CANCELLED,
    RUN_STATUS_DONE,
    RUN_STATUS_RUNNING,
    mark_session_run_started,
)


def test_maybe_mark_session_run_ended_keeps_running_when_langgraph_active(tmp_path, monkeypatch):
    db_path = tmp_path / "maybe_idle.db"
    monkeypatch.setenv("EVOFLOW_DB_PATH", str(db_path))
    from evoflow.persistence import db as db_mod

    db_mod._DB = None  # noqa: SLF001

    sk = "agent:main:test-maybe-idle-live"
    sess_repo.upsert_session_row(sk, thread_id="tid-live", title="t")
    mark_session_run_started(session_key=sk, run_id="run-live")

    async def _run() -> bool:
        with patch(
            "app.gateway.run_status_reconcile.is_thread_run_active",
            new=AsyncMock(return_value=True),
        ):
            from app.gateway.run_status_reconcile import maybe_mark_session_run_ended

            return await maybe_mark_session_run_ended(session_key=sk, run_id="run-live")

    marked = asyncio.run(_run())
    assert marked is False
    from evoflow.persistence.session_repositories import get_session_row_for_ui

    row = get_session_row_for_ui(sk) or {}
    assert row.get("runStatus") == RUN_STATUS_RUNNING


def test_maybe_mark_session_run_ended_marks_idle_when_langgraph_inactive(tmp_path, monkeypatch):
    db_path = tmp_path / "maybe_idle2.db"
    monkeypatch.setenv("EVOFLOW_DB_PATH", str(db_path))
    from evoflow.persistence import db as db_mod

    db_mod._DB = None  # noqa: SLF001

    sk = "agent:main:test-maybe-idle-done"
    sess_repo.upsert_session_row(sk, thread_id="tid-done", title="t2")
    mark_session_run_started(session_key=sk, run_id="run-done")

    async def _run() -> bool:
        with patch(
            "app.gateway.run_status_reconcile.is_thread_run_active",
            new=AsyncMock(return_value=False),
        ):
            from app.gateway.run_status_reconcile import maybe_mark_session_run_ended

            return await maybe_mark_session_run_ended(session_key=sk, run_id="run-done")

    marked = asyncio.run(_run())
    assert marked is True
    from evoflow.persistence.session_repositories import get_session_row_for_ui

    row = get_session_row_for_ui(sk) or {}
    assert row.get("runStatus") == RUN_STATUS_DONE


def test_ensure_session_run_active_heals_idle_row(tmp_path, monkeypatch):
    db_path = tmp_path / "ensure_active.db"
    monkeypatch.setenv("EVOFLOW_DB_PATH", str(db_path))
    from evoflow.persistence import db as db_mod

    db_mod._DB = None  # noqa: SLF001

    sk = "agent:main:test-ensure-active"
    sess_repo.upsert_session_row(sk, thread_id="thread-heal", title="heal")
    from evoflow.persistence.session_run_state import mark_session_run_ended

    mark_session_run_ended(session_key=sk)

    async def _run() -> tuple[bool, str | None]:
        with patch(
            "app.gateway.run_status_reconcile.is_thread_run_active",
            new=AsyncMock(return_value=True),
        ), patch(
            "app.gateway.run_status_reconcile.discover_active_run_id",
            new=AsyncMock(return_value="run-healed"),
        ):
            from app.gateway.run_status_reconcile import ensure_session_run_active

            return await ensure_session_run_active(
                AsyncMock(),
                session_key=sk,
                thread_id="thread-heal",
            )

    active, rid = asyncio.run(_run())
    assert active is True
    assert rid == "run-healed"
    from evoflow.persistence.session_repositories import get_session_row_for_ui

    row = get_session_row_for_ui(sk) or {}
    assert row.get("runStatus") == RUN_STATUS_RUNNING
    assert row.get("currentRunId") == "run-healed"


def test_ensure_session_run_active_skips_heal_after_user_stop(tmp_path, monkeypatch):
    db_path = tmp_path / "ensure_active_stop.db"
    monkeypatch.setenv("EVOFLOW_DB_PATH", str(db_path))
    from evoflow.persistence import db as db_mod

    db_mod._DB = None  # noqa: SLF001

    sk = "agent:main:test-ensure-active-stop"
    sess_repo.upsert_session_row(sk, thread_id="thread-stop", title="stop")
    from evoflow.persistence.session_run_state import mark_session_run_ended

    mark_session_run_ended(session_key=sk, reason="user_stop", source="user_stop")

    async def _run() -> tuple[bool, str | None]:
        with patch(
            "app.gateway.run_status_reconcile.is_thread_run_active",
            new=AsyncMock(return_value=True),
        ), patch(
            "app.gateway.run_status_reconcile.discover_active_run_id",
            new=AsyncMock(return_value="run-orphan"),
        ):
            from app.gateway.run_status_reconcile import ensure_session_run_active

            return await ensure_session_run_active(
                AsyncMock(),
                session_key=sk,
                thread_id="thread-stop",
            )

    active, rid = asyncio.run(_run())
    assert active is True
    assert rid == "run-orphan"
    from evoflow.persistence.session_repositories import get_session_row_for_ui

    row = get_session_row_for_ui(sk) or {}
    assert row.get("runStatus") == RUN_STATUS_CANCELLED
    assert row.get("currentRunId") in (None, "")


def test_maybe_mark_session_run_ended_force_skips_probe(tmp_path, monkeypatch):
    db_path = tmp_path / "maybe_idle3.db"
    monkeypatch.setenv("EVOFLOW_DB_PATH", str(db_path))
    from evoflow.persistence import db as db_mod

    db_mod._DB = None  # noqa: SLF001

    sk = "agent:main:test-maybe-idle-force"
    sess_repo.upsert_session_row(sk, thread_id="tid-force", title="t3")
    mark_session_run_started(session_key=sk, run_id="run-stop")

    probe = AsyncMock(return_value=True)

    async def _run() -> bool:
        with patch("app.gateway.run_status_reconcile.is_thread_run_active", new=probe):
            from app.gateway.run_status_reconcile import maybe_mark_session_run_ended

            return await maybe_mark_session_run_ended(session_key=sk, force=True)

    marked = asyncio.run(_run())
    assert marked is True
    probe.assert_not_called()
    from evoflow.persistence.session_repositories import get_session_row_for_ui

    row = get_session_row_for_ui(sk) or {}
    assert row.get("runStatus") == RUN_STATUS_DONE
