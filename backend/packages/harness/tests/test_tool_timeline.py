from evoflow.context.tool_timeline import format_tool_timeline_for_agent, search_tool_timeline


def test_search_tool_timeline_requires_thread():
    data = search_tool_timeline("")
    assert data["ok"] is False


def test_format_tool_timeline_empty():
    text = format_tool_timeline_for_agent({"ok": True, "items": [], "query": "x"})
    assert "No tool timeline" in text
