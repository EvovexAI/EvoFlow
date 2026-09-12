"""Tests for hosted goal text-only reply interpreter."""

from __future__ import annotations

from evoflow.agents.goal.goal_reply_interpreter import GoalReplyVerdict, _parse_verdict_json
from evoflow.agents.goal.goal_runtime import clip_goal_summary_text


def test_parse_verdict_json_complete() -> None:
    parsed = _parse_verdict_json(
        '{"verdict":"complete","summary":"模块 A 已完成","reason":"目标达成"}'
    )
    assert parsed is not None
    assert parsed.verdict == "complete"
    assert parsed.summary == "模块 A 已完成"


def test_parse_verdict_json_wait_user_maps_to_continue() -> None:
    parsed = _parse_verdict_json(
        '说明文字 {"verdict":"wait_user","question":"请确认部署环境？","reason":"缺输入"}'
    )
    assert parsed is not None
    assert parsed.verdict == "continue"
    assert parsed.summary == "请确认部署环境？"


def test_parse_verdict_json_invalid() -> None:
    assert _parse_verdict_json("not json") is None
    assert _parse_verdict_json('{"verdict":"maybe"}') is None


def test_goal_reply_verdict_frozen() -> None:
    v = GoalReplyVerdict(verdict="continue", reason="still working")
    assert v.verdict == "continue"


def test_clip_goal_summary_strips_interpreter_noise() -> None:
    raw = (
        '[Turn] 1 / 8\n'
        '[Assistant reply]\n'
        '搞定了。\n'
        '{"verdict":"wait_user","summary":"已去掉竖线","question":"刷新后确认"}'
    )
    cleaned = clip_goal_summary_text(raw)
    assert "verdict" not in cleaned
    assert "[Turn]" not in cleaned
    assert "搞定了" in cleaned
