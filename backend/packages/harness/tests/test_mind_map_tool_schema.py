"""Standalone mind_map tool schema (no bundled mind_map_ops on other tools)."""

from __future__ import annotations

from langchain.tools import tool

from evoflow.exploration_graph.tool_schema import augment_tool_for_mind_map_ops
from evoflow.tools.builtins.mind_map_tool import mind_map_tool


@tool
def sample_read(path: str, offset: int | None = None) -> str:
    """Read a file."""
    return path


def test_augment_tool_is_noop() -> None:
    patched = augment_tool_for_mind_map_ops(sample_read)
    assert patched is sample_read
    schema = patched.args_schema.model_json_schema()
    assert "mind_map_ops" not in (schema.get("properties") or {})


def test_mind_map_tool_has_ops_param() -> None:
    schema = mind_map_tool.tool_call_schema.model_json_schema()
    assert "ops" in (schema.get("properties") or {})
    assert "ops" in (schema.get("required") or [])


def test_mind_map_tool_description_includes_policy() -> None:
    desc = str(getattr(mind_map_tool, "description", "") or "")
    assert "set_goal" in desc
    assert "append_body" in desc
    assert "claim:" in desc
    assert len(desc) < 2800
