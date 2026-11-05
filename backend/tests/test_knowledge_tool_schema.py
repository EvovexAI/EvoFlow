"""knowledge tool must expose a model-facing JSON schema (no ToolRuntime leak)."""

from __future__ import annotations


def test_knowledge_tool_call_schema_excludes_runtime() -> None:
    from evoflow.tools.builtins.knowledge_tool import knowledge_tool

    schema = knowledge_tool.tool_call_schema.model_json_schema()
    props = schema.get("properties") or {}
    assert "runtime" not in props
    assert "action" in props
    assert "query" in props
    # Regression: Optional ToolRuntime | None broke schema with CallableSchema.
    assert schema.get("type") == "object"
