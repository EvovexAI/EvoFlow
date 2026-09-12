"""Community tools from config.yaml must survive SQLite tool sync."""

from __future__ import annotations

from evoflow.persistence.bootstrap import (
    _community_tools_from_yaml_dict,
    _merge_tool_docs_by_name,
)


def test_community_tools_extracted_from_yaml_dict() -> None:
    data = {
        "tools": [
            {"name": "read_file", "use": "evoflow.tools.host_direct.read_file:read_file_hd"},
            {"name": "media_image_generate", "use": "evoflow.community.media_generation.tools:media_image_generate_tool"},
        ]
    }
    community = _community_tools_from_yaml_dict(data)
    assert len(community) == 1
    assert community[0]["name"] == "media_image_generate"


def test_merge_tool_docs_preserves_community() -> None:
    yaml_community = [
        {
            "name": "media_image_generate",
            "use": "evoflow.community.media_generation.tools:media_image_generate_tool",
            "group": "media",
        }
    ]
    db = [{"name": "read_file", "use": "evoflow.tools.host_direct.read_file:read_file_hd", "group": "builtins"}]
    merged = _merge_tool_docs_by_name(db, yaml_community)
    names = {t["name"] for t in merged}
    assert "read_file" in names
    assert "media_image_generate" in names
    media = next(t for t in merged if t["name"] == "media_image_generate")
    assert media["use"].startswith("evoflow.community.")
