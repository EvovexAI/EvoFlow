"""Pydantic models for the per-thread session knowledge graph."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

NodeKind = Literal[
    "file",
    "symbol",
    "module",
    "flow",
    "gap",
    "note",
    "hypothesis",
    "doc",
    "section",
    "claim",
    "source",
    "task",
    "decision",
    "diagram",
    "goal",
]

EdgeRel = Literal[
    "calls",
    "imports",
    "reads",
    "writes",
    "depends",
    "contains",
    "cites",
    "supports",
    "contradicts",
    "derived_from",
]

MindMapOpName = Literal[
    "upsert_node",
    "patch_node",
    "delete_node",
    "upsert_edge",
    "delete_edge",
    "set_goal",
]


class ExplorationGraphHeader(BaseModel):
    thread_id: str
    session_key: str | None = None
    graph_version: int = 0
    active_turn_id: str = ""
    node_count: int = 0
    edge_count: int = 0
    render_summary: str = ""
    goal: str = ""
    created_at: str = ""
    updated_at: str = ""


class ExplorationNode(BaseModel):
    id: int | None = None
    thread_id: str = ""
    external_id: str
    kind: str = "note"
    parent_external_id: str | None = None
    title: str = ""
    body: str = ""
    status: str = "active"
    refs: list[str] = Field(default_factory=list)
    meta: dict[str, Any] = Field(default_factory=dict)
    source_tool: str = ""
    source_tool_call_id: str = ""
    turn_id: str = ""
    sort_order: int = 0
    graph_version: int = 0
    created_at: str = ""
    updated_at: str = ""


class ExplorationEdge(BaseModel):
    id: int | None = None
    thread_id: str = ""
    external_id: str
    from_external_id: str
    to_external_id: str
    rel: str = "depends"
    label: str = ""
    status: str = "active"
    source_tool_call_id: str = ""
    graph_version: int = 0
    created_at: str = ""
    updated_at: str = ""


class MindMapOp(BaseModel):
    """Single incremental op from model tool args (stripped before tool execution)."""

    model_config = ConfigDict(extra="ignore", populate_by_name=True)

    op: MindMapOpName
    id: str = Field(default="")
    kind: str = "note"
    parent: str | None = Field(default=None, validation_alias="parent_external_id")
    title: str = ""
    body: str = ""
    append_body: str = ""
    status: str | None = None
    diagram_type: str = ""
    refs: list[str] = Field(default_factory=list)
    meta: dict[str, Any] = Field(default_factory=dict)
    sort_order: int | None = None
    from_id: str | None = Field(default=None, alias="from")
    to_id: str | None = Field(default=None, alias="to")
    rel: str = "depends"
    label: str = ""

    @field_validator("id", mode="before")
    @classmethod
    def _strip_id(cls, value: Any) -> str:
        return str(value or "").strip()

    @field_validator("id", mode="after")
    @classmethod
    def _require_id_except_set_goal(cls, value: str, info: Any) -> str:
        op = str((info.data or {}).get("op") or "").strip()
        if op == "set_goal":
            return value or "goal:session"
        # upsert_edge / delete_edge: id 可省略，由 from+rel+to 派生（仓库层处理）
        if op in {"upsert_edge", "delete_edge"}:
            return value
        if not str(value or "").strip():
            raise ValueError("id is required")
        return value

    @model_validator(mode="after")
    def _set_goal_requires_text(self) -> MindMapOp:
        if self.op == "set_goal" and not str(self.title or self.body or "").strip():
            raise ValueError("set_goal requires title or body")
        return self


class OpApplyRecord(BaseModel):
    op_index: int
    op: str
    target_external_id: str
    apply_status: Literal["ok", "rejected", "partial"] = "ok"
    error_message: str = ""


class ApplyOpsResult(BaseModel):
    scope_thread_id: str
    graph_version: int
    applied: list[OpApplyRecord] = Field(default_factory=list)
    node_count: int = 0
    edge_count: int = 0
