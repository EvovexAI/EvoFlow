"""Capability discovery: map tools/list names + schemas to stable EvoFlow ops."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class DiscoveredCapabilities:
    """Resolved after MCP tools/list — no multi-name guessing at call time."""

    search_tool: str | None = None
    read_tool: str | None = None
    reindex_tool: str | None = None
    status_tool: str | None = None
    # write side
    write_note_tool: str | None = None
    append_tool: str | None = None
    patch_tool: str | None = None
    frontmatter_tool: str | None = None
    tags_tool: str | None = None
    get_note_tool: str | None = None
    schemas: dict[str, dict[str, Any]] = field(default_factory=dict)
    raw_names: list[str] = field(default_factory=list)
    missing_required: list[str] = field(default_factory=list)

    def require_search(self) -> str:
        if not self.search_tool:
            raise RuntimeError("search tool not discovered")
        return self.search_tool

    def require_read(self) -> str:
        if not self.read_tool:
            raise RuntimeError("read tool not discovered")
        return self.read_tool


_SEARCH_CANDIDATES = ("evo_kb_search", "search")
_READ_CANDIDATES = ("evo_kb_read", "read")
_REINDEX_CANDIDATES = ("evo_kb_reindex", "reindex")
_STATUS_CANDIDATES = ("evo_kb_status", "status")

_WRITE_MAP = {
    "write_note_tool": ("obsidian_write_note", "write_note"),
    "append_tool": ("obsidian_append_to_note", "append_to_note"),
    "patch_tool": ("obsidian_patch_note", "patch_note"),
    "frontmatter_tool": ("obsidian_manage_frontmatter", "manage_frontmatter"),
    "tags_tool": ("obsidian_manage_tags", "manage_tags"),
    "get_note_tool": ("obsidian_get_note", "get_note"),
}


def _pick(names: set[str], candidates: tuple[str, ...]) -> str | None:
    for c in candidates:
        if c in names:
            return c
    # suffix match (server__evo_kb_search)
    for n in names:
        base = n.split("__")[-1]
        if base in candidates:
            return n
        for c in candidates:
            if n.endswith("_" + c) or n.endswith(c):
                return n
    return None


def discover_from_tool_objects(tools: list[Any]) -> DiscoveredCapabilities:
    """Build capability map from langchain tool objects (name + args schema)."""
    by_name: dict[str, Any] = {}
    for t in tools:
        name = str(getattr(t, "name", "") or "").strip()
        if name:
            by_name[name] = t
    names = set(by_name.keys())
    caps = DiscoveredCapabilities(raw_names=sorted(names))
    caps.search_tool = _pick(names, _SEARCH_CANDIDATES)
    caps.read_tool = _pick(names, _READ_CANDIDATES)
    caps.reindex_tool = _pick(names, _REINDEX_CANDIDATES)
    caps.status_tool = _pick(names, _STATUS_CANDIDATES)
    for attr, cands in _WRITE_MAP.items():
        setattr(caps, attr, _pick(names, cands))

    for name, tool in by_name.items():
        schema: dict[str, Any] = {}
        mcp_schema = getattr(tool, "_mcp_input_schema", None)
        if isinstance(mcp_schema, dict) and mcp_schema:
            schema = mcp_schema
        else:
            args_schema = getattr(tool, "args_schema", None)
            if args_schema is not None:
                try:
                    schema = args_schema.model_json_schema()  # type: ignore[attr-defined]
                except Exception:
                    try:
                        schema = dict(getattr(args_schema, "schema", lambda: {})())
                    except Exception:
                        schema = {}
            if not schema:
                # LangChain StructuredTool often exposes .args as JSON-schema properties map
                args = getattr(tool, "args", None)
                if isinstance(args, dict) and args:
                    schema = {"type": "object", "properties": args}
        caps.schemas[name] = schema if isinstance(schema, dict) else {}

    required = []
    if not caps.search_tool:
        required.append("search")
    if not caps.read_tool:
        required.append("read")
    if not caps.reindex_tool:
        required.append("reindex")
    if not caps.status_tool:
        required.append("status")
    caps.missing_required = required
    return caps


def build_search_arguments(
    *,
    query: str,
    mode: str = "hybrid",
    top_k: int = 8,
    tags: list[str] | None = None,
    scopes: list[str] | None = None,
    threshold: float | None = None,
    rerank: bool = False,
    schema: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Map EvoFlow search request → OHS evo_kb_search inputSchema."""
    props = ((schema or {}).get("properties") or {}) if isinstance(schema, dict) else {}
    args: dict[str, Any] = {"query": query, "mode": mode, "limit": top_k, "rerank": bool(rerank)}
    if threshold is not None:
        args["threshold"] = threshold
    # Real OHS uses singular tag / scope (string or array)
    if tags:
        args["tag"] = tags if "tag" in props or not props else tags
        if "tags" in props:
            args["tags"] = tags
    if scopes:
        args["scope"] = scopes if len(scopes) != 1 else scopes[0]
        if "scopes" in props:
            args["scopes"] = scopes
    # Drop unknown keys when schema is known
    if props:
        args = {k: v for k, v in args.items() if k in props or k == "query"}
    return args


def build_related_graph_arguments(
    *,
    path: str,
    depth: int = 1,
    direction: str = "both",
    schema: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """OHS graph is search(path=..., related=true, depth=..., direction=...)."""
    props = ((schema or {}).get("properties") or {}) if isinstance(schema, dict) else {}
    args: dict[str, Any] = {
        "path": path,
        "related": True,
        "depth": depth,
        "direction": direction,
        "link_type": "wiki",
    }
    if props:
        args = {k: v for k, v in args.items() if k in props}
        # related/path must remain
        args["path"] = path
        args["related"] = True
    return args


def build_read_arguments(paths: list[str], *, related: bool = True, schema: dict[str, Any] | None = None) -> dict[str, Any]:
    props = ((schema or {}).get("properties") or {}) if isinstance(schema, dict) else {}
    args: dict[str, Any] = {"paths": paths, "related": related}
    if props and "paths" not in props and "path" in props and len(paths) == 1:
        args = {"path": paths[0], "related": related}
    if props:
        args = {k: v for k, v in args.items() if k in props}
    return args
