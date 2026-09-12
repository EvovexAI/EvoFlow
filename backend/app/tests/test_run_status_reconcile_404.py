"""Evidence-based run_status reconcile: missing LangGraph thread is not active."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch


def test_langgraph_404_means_not_active_not_skip() -> None:
    """Thread/runs 404 must return False so zombie sweeper can clear sticky rows.

    Returning None (= probe failed) left SQLite run_status=running forever when
    the LangGraph thread was already gone (media employee sticky case).
    """
    from app.gateway import run_status_reconcile as mod

    mod.invalidate_runs_probe_cache()

    client = MagicMock()
    resp = MagicMock()
    resp.status_code = 404
    client.get = AsyncMock(return_value=resp)

    active = asyncio.run(
        mod._langgraph_has_active_run(
            client,
            "missing-thread-id",
            run_id="dead-run",
        )
    )
    assert active is False


def test_reconcile_clears_when_thread_404() -> None:
    from app.gateway import run_status_reconcile as mod

    mod.invalidate_runs_probe_cache()
    client = MagicMock()
    resp = MagicMock()
    resp.status_code = 404
    client.get = AsyncMock(return_value=resp)

    with (
        patch.object(mod, "_thread_has_active_proxy", return_value=False),
        patch.object(mod, "_collab_phase_is_active", return_value=False),
        patch.object(mod, "force_end_session_turn") as force_end,
        patch.object(mod, "_invalidate_active_sessions_cache"),
    ):

        async def _run() -> str:
            return await mod.reconcile_session_run_row(
                client,
                session_key="proactive:media-short-video-copy:task:dead",
                thread_id="missing-thread-id",
                run_id="dead-run",
            )

        action = asyncio.run(_run())

    assert action == "cleared"
    force_end.assert_called_once()
    assert force_end.call_args.kwargs.get("session_key") == (
        "proactive:media-short-video-copy:task:dead"
    )
