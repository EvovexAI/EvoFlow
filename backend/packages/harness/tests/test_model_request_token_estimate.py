"""Tests for wire-format model request token estimation."""

from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Literal

from langchain.tools import tool
from langchain_core.utils.function_calling import convert_to_openai_tool
from pydantic import BaseModel

from evoflow.context.compaction_token_utils import count_text_tokens, warm_token_encodings
from evoflow.context.model_request_token_estimate import (
    estimate_bound_tools_tokens,
    estimate_model_call_overhead,
    wire_openai_tool_spec,
)

# Accurate wire-token ratios need a ready encoder (hot path no longer sync-loads).
warm_token_encodings()


class _MindMapOp(BaseModel):
    op: Literal["add_node", "patch_node", "link"]
    id: str
    body: str | None = None
    target: str | None = None


@tool(args_schema=_MindMapOp)
def _complex_tool(ops: list[dict]) -> str:
    """Maintain a session mind map with structured graph operations."""
    return "ok"


@tool
def _sample_nested_tool(path: str, offset: int | None = None, limit: int = 100) -> str:
    """Read part of a file with optional offset."""
    return path


def _legacy_pydantic_tool_tokens(tool) -> int:
    schema = tool.tool_call_schema.model_json_schema()
    blob = json.dumps(schema, ensure_ascii=False, default=str)
    return count_text_tokens(blob)


def test_wire_openai_tool_spec_matches_langchain_converter() -> None:
    spec = wire_openai_tool_spec(_sample_nested_tool)
    expected = convert_to_openai_tool(_sample_nested_tool)
    assert spec == expected
    assert spec["type"] == "function"
    assert spec["function"]["name"] == _sample_nested_tool.name


def test_wire_format_smaller_than_pydantic_json_schema() -> None:
    wire_tokens, _ = estimate_bound_tools_tokens([_complex_tool])
    legacy = _legacy_pydantic_tool_tokens(_complex_tool)
    assert wire_tokens < legacy


def test_many_tools_wire_estimate_much_lower_than_legacy_sum() -> None:
    """Regression: 21 tools × inflated Pydantic schema was ~2× provider truth."""
    tools = [_complex_tool] * 21
    wire_tokens, count = estimate_bound_tools_tokens(tools)
    legacy_sum = sum(_legacy_pydantic_tool_tokens(t) for t in tools)
    assert count == 21
    assert wire_tokens < legacy_sum * 0.75


def test_estimate_bound_tools_counts_array_not_per_tool_defs() -> None:
    tools = [_sample_nested_tool, _complex_tool]
    combined, count = estimate_bound_tools_tokens(tools)
    assert count == 2
    specs = [wire_openai_tool_spec(t) for t in tools]
    blob = json.dumps(specs, ensure_ascii=False, separators=(",", ":"), default=str)
    assert combined >= count_text_tokens(blob)


def test_estimate_model_call_overhead_splits_system_and_tools() -> None:
    request = SimpleNamespace(
        system_message=SimpleNamespace(content="You are a helpful agent."),
        tools=[_sample_nested_tool, _complex_tool],
    )
    est = estimate_model_call_overhead(request, model="deepseek-v4-flash")
    assert est.tool_count == 2
    assert est.system_tokens > 0
    assert est.tools_tokens > 0
    assert est.total == est.system_tokens + est.tools_tokens


def test_openai_function_dict_passthrough() -> None:
    raw = {
        "type": "function",
        "function": {
            "name": "ping",
            "description": "Ping",
            "parameters": {"type": "object", "properties": {"x": {"type": "string"}}},
        },
    }
    assert wire_openai_tool_spec(raw) == raw
    tokens, count = estimate_bound_tools_tokens([raw])
    assert count == 1
    assert tokens > 0
