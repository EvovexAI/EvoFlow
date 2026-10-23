"""Skill/plugin injection must sit after the triggering user message, not at list end."""

from __future__ import annotations

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from evoflow.agents.middlewares.skills_injection_middleware import (
    _PLUGIN_INJECTION_MESSAGE_NAME,
    _SKILL_INJECTION_MESSAGE_NAME,
    _latest_human_preview,
    _latest_real_human_index,
    place_injections_after_latest_user,
)


def test_latest_human_skips_injection_rows():
    messages = [
        HumanMessage(content="hello"),
        HumanMessage(content="skill body", name=_SKILL_INJECTION_MESSAGE_NAME),
        HumanMessage(content="<plugin_injection>…</plugin_injection>", name=_PLUGIN_INJECTION_MESSAGE_NAME),
    ]
    assert _latest_human_preview(messages) == "hello"
    assert _latest_real_human_index(messages) == 0


def test_place_plugin_after_user_before_tools():
    """Old bug: plugin was appended after tools; re-place must move it after user."""
    user = HumanMessage(content="打开百度")
    ai = AIMessage(content="", tool_calls=[{"id": "c1", "name": "js", "args": {}}])
    tool = ToolMessage(content="tabs ok", tool_call_id="c1")
    plugin = HumanMessage(
        content="<plugin_injection>browser</plugin_injection>",
        name=_PLUGIN_INJECTION_MESSAGE_NAME,
    )

    out = place_injections_after_latest_user([user, ai, tool], [plugin])

    assert [type(m).__name__ for m in out] == [
        "HumanMessage",
        "HumanMessage",
        "AIMessage",
        "ToolMessage",
    ]
    assert out[0].content == "打开百度"
    assert getattr(out[1], "name", None) == _PLUGIN_INJECTION_MESSAGE_NAME
    assert out[-1].content == "tabs ok"


def test_place_replaces_stale_end_append():
    user = HumanMessage(content="q")
    ai = AIMessage(content="thinking")
    stale = HumanMessage(content="old plugin", name=_PLUGIN_INJECTION_MESSAGE_NAME)
    fresh = HumanMessage(content="new plugin", name=_PLUGIN_INJECTION_MESSAGE_NAME)

    out = place_injections_after_latest_user([user, ai, stale], [fresh])
    names = [getattr(m, "name", None) for m in out]
    assert names.count(_PLUGIN_INJECTION_MESSAGE_NAME) == 1
    assert out[1].content == "new plugin"
    assert out[2].content == "thinking"


def test_place_skill_then_plugin_block_after_user():
    user = HumanMessage(content="用浏览器测一下")
    ai = AIMessage(content="ok")
    skill = HumanMessage(content="skill body", name=_SKILL_INJECTION_MESSAGE_NAME)
    plugin = HumanMessage(content="plugin body", name=_PLUGIN_INJECTION_MESSAGE_NAME)

    out = place_injections_after_latest_user([user, ai], [skill, plugin])

    assert getattr(out[1], "name", None) == _SKILL_INJECTION_MESSAGE_NAME
    assert getattr(out[2], "name", None) == _PLUGIN_INJECTION_MESSAGE_NAME
    assert out[3].content == "ok"
