"""Duty full brief must not become a visible V4 userInput; beat stays the opener."""

from app.gateway.v4.agui_mirror import _is_hidden_duty_brief_user_text
from app.gateway.v4.hydration import (
    _is_hidden_context_user_tool_name,
    _is_hidden_duty_brief_text,
)


def test_duty_brief_tool_name_is_hidden_context():
    assert _is_hidden_context_user_tool_name("proactive_duty_brief")
    assert not _is_hidden_context_user_tool_name("proactive_duty_beat")
    assert not _is_hidden_context_user_tool_name("")


def test_duty_brief_text_sniff_matches_seeded_brief():
    brief = (
        "# 值班 · 「抖音拆解师」\n\n"
        "## 本轮行动\n"
        "对照职责与上方看板：有具体待办就推进；没有则结束本轮，不要空建单，也不要硬写「巡检完成」报告。\n"
    )
    assert _is_hidden_duty_brief_text(brief)
    assert _is_hidden_duty_brief_user_text(brief)


def test_duty_beat_text_is_not_treated_as_brief():
    beat = "对照职责巡检，有待办则推进并结案。"
    assert not _is_hidden_duty_brief_text(beat)
    assert not _is_hidden_duty_brief_user_text(beat)
    legacy = "本轮值班开始 · 抖音拆解师\n对照职责巡检，有待办则推进并结案。"
    assert not _is_hidden_duty_brief_text(legacy)
    assert not _is_hidden_duty_brief_user_text(legacy)
