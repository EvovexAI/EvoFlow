"""``<think>`` 内联 CoT 不得进正文。"""

from __future__ import annotations

from evoflow.models.think_tags import merge_reasoning, strip_inline_think_tags


def test_strip_complete_think_block() -> None:
    body, reasoning = strip_inline_think_tags(
        "<think>\n上一轮还在验收重启\n</think>\n\n好的，我来优化。"
    )
    # 标签后的换行必须保留（流式 delta 靠它撑起 markdown 块结构）。
    assert body == "\n\n好的，我来优化。"
    assert reasoning is not None
    assert "验收重启" in reasoning


def test_strip_unclosed_think_from_visible_body() -> None:
    body, reasoning = strip_inline_think_tags("<think>\n还在想")
    assert body == ""
    assert reasoning == "还在想"


def test_strip_preserves_newline_only_delta() -> None:
    body, reasoning = strip_inline_think_tags("\n\n")
    assert body == "\n\n"
    assert reasoning is None


def test_strip_preserves_leading_newlines_before_heading() -> None:
    raw = "\n\n## 1. 一句话结论"
    body, reasoning = strip_inline_think_tags(raw)
    assert body == raw
    assert reasoning is None


def test_merge_reasoning_dedupes() -> None:
    assert merge_reasoning("a", "a", "b") == "a\n\nb"
