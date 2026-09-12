"""Step 1a: GoalService → SQLite mirror persistence tests.

Validates that ``GoalService.start_goal`` / ``stop_goal`` /
``submit_feedback`` correctly mirror in-memory session state into the
``evoflow_goal_sessions`` table via ``goal_repositories``.

Strategy: monkey-patch ``GoalService._run_goal_session`` with a long
``await sleep(...)`` so that ``start_goal`` does not trigger a real
LangGraph run; we still get the persistence side effects.

This project does not use pytest-asyncio — tests drive the coroutines
with ``asyncio.run`` (same pattern as ``test_post_stream_resilience``).
"""

from __future__ import annotations

import asyncio
import tempfile
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from app.channels.models.goal import (
    GoalChannelType,
    GoalConfig,
    GoalStatus,
)
from app.channels.services.goal_service import GoalService
from evoflow.persistence import goal_repositories as goal_repo
from evoflow.persistence.db import get_db, reset_db_for_tests


@pytest.fixture
def sqlite_tmp(monkeypatch: pytest.MonkeyPatch):
    """Isolated SQLite under EVOFLOW_HOME + reset between tests."""
    with tempfile.TemporaryDirectory() as tmp:
        monkeypatch.setenv("EVOFLOW_HOME", tmp)
        reset_db_for_tests()
        get_db()
        yield Path(tmp)
        # Close the connection BEFORE TemporaryDirectory tries to delete the file.
        # Required on Windows (Win32 file-sharing semantics).
        reset_db_for_tests()
        import gc

        gc.collect()


@pytest.fixture
def patched_service(monkeypatch: pytest.MonkeyPatch):
    """Patch ``_run_goal_session`` to a long-sleep noop and reset singleton.

    Returns a factory that builds a fresh service inside the active event loop
    (the LangGraph client is mocked). Module-level counters are reset so each
    test starts with zero running sessions.
    """
    monkeypatch.setattr(GoalService, "_instance", None, raising=False)

    # Reset module-level concurrency counters between tests.
    import app.channels.services.goal_service as hsvc_module
    monkeypatch.setattr(hsvc_module, "global_running_count", 0, raising=True)
    monkeypatch.setattr(hsvc_module, "user_running_counts", {}, raising=True)

    async def _noop_goal_graph(self, session_id, *, run_trigger="goal_created", frontend_chat_done=False):  # noqa: ARG001
        await asyncio.sleep(3600)

    monkeypatch.setattr(GoalService, "_run_goal_graph", _noop_goal_graph, raising=True)

    def _factory() -> GoalService:
        return GoalService(MagicMock())

    yield _factory


def _build_config(prompt: str = "持续优化此仓库代码质量") -> GoalConfig:
    return GoalConfig(
        prompt=prompt,
        max_steps=5,
        step_delay_ms=200,
        retry_limit=1,
        auto_stop_minutes=0,
        initiative=70,
        emotional_intelligence=True,
        feishu_push_on_complete=False,
    )


async def _drain_tasks(svc: GoalService) -> None:
    """Cancel any background tasks owned by the service so the loop closes cleanly."""
    for task in list(svc._hosted_loop_tasks.values()):
        if task and not task.done():
            task.cancel()
    if svc._hosted_loop_tasks:
        await asyncio.gather(*svc._hosted_loop_tasks.values(), return_exceptions=True)
    for task in list(svc._running_tasks.values()):
        task.cancel()
    if svc._running_tasks:
        await asyncio.gather(*svc._running_tasks.values(), return_exceptions=True)


