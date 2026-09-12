"""Mind-map op schema types (used by the standalone ``mind_map`` tool)."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class MindMapOpItem(BaseModel):
    """One mind-map op (pick exactly one ``op`` per item)."""

    model_config = ConfigDict(extra="allow")

    op: Literal[
        "set_goal",
        "upsert_node",
        "patch_node",
        "delete_node",
        "upsert_edge",
        "delete_edge",
    ] = Field(..., description="Op: set_goal | upsert_node | patch_node | delete_* | upsert_edge.")
    id: str = Field(
        default="",
        description="Node/edge id with kind prefix (goal:/flow:/file:/fn:/gap:/claim:/diagram:). Edge id optional.",
    )
    kind: str = Field(default="note", description="Node kind for upsert_node (match id prefix).")
    parent: str | None = Field(default=None, description="Parent node id for upsert_node.")
    title: str = Field(default="", description="Short label (required for set_goal).")
    body: str = Field(default="", description="Concrete facts; patch_node overwrites when closing a branch.")
    append_body: str = Field(default="", description="patch_node: append finding without overwrite.")
    status: str = Field(
        default="",
        description="active|stale|parked|resolved|verified|refuted|blocked|collapsed.",
    )
    diagram_type: str = Field(default="", description="For kind=diagram: flowchart|sequence|state|…")
    from_id: str | None = Field(default=None, alias="from", description="Edge source id.")
    to_id: str | None = Field(default=None, alias="to", description="Edge target id.")
    rel: str = Field(
        default="depends",
        description="Edge rel: contains|reads|writes|depends|imports|calls|defines|…",
    )


def augment_tool_for_mind_map_ops(tool: Any) -> Any:
    """Legacy no-op — mind map uses standalone ``mind_map`` tool."""
    return tool


def augment_tools_for_mind_map_ops(tools: list[Any] | None) -> list[Any]:
    """Legacy no-op — mind map uses standalone ``mind_map`` tool."""
    return list(tools or [])
