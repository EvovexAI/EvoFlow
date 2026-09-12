"""host_direct tools must produce OpenAI-compatible JSON schemas (no injected Callable)."""

from langchain_core.utils.function_calling import convert_to_openai_tool

from evoflow.tools.host_direct import HOST_DIRECT_TOOLS

_RUNTIME_TOOLS = frozenset(
    {
        "search_code_index",
    }
)


def test_host_direct_tools_openai_schema():
    for tool in HOST_DIRECT_TOOLS:
        schema = convert_to_openai_tool(tool)
        props = schema.get("function", {}).get("parameters", {}).get("properties", {})
        assert "runtime" not in props, f"{tool.name} must not expose runtime in schema"
        if tool.name in _RUNTIME_TOOLS:
            assert "path" in props or "query" in props