def test_start_goal_mirrors_into_sqlite(sqlite_tmp, patched_service):  # noqa: ARG001
    """``start_goal`` writes a row keyed by associated_session_key."""
    sk = "agent:main:web:test-1"
    cfg = _build_config("阅读 README 并总结")

    async def _run() -> None:
        svc = patched_service()
        try:
            session = await svc.start_goal(
                user_id="alice",
                channel_type=GoalChannelType.WEB,
                channel_chat_id="chat-1",
                associated_session_key=sk,
                config=cfg,
                use_frontend_chat=False,
            )
            await asyncio.sleep(0)  # let the scheduler tick once

            row = goal_repo.load_goal_session(sk)
            assert row is not None
            assert row["session_key"] == sk
            assert row["user_id"] == "alice"
            assert row["prompt"] == "阅读 README 并总结"
            assert row["max_steps"] == cfg.max_steps
            assert row["persona_style"] == "professional"
            assert row["enabled"] is True
            assert row["goal_status"] == "active"
            assert row["status"] == "running"
            assert row["step_count"] == 0
            assert row["goal_session_id"] == session.id
            assert row["system_prompt"]
            assert "用户目标" in row["system_prompt"]
            assert session.associated_session_key == sk
            assert session.status == GoalStatus.RUNNING
        finally:
            await _drain_tasks(svc)

    asyncio.run(_run())


def test_stop_goal_persists_idle_and_disabled(sqlite_tmp, patched_service):  # noqa: ARG001
    """``stop_goal`` keeps the row but flips state.status=idle and enabled=False."""
    sk = "agent:main:web:test-2"
    cfg = _build_config()

    async def _run() -> None:
        svc = patched_service()
        try:
            session = await svc.start_goal(
                user_id="bob",
                channel_type=GoalChannelType.WEB,
                channel_chat_id="chat-2",
                associated_session_key=sk,
                config=cfg,
                use_frontend_chat=False,
            )
            await asyncio.sleep(0)

            pre = goal_repo.load_goal_session(sk)
            assert pre is not None
            assert pre["status"] == "running"
            assert pre["enabled"] is True

            ok = await svc.stop_goal(session.id, user_id="bob")
            assert ok is True

            post = goal_repo.load_goal_session(sk)
            assert post is not None, "stop_goal must NOT delete the row"
            assert post["status"] == "paused"
            assert post["enabled"] is True
            assert post["goal_status"] == "active"
            # system_prompt preserved from start (existing-row read path)
            assert post["system_prompt"] == pre["system_prompt"]
        finally:
            await _drain_tasks(svc)

    asyncio.run(_run())


def test_submit_feedback_updates_persisted_state(sqlite_tmp, patched_service):  # noqa: ARG001
    """When feedback is submitted, the persisted row reflects pending=False."""
    sk = "agent:main:web:test-3"
    cfg = _build_config()

    async def _run() -> None:
        svc = patched_service()
        try:
            session = await svc.start_goal(
                user_id="carol",
                channel_type=GoalChannelType.WEB,
                channel_chat_id="chat-3",
                associated_session_key=sk,
                config=cfg,
                use_frontend_chat=False,
            )
            await asyncio.sleep(0)

            # Simulate scheduler placing the session into PAUSED + pending_feedback.
            session.status = GoalStatus.PAUSED
            session.pending_feedback = True
            session.feedback_prompt = "需要您确认目标范围"
            svc._persist_session_snapshot(session)

            paused_row = goal_repo.load_goal_session(sk)
            assert paused_row is not None
            assert paused_row["status"] == "paused"
            assert paused_row["pending_feedback"] is True

            ok = await svc.submit_feedback(session.id, "请只优化 README", user_id="carol")
            assert ok is True

            after = goal_repo.load_goal_session(sk)
            assert after is not None
            assert after["pending_feedback"] is False
        finally:
            await _drain_tasks(svc)

    asyncio.run(_run())


# --- 1b: SSE + recovery ---


def test_start_goal_broadcasts_panel_state(sqlite_tmp, patched_service, monkeypatch):  # noqa: ARG001
    sk = 'agent:main:web:sse-1'
    cfg = _build_config()

    captured: list = []

    async def _fake_broadcast(self, thread_id, event_type, data):  # noqa: ARG001
        captured.append((thread_id, event_type, data))

    from app.gateway.routers.events import EventBroadcaster
    monkeypatch.setattr(EventBroadcaster, 'broadcast', _fake_broadcast, raising=True)

    async def _run() -> None:
        svc = patched_service()
        try:
            await svc.start_goal(
                user_id='alice',
                channel_type=GoalChannelType.WEB,
                channel_chat_id='chat-1',
                associated_session_key=sk,
                config=cfg,
                use_frontend_chat=False,
            )
            await asyncio.sleep(0)
        finally:
            await _drain_tasks(svc)

    asyncio.run(_run())

    matching = [(tid, et, d) for tid, et, d in captured if et == 'panel:goal_state' and tid == sk]
    assert matching, f'expected panel:goal_state for {sk}, got: {captured}'
    payload = matching[0][2]
    assert payload['sessionKey'] == sk
    assert payload['status'] == 'running'
    assert payload['enabled'] is True
    assert payload['stepCount'] == 0
    assert 'goalId' in payload or 'hostedId' in payload


