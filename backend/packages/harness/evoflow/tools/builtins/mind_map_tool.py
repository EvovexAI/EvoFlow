"""Standalone session knowledge / logic mind map tool."""

from __future__ import annotations

from typing import Annotated, Any

from langchain.tools import InjectedToolCallId, ToolRuntime, tool
from langgraph.typing import ContextT
from pydantic import Field

from evoflow.exploration_graph.mind_map_exec import execute_mind_map
from evoflow.exploration_graph.mind_map_tool_description import MIND_MAP_TOOL_DESCRIPTION
from evoflow.exploration_graph.tool_schema import MindMapOpItem


def _resolve_thread_id(runtime: ToolRuntime[ContextT, Any]) -> str:
    ctx = getattr(runtime, "context", None) or {}
    tid = str(ctx.get("thread_id") or "").strip()
    if tid:
        return tid
    try:
        from langgraph.config import get_config

        return str(get_config().get("configurable", {}).get("thread_id") or "").strip()
    except Exception:
        return ""


def _resolve_session_key(runtime: ToolRuntime[ContextT, Any]) -> str:
    try:
        from evoflow.agents.goal.goal_runtime import resolve_session_key

        sk = str(resolve_session_key(runtime) or "").strip()
        if sk:
            return sk
    except Exception:
        pass
    tid = _resolve_thread_id(runtime)
    if not tid:
        return ""
    try:
        from evoflow.persistence.session_repositories import find_session_key_by_thread_id

        return str(find_session_key_by_thread_id(tid) or "").strip()
    except Exception:
        return ""


def _resolve_turn_id(runtime: ToolRuntime[ContextT, Any]) -> str:
    ctx = getattr(runtime, "context", None) or {}
    tid = str(ctx.get("turn_id") or "").strip()
    if tid:
        return tid
    try:
        from langgraph.config import get_config

        return str(get_config().get("configurable", {}).get("turn_id") or "").strip()
    except Exception:
        return ""


def _resolve_run_id(runtime: ToolRuntime[ContextT, Any]) -> str | None:
    ctx = getattr(runtime, "context", None) or {}
    rid = str(ctx.get("run_id") or "").strip()
    if rid:
        return rid
    try:
        from langgraph.config import get_config

        raw = str(get_config().get("configurable", {}).get("run_id") or "").strip()
        return raw or None
    except Exception:
        return None


@tool("mind_map", description=MIND_MAP_TOOL_DESCRIPTION, parse_docstring=False)
def mind_map_tool(
    runtime: ToolRuntime[ContextT, Any],
    tool_call_id: Annotated[str, InjectedToolCallId],
    ops: Annotated[
        list[MindMapOpItem] | None,
        Field(
            default=None,
            max_length=20,
            description="1–20 graph ops. Each upsert_node needs upsert_edge in the same batch.",
        ),
    ] = None,
    query: Annotated[
        bool,
        Field(
            default=False,
            description="If true, return current snapshot without writing (omit ops).",
        ),
    ] = False,
) -> str:
    """Apply mind_map ops or query the current snapshot (policy is in the tool description)."""
    return execute_mind_map(
        ops,
        thread_id=_resolve_thread_id(runtime),
        session_key=_resolve_session_key(runtime),
        tool_call_id=tool_call_id,
        turn_id=_resolve_turn_id(runtime),
        run_id=_resolve_run_id(runtime),
        query=bool(query),
    )


def mind_map_ops_from_tool_args(args: dict[str, Any]) -> list[dict[str, Any]]:
    """Normalize ``ops`` from a mind_map tool call."""
    raw = args.get("ops")
    if raw is None:
        return []
    if isinstance(raw, list):
        out: list[dict[str, Any]] = []
        for item in raw:
            if isinstance(item, dict):
                out.append(dict(item))
            elif hasattr(item, "model_dump"):
                out.append(item.model_dump(by_alias=True, exclude_none=True))
        return out
    return []
