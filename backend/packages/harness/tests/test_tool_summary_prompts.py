"""Tool summary prompt building and field parsing."""

from __future__ import annotations

from evoflow.context.tool_summary_prompts import (
    build_single_tool_summary_prompt,
    fields_to_summary_body,
    parse_structured_summary_fields,
)


def test_build_prompt_includes_tool_family_hints():
    p = build_single_tool_summary_prompt("out", "bash", target_chars=500, input_cap=1000)
    assert "exit code" in p
    assert "bash" in p
    assert "500" in p


def test_parse_structured_fields():
    raw = """path: src/foo.py
lines: 12-40
status: success
core: 找到配置项 timeout=30
key_facts: 无报错; 共 29 行
refs: .evoflow/tool_results/abc.txt
"""
    f = parse_structured_summary_fields(raw)
    assert f["path"] == "src/foo.py"
    assert "timeout" in f["core"]
    body = fields_to_summary_body(f)
    assert "[success]" in body
    assert "timeout" in body


def test_parse_fallback_when_no_fields():
    f = parse_structured_summary_fields("仅一段自由文本结论")
    assert "自由文本" in f["core"]