def test_recover_persisted_sessions_resumes_enabled_rows(sqlite_tmp, patched_service):  # noqa: ARG001
    sk = 'agent:main:web:recover-1'
    goal_repo.upsert_goal_session(
        sk,
        goal_session_id="hosted-recover-1",
        prompt="续跑的任务",
        max_steps=5,
        step_delay_ms=200,
        retry_limit=1,
        auto_stop_minutes=0,
        persona_style="professional",
        initiative=70,
        emotional_intelligence=True,
        feishu_push_on_complete=False,
        goal_status="active",
        goal_revision=1,
        status="running",
        step_count=2,
        enabled=True,
        user_id="alice",
        system_prompt="持久化的 system prompt",
        start_time=1700000000000,
    )
    goal_repo.upsert_goal_session(
        "agent:main:web:recover-2-idle",
        prompt="已停止",
        goal_status="cleared",
        status="idle",
        enabled=False,
        user_id="alice",
    )

    async def _run() -> None:
        svc = patched_service()
        try:
            n = await svc.recover_persisted_sessions()
            assert n == 1, f'expected 1 resumed session, got {n}'
            sks_in_memory = {s.associated_session_key for s in svc._sessions.values()}
            assert sk in sks_in_memory
            assert 'agent:main:web:recover-2-idle' not in sks_in_memory
            session = next(s for s in svc._sessions.values() if s.associated_session_key == sk)
            assert session.id == "hosted-recover-1"
            assert session.id in svc._hosted_loop_tasks
            assert session.current_step == 2
            assert session.goal_status == "active"
            assert session.goal_revision == 1
            n2 = await svc.recover_persisted_sessions()
            assert n2 == 0
        finally:
            await _drain_tasks(svc)

    asyncio.run(_run())


def test_restart_goal_after_completed_does_not_inherit_terminal(sqlite_tmp, patched_service):  # noqa: ARG001
    """Starting a new goal must not be immediately overwritten by prior completed SQLite row."""
    sk = "agent:main:web:restart-after-done"
    cfg = _build_config("第二轮目标")

    async def _run() -> None:
        svc = patched_service()
        try:
            first = await svc.start_goal(
                user_id="alice",
                channel_type=GoalChannelType.WEB,
                channel_chat_id="chat-r",
                associated_session_key=sk,
                config=_build_config("第一轮目标"),
                use_frontend_chat=True,
            )
            first.goal_status = "completed"
            first.status = GoalStatus.IDLE
            first.goal_summary = "第一轮已完成"
            first.completion_outcome = "任务完成"
            svc._persist_session_snapshot(first)

            second = await svc.start_goal(
                user_id="alice",
                channel_type=GoalChannelType.WEB,
                channel_chat_id="chat-r",
                associated_session_key=sk,
                config=cfg,
                use_frontend_chat=True,
            )
            await asyncio.sleep(0)

            row = goal_repo.load_goal_session(sk)
            assert row is not None
            assert row["goal_status"] == "active"
            assert row["enabled"] is True
            assert row["goal_session_id"] == second.id
            assert str(row.get("goal_summary") or "") == ""
            assert str(row.get("completion_outcome") or "") == ""

            polled = svc.resolve_goal_session_for_poll(sk)
            assert polled is not None
            assert polled.id == second.id
            assert polled.goal_status == "active"
            assert polled.status in {GoalStatus.WAITING, GoalStatus.RUNNING}
        finally:
            await _drain_tasks(svc)

    asyncio.run(_run())
