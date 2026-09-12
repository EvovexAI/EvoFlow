"""Tests for in-graph goal controller."""

from __future__ import annotations

import pytest

from evoflow.agents.goal.goal_controller import (
    evaluate_goal,
    goal_controller_node,
    parse_completed_reason,
    strip_completed_tag,
)


def test_evaluate_goal_suppressed_when_user_stopped() -> None:
    verdict = evaluate_goal(
        {
            "goal_status": "active",
            "continuation_suppressed": True,
            "current_step": 2,
        }
    )
    assert verdict == "suppressed"


def test_evaluate_goal_paused() -> None:
    assert evaluate_goal({"goal_status": "paused"}) == "pause"


@pytest.mark.asyncio
async def test_goal_controller_no_synthetic_on_suppressed() -> None:
    out = await goal_controller_node(
        {
            "goal_id": "g1",
            "goal_text": "完成商品模块",
            "goal_revision": 1,
            "current_step": 1,
            "goal_status": "active",
            "continuation_suppressed": True,
            "last_agent_reply": "已设计表结构",
        },
        {"configurable": {"max_run_minutes": 0}},
    )
    assert out.get("pending_continuation") is None
    assert out.get("run_status") == "stopped"


@pytest.mark.asyncio
async def test_goal_controller_eval_only_no_planner(monkeypatch: pytest.MonkeyPatch) -> None:
    async def _planner_should_not_run(*_a: object, **_k: object) -> str:
        raise AssertionError("planner should not run in eval_only mode")

    monkeypatch.setattr(
        "evoflow.agents.goal.goal_controller.call_goal_planner",
        _planner_should_not_run,
    )
    out = await goal_controller_node(
        {
            "goal_id": "g1",
            "goal_text": "完成商品模块",
            "goal_revision": 1,
            "current_step": 2,
            "goal_status": "active",
            "last_agent_reply": "仍在进行中",
            "single_lead_run": True,
        },
        {"configurable": {"max_run_minutes": 0, "single_lead_run": True}},
    )
    assert out.get("pending_continuation") is None
    assert out.get("status") == "continuing"


def test_completed_tag_parser() -> None:
    assert parse_completed_reason("<completed>目标达成</completed>", current_step=2) == "目标达成"
    assert strip_completed_tag("<completed>x</completed> tail") == "tail"
