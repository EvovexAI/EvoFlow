"""Tool search — deferred tool discovery at runtime.

Contains:
- DeferredToolRegistry: stores deferred tools and handles regex search
- tool_search: the LangChain tool the agent calls to discover deferred tools

The agent sees deferred tool names in <available-deferred-tools> but cannot
call them until it fetches their full schema via the tool_search tool.
Source-agnostic: no mention of MCP or tool origin.
"""

import contextvars
import json
import logging
import re
from dataclasses import dataclass
from typing import Self

from langchain.tools import BaseTool
from langchain_core.tools import tool
from langchain_core.utils.function_calling import convert_to_openai_function
from pydantic import BaseModel, Field, model_validator

logger = logging.getLogger(__name__)

MAX_RESULTS = 10  # Max tools returned per search


class ToolSearchInput(BaseModel):
    """Args for ``tool_search``. Models often confuse ``select:name`` with a ``select`` field."""

    query: str | None = Field(
        default=None,
        description=(
            'Search string. Prefer exact load: "select:<tool_name>" '
            '(e.g. "select:subagent" or "select:write,replace"). '
            "Also accepts keyword / +keyword forms."
        ),
    )
    select: str | None = Field(
        default=None,
        description=(
            'Shorthand alias → query="select:<names>". Pass name(s) only '
            '(e.g. "subagent" or "write,replace"). Prefer ``query`` when possible.'
        ),
    )

    @model_validator(mode="after")
    def _normalize_query(self) -> Self:
        q = (self.query or "").strip()
        s = (self.select or "").strip()
        if q:
            self.query = q
            return self
        if s:
            self.query = s if s.lower().startswith("select:") else f"select:{s}"
            return self
        raise ValueError(
            'Provide query (e.g. {"query":"select:subagent"}) or select (e.g. {"select":"subagent"}).'
        )


# ── Registry ──


@dataclass
class DeferredToolEntry:
    """Lightweight metadata for a deferred tool (no full schema in context)."""

    name: str
    description: str
    tool: BaseTool  # Full tool object, returned only on search match


class DeferredToolRegistry:
    """Registry of deferred tools, searchable by regex pattern."""

    def __init__(self):
        self._entries: list[DeferredToolEntry] = []

    def register(self, tool: BaseTool) -> None:
        self._entries.append(
            DeferredToolEntry(
                name=tool.name,
                description=tool.description or "",
                tool=tool,
            )
        )

    def search(self, query: str) -> list[BaseTool]:
        """Search deferred tools by regex pattern against name + description.

        Supports three query forms (aligned with Claude Code):
          - "select:name1,name2" — exact name match
          - "+keyword rest" — name must contain keyword, rank by rest
          - "keyword query" — regex match against name + description

        Returns:
            List of matched BaseTool objects (up to MAX_RESULTS).
        """
        if query.startswith("select:"):
            names = {n.strip().lower() for n in query[7:].split(",") if n.strip()}
            return [e.tool for e in self._entries if e.name.lower() in names][:MAX_RESULTS]

        if query.startswith("+"):
            parts = query[1:].split(None, 1)
            required = parts[0].lower()
            candidates = [e for e in self._entries if required in e.name.lower()]
            if len(parts) > 1:
                candidates.sort(
                    key=lambda e: _regex_score(parts[1], e),
                    reverse=True,
                )
            return [e.tool for e in candidates][:MAX_RESULTS]

        tokens = [t for t in re.split(r"\s+", query.strip()) if t]
        if len(tokens) > 1:
            first = tokens[0].lower()
            by_exact_name = [e for e in self._entries if e.name.lower() == first]
            if by_exact_name:
                return [e.tool for e in by_exact_name][:MAX_RESULTS]

            candidates: list[tuple[int, DeferredToolEntry]] = []
            for entry in self._entries:
                hay = f"{entry.name} {entry.description}".lower()
                if all(tok.lower() in hay for tok in tokens):
                    score = sum(3 if tok.lower() == entry.name.lower() else (2 if tok.lower() in entry.name.lower() else 1) for tok in tokens)
                    candidates.append((score, entry))
            if candidates:
                candidates.sort(key=lambda x: x[0], reverse=True)
                return [entry.tool for _, entry in candidates][:MAX_RESULTS]

        # Single-token exact name match (before regex — underscores are word chars in regex)
        if len(tokens) == 1:
            exact = [e.tool for e in self._entries if e.name.lower() == tokens[0].lower()]
            if exact:
                return exact[:MAX_RESULTS]

        # General regex search
        try:
            regex = re.compile(query, re.IGNORECASE)
        except re.error:
            regex = re.compile(re.escape(query), re.IGNORECASE)

        scored = []
        for entry in self._entries:
            searchable = f"{entry.name} {entry.description}"
            if regex.search(searchable):
                score = 2 if regex.search(entry.name) else 1
                scored.append((score, entry))

        scored.sort(key=lambda x: x[0], reverse=True)
        return [entry.tool for _, entry in scored][:MAX_RESULTS]

    @property
    def entries(self) -> list[DeferredToolEntry]:
        return list(self._entries)

    def __len__(self) -> int:
        return len(self._entries)


