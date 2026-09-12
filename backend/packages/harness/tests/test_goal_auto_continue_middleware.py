"""Tests for single-run hosted goal auto-continue middleware."""

from __future__ import annotations

import pytest
from langchain_core.messages import AIMessage, HumanMessage

from evoflow.agents.goal.goal_auto_continue_middleware import GoalAutoContinueMiddleware
from evoflow.agents.goal.goal_reply_interpreter import GoalReplyVerdict


def _mock_interpreter(monkeypatch: pytest.MonkeyPatch, verdict: GoalReplyVerdict) -> None:
    monkeypatch.setattr(
        "evoflow.agents.goal.goal_auto_continue_middleware.interpret_goal_reply_sync",
        lambda **_kwargs: verdict,
    )


def _runtime(*, session_key: str = "agent:main:sk1", goal_mode: bool = True):
    class _Rt:
        context = {
            "session_key": session_key,
            "goal_mode": goal_mode,
        }

    return _Rt()


def test_auto_continue_jumps_to_model(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "evoflow.agents.goal.goal_auto_continue_middleware.load_goal_row",
        lambda sk: {
            "enabled": True,
            "goal_status": "active",
            "status": "running",
            "continuation_suppressed": False,
            "prompt": "完成模块 A",
            "max_steps": 8,
        },
    )
    patched: list[dict] = []

    def _patch(sk: str, **fields: object) -> None:
        patched.append({"sk": sk, **fields})

    monkeypatch.setattr(
        "evoflow.agents.goal.goal_auto_continue_middleware.patch_goal_state",
        _patch,
    )
    _mock_interpreter(monkeypatch, GoalReplyVerdict(verdict="continue", reason="still working"))

    mw = GoalAutoContinueMiddleware()
    out = mw.after_model(
        {"messages": [HumanMessage(content="目标"), AIMessage(content="第一步完成")]},
        _runtime(),
    )
    assert out is not None
    assert out.get("jump_to") == "model"
    # Architecture: continue path stores nudge via set_pending_goal_nudge;
    # GoalContinuationAssemblerMiddleware injects the synthetic user at model
    # invoke time. The return dict does NOT carry messages directly.
    from evoflow.agents.goal.goal_runtime import peek_pending_goal_nudge

    nudge = peek_pending_goal_nudge("agent:main:sk1")
    assert nudge, "continue verdict should have stored a pending nudge"


def test_auto_continue_stops_on_completed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "evoflow.agents.goal.goal_auto_continue_middleware.load_goal_row",
        lambda sk: {
            "enabled": True,
            "goal_status": "active",
            "status": "running",
            "continuation_suppressed": False,
            "prompt": "完成模块 A",
            "max_steps": 8,
        },
    )
    patched: list[dict] = []

    def _patch(sk: str, **fields: object) -> None:
        patched.append({"sk": sk, **fields})

    monkeypatch.setattr(
        "evoflow.agents.goal.goal_auto_continue_middleware.patch_goal_state",
        _patch,
    )
    _mock_interpreter(
        monkeypatch,
        GoalReplyVerdict(verdict="complete", summary="目标达成", reason="done"),
    )
    # Mock force_end_session_turn to verify session run_status is updated on complete
    ended_calls: list[dict] = []

    def _force_end(*, session_key=None, **kw):
        ended_calls.append({"session_key": session_key, **kw})
        return True

    monkeypatch.setattr(
        "evoflow.session_execution.lifecycle.force_end_session_turn",
        _force_end,
    )

    mw = GoalAutoContinueMiddleware()
    out = mw.after_model(
        {
            "messages": [
                HumanMessage(content="目标"),
                AIMessage(content="全部完成，目标已达成"),
            ]
        },
        _runtime(),
    )
    assert out == {"jump_to": "end"}
    assert patched and patched[-1].get("goal_status") == "completed"
    # Goal complete must also update session table run_status
    assert len(ended_calls) == 1
    assert ended_calls[0]["session_key"] == "agent:main:sk1"


def test_auto_continue_stops_on_empty_reply(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "evoflow.agents.goal.goal_auto_continue_middleware.load_goal_row",
        lambda sk: {
            "goal_status": "active",
            "status": "running",
            "continuation_suppressed": False,
            "prompt": "完成模块 A",
            "max_steps": 8,
            "step_count": 1,
        },
    )
    patched: list[dict] = []

    def _patch(sk: str, **fields: object) -> None:
        patched.append({"sk": sk, **fields})

    monkeypatch.setattr(
        "evoflow.agents.goal.goal_auto_continue_middleware.patch_goal_state",
        _patch,
    )

    mw = GoalAutoContinueMiddleware()
    out = mw.after_model(
        {"messages": [HumanMessage(content="目标"), AIMessage(content="")]},
        _runtime(),
    )
    assert out == {"jump_to": "end"}
    assert patched
    assert patched[-1].get("status") == "paused"
    assert "空回复" in str(patched[-1].get("last_error") or "")


def test_auto_continue_continues_on_wait_user_verdict(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "evoflow.agents.goal.goal_auto_continue_middleware.load_goal_row",
        lambda sk: {
            "enabled": True,
            "goal_status": "active",
            "status": "running",
            "continuation_suppressed": False,
            "prompt": "10 个 AI 问题",
            "max_steps": 8,
        },
    )
    patched: list[dict] = []

    def _patch(sk: str, **fields: object) -> None:
        patched.append({"sk": sk, **fields})

    monkeypatch.setattr(
        "evoflow.agents.goal.goal_auto_continue_middleware.patch_goal_state",
        _patch,
    )

    _mock_interpreter(
        monkeypatch,
        GoalReplyVerdict(verdict="continue", question="请确认方案", reason="legacy_wait_user_mapped_to_continue"),
    )

    mw = GoalAutoContinueMiddleware()
    out = mw.after_model(
        {
            "messages": [
                HumanMessage(content="目标"),
                AIMessage(content="需要您确认部署方案后才能继续"),
            ]
        },
        _runtime(),
    )
    assert out is not None
    assert out.get("jump_to") == "model"
    assert patched
    assert patched[-1].get("status") == "running"
    assert patched[-1].get("pending_feedback") is not True


def test_auto_continue_infers_goal_mode_from_db_waiting(monkeypatch: pytest.MonkeyPatch) -> None:
    row = {
        "goal_status": "active",
        "status": "running",
        "continuation_suppressed": False,
        "prompt": "完成模块 A",
        "max_steps": 8,
    }
    monkeypatch.setattr(
        "evoflow.agents.goal.goal_auto_continue_middleware.load_goal_row",
        lambda sk: row,
    )
    monkeypatch.setattr(
        "evoflow.agents.goal.goal_runtime.load_goal_row",
        lambda sk: row,
    )
    monkeypatch.setattr(
        "evoflow.agents.goal.goal_auto_continue_middleware.patch_goal_state",
        lambda sk, **fields: None,
    )
    _mock_interpreter(monkeypatch, GoalReplyVerdict(verdict="continue", reason="still working"))

    mw = GoalAutoContinueMiddleware()
    out = mw.after_model(
        {"messages": [HumanMessage(content="目标"), AIMessage(content="第一步完成")]},
        _runtime(goal_mode=False),
    )
    assert out is not None
    assert out.get("jump_to") == "model"


def test_auto_continue_skips_when_tool_calls_pending() -> None:
    mw = GoalAutoContinueMiddleware()
    out = mw.after_model(
        {"messages": [AIMessage(content="", tool_calls=[{"id": "1", "name": "bash", "args": {}}])]},
        _runtime(),
    )
    assert out is None
