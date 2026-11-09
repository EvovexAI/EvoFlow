"""Prompt-module token estimates must stick onto observability usage_json."""

from __future__ import annotations

from evoflow.context.model_request_token_estimate import (
    reset_gate_overhead_meta,
    set_gate_overhead_meta,
)
from evoflow.observability.compaction_run_context import merge_compaction_into_usage


def test_merge_attaches_prompt_overhead_for_main():
    tok = set_gate_overhead_meta(
        {
            "system_tokens": 1200,
            "tools_tokens": 800,
            "tool_count": 12,
            "system_skills_tokens": 400,
            "system_assets_tokens": 100,
            "system_memory_tokens": 50,
        }
    )
    try:
        out = merge_compaction_into_usage(
            {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15},
            invocation_kind="main",
        )
    finally:
        reset_gate_overhead_meta(tok)

    assert out is not None
    overhead = out.get("prompt_overhead")
    assert isinstance(overhead, dict)
    assert overhead["system_tokens"] == 1200
    assert overhead["system_skills_tokens"] == 400
    assert overhead["tools_tokens"] == 800


def test_merge_attaches_prompt_overhead_for_subagent():
    tok = set_gate_overhead_meta({"system_tokens": 90, "tools_tokens": 10, "tool_count": 1})
    try:
        out = merge_compaction_into_usage({"total_tokens": 1}, invocation_kind="subagent")
    finally:
        reset_gate_overhead_meta(tok)

    assert out is not None
    assert out["prompt_overhead"]["system_tokens"] == 90