def _regex_score(pattern: str, entry: DeferredToolEntry) -> int:
    try:
        regex = re.compile(pattern, re.IGNORECASE)
    except re.error:
        regex = re.compile(re.escape(pattern), re.IGNORECASE)
    return len(regex.findall(f"{entry.name} {entry.description}"))


# ── Per-request registry (ContextVar) ──
#
# Using a ContextVar instead of a module-level global prevents concurrent
# requests from clobbering each other's registry.  In asyncio-based LangGraph
# each graph run executes in its own async context, so each request gets an
# independent registry value.  For synchronous tools run via
# loop.run_in_executor, Python copies the current context to the worker thread,
# so the ContextVar value is correctly inherited there too.

_registry_var: contextvars.ContextVar[DeferredToolRegistry | None] = contextvars.ContextVar("deferred_tool_registry", default=None)
_activated_tools_var: contextvars.ContextVar[set[str]] = contextvars.ContextVar("deferred_tool_activated_names", default=set())
_catalog_tools_var: contextvars.ContextVar[tuple[BaseTool, ...]] = contextvars.ContextVar("tool_search_catalog_tools", default=())
_bound_tool_names_var: contextvars.ContextVar[frozenset[str]] = contextvars.ContextVar("tool_search_bound_tool_names", default=frozenset())


def get_deferred_registry() -> DeferredToolRegistry | None:
    return _registry_var.get()


def set_deferred_registry(registry: DeferredToolRegistry) -> None:
    _registry_var.set(registry)


def reset_deferred_registry() -> None:
    """Reset the deferred registry for the current async context."""
    _registry_var.set(None)
    _activated_tools_var.set(set())
    _catalog_tools_var.set(())
    _bound_tool_names_var.set(frozenset())


def get_activated_deferred_tools() -> set[str]:
    return set(_activated_tools_var.get() or set())


def set_activated_deferred_tools(names: set[str] | list[str] | tuple[str, ...] | None) -> None:
    cleaned = {str(n or "").strip() for n in (names or set()) if str(n or "").strip()}
    _activated_tools_var.set(cleaned)


def set_tool_search_catalog(all_tools: list[BaseTool] | tuple[BaseTool, ...] | None, bound_names: set[str] | frozenset[str] | None) -> None:
    """Full native tool catalog + names already bound to the model this turn."""
    tools: list[BaseTool] = []
    for t in all_tools or []:
        n = str(getattr(t, "name", "") or "").strip()
        if n and n != "tool_search":
            tools.append(t)
    _catalog_tools_var.set(tuple(tools))
    _bound_tool_names_var.set(frozenset(str(n or "").strip() for n in (bound_names or set()) if str(n or "").strip()))


def get_bound_tool_names() -> frozenset[str]:
    return _bound_tool_names_var.get() or frozenset()


def _search_tool_list(query: str, tools: list[BaseTool] | tuple[BaseTool, ...]) -> list[BaseTool]:
    if not tools:
        return []
    reg = DeferredToolRegistry()
    for t in tools:
        reg.register(t)
    return reg.search(query)


def _search_catalog_tools(query: str) -> list[BaseTool]:
    return _search_tool_list(query, _catalog_tools_var.get() or ())


def _search_mcp_cache_fallback(query: str) -> list[BaseTool]:
    """Search MCP tools from the module-level cache (not ContextVar).

    The DeferredToolRegistry and _catalog_tools_var are ContextVars set during
    graph build (make_lead_agent). When LangGraph executes the graph, the
    ContextVar may not propagate to the execution context, leaving both empty.
    peek_cached_mcp_tools() reads a process-level cache that survives context
    boundaries, ensuring MCP tools remain discoverable via tool_search.
    """
    try:
        from evoflow.mcp.cache import peek_cached_mcp_tools

        mcp_tools = peek_cached_mcp_tools()
        if not mcp_tools:
            return []
        return _search_tool_list(query, mcp_tools)
    except Exception:
        return []


