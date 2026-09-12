"""Legacy asset tools must not appear on the LLM tool surface."""

from __future__ import annotations


def test_memory_remember_retired_from_builtin_tools() -> None:
    from evoflow.tools.tools import BUILTIN_TOOLS, REMOVED_LEGACY_TOOL_NAMES

    names = {str(getattr(t, "name", "") or "").strip().lower() for t in BUILTIN_TOOLS}
    assert "assets" in names
    assert "memory_remember" not in names
    assert "person_memory_edit" not in names
    assert "memory_remember" in REMOVED_LEGACY_TOOL_NAMES
    assert "person_memory_edit" in REMOVED_LEGACY_TOOL_NAMES


def test_legacy_memory_tool_names_alias_to_assets() -> None:
    from evoflow.tools.tool_aliases import canonical_tool_name

    assert canonical_tool_name("memory_remember") == "assets"
    assert canonical_tool_name("person_memory_edit") == "assets"
    assert canonical_tool_name("experience_save") == "assets"
