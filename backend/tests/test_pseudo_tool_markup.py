"""Pseudo tool markup strip / materialize helpers."""

from langchain_core.messages import AIMessage

from evoflow.agents.middlewares.invalid_tool_call_middleware import (
    detect_pseudo_tool_markup,
    strip_pseudo_tool_markup_keep_prose,
    _materialize_pseudo_tool_error,
    _scrub_pseudo_markup_from_ai_content,
    _process_invalid_tool_calls,
)


def test_strip_keeps_prose_before_dsml():
    raw_fw = (
        "我先读取任务要求的文件，了解需要生成的内容。\n\n"
        "\uff5c\uff5cDSML\uff5c\uff5c invoke name=\"tasks\""
    )
    assert detect_pseudo_tool_markup(raw_fw)
    assert strip_pseudo_tool_markup_keep_prose(raw_fw) == "我先读取任务要求的文件，了解需要生成的内容。"


def test_materialize_preserves_prose():
    raw = "先看一眼看板。\n\n\uff5c\uff5cDSML\uff5c\uff5c invoke name=\"tasks\""
    ai = AIMessage(content=raw)
    out = _materialize_pseudo_tool_error(ai)
    assert out is not None
    updated, tool_msgs = out
    assert "先看一眼看板" in str(updated.content)
    assert "伪标签" in str(updated.content)
    assert tool_msgs and tool_msgs[0].status == "error"


def test_scrub_when_structured_tool_calls_present():
    raw = "准备执行。\n\n\uff5c\uff5cDSML\uff5c\uff5c invoke name=\"execute\""
    ai = AIMessage(
        content=raw,
        tool_calls=[{"id": "c1", "name": "execute", "args": {"command": "ls"}, "type": "tool_call"}],
    )
    scrubbed = _scrub_pseudo_markup_from_ai_content(ai)
    assert scrubbed is not None
    assert scrubbed.content == "准备执行。"
    result = _process_invalid_tool_calls({"messages": [ai]})
    assert result is not None
    assert result["messages"][-1].content == "准备执行。"