# ── Tool ──


def _resolve_tool_search_query(query: str | None, select: str | None) -> str:
    q = (query or "").strip()
    if q:
        return q
    s = (select or "").strip()
    if not s:
        return ""
    return s if s.lower().startswith("select:") else f"select:{s}"


@tool(args_schema=ToolSearchInput)
def tool_search(query: str | None = None, select: str | None = None) -> str:
    """Fetches schema definitions for tools not yet visible to the model.

    Searches deferred tools (<available-deferred-tools>) and the full native catalog
    (including workspace builtins like ``mind_map``). Matched tools are activated for
    the rest of the turn via ``loaded_deferred_tools`` — no separate ``scenario()`` needed
    for individual tool loads.

    Call with the ``query`` argument (not a bare ``select`` field alone, though ``select``
    is accepted as an alias):
      - {"query": "select:subagent"} — exact name(s)
      - {"query": "notebook jupyter"} — keyword search
      - {"query": "+slack send"} — name must contain slack, rank by rest
      - {"select": "subagent"} — alias for query="select:subagent"

    Returns:
        Tool activation result JSON.
    """
    query = _resolve_tool_search_query(query, select)
    if not query:
        return (
            'Error: query is required. Use {"query":"select:tool_name"} '
            '(or alias {"select":"tool_name"}).'
        )

    registry = get_deferred_registry()
    matched_tools: list[BaseTool] = []
    if registry is not None:
        matched_tools = registry.search(query)
    if not matched_tools:
        matched_tools = _search_catalog_tools(query)

    # Fallback: search MCP tools from the module-level cache (not ContextVar).
    # The DeferredToolRegistry and _catalog_tools_var are ContextVars set during
    # graph build (make_lead_agent). When LangGraph executes the graph, the
    # ContextVar may not propagate to the execution context, leaving both empty.
    # peek_cached_mcp_tools() reads a process-level cache that survives context
    # boundaries, ensuring MCP tools remain discoverable via tool_search.
    if not matched_tools:
        matched_tools = _search_mcp_cache_fallback(query)

    if not matched_tools:
        hint = ""
        q = str(query or "").strip().lower()
        if q.startswith("select:"):
            names = [n.strip() for n in q[7:].split(",") if n.strip()]
            if any(n.startswith("media-") for n in names):
                hint = (
                    " 提示：`media-visual-planner`、`media-artist` 等是子智能体 subagent_type，"
                    "不是工具名。请读 byted-ark-seedream-skill / media-production 技能，"
                    "用 `subagent(subagent_type=\"media-visual-planner\", ...)` 委派，或 `list_agents` 查看媒体团队。"
                )
            elif any(n.startswith("media_") for n in names):
                hint = (
                    " 提示：内置 media_* 工具已移除。请读 byted-ark-seedream-skill（生图）或 media-production（生视频），"
                    "用 terminal 跑对应技能 scripts/。"
                )
        elif "media_image" in q or "media_video" in q:
            hint = " 提示：生图/生视频请读 byted-ark-seedream-skill 或 media-production 等厂商技能，terminal 调用对应脚本。"
        if registry is None and not (_catalog_tools_var.get() or ()):
            return "No deferred tools available."
        return f"No tools found matching: {query}{hint}"

    activated = get_activated_deferred_tools()
    bound = get_bound_tool_names()
    names = [str(getattr(t, "name", "") or "").strip() for t in matched_tools]
    already_set = set(activated) | set(bound)
    already = sorted([n for n in names if n and n in already_set])
    to_activate = [t for t in matched_tools if str(getattr(t, "name", "") or "").strip() not in already_set]
    if not to_activate:
        return json.dumps(
            {
                "status": "already_activated",
                "tools": already,
                "message": "All matched tools are already activated and callable.",
            },
            ensure_ascii=False,
            indent=2,
        )

    # Use LangChain's built-in serialization to produce OpenAI function format.
    # This is model-agnostic: all LLMs understand this standard schema.
    tool_defs = [convert_to_openai_function(t) for t in to_activate[:MAX_RESULTS]]
    activated_now = [str(getattr(t, "name", "") or "").strip() for t in to_activate[:MAX_RESULTS] if str(getattr(t, "name", "") or "").strip()]

    return json.dumps(
        {
            "status": "ok",
            "already_activated": already,
            "activated_now": activated_now,
            "tool_defs": tool_defs,
        },
        indent=2,
        ensure_ascii=False,
    )
