"""Runtime enforcement helpers for the standalone ``mind_map`` tool."""

from __future__ import annotations

import json
from typing import Any

from evoflow.exploration_graph.mind_map_hints import EVIDENCE_TOOLS

MIND_MAP_TOOL_NAME = "mind_map"

MIND_MAP_COMPANION_REQUIRED_ERROR = (
    "Error: when calling evidence tools (read/rg/terminal/search_code_index/…), "
    "you must also call the `mind_map` tool in the **same turn** (parallel tool_calls). "
    'Example: [{"name":"read","args":{"path":"src/x.ts"}}, '
    '{"name":"mind_map","args":{"ops":[{"op":"set_goal","title":"…"},{"op":"upsert_node","id":"file:src/x.ts","kind":"file","parent":"goal:session"}]}}]. '
    "Retry with a concurrent mind_map call."
)

MIND_MAP_OPS_EMPTY_ERROR = (
    "Error: mind_map tool requires a non-empty `ops` array (1–8 items). "
    "First session turn must include set_goal when no goal exists. "
    'Example: {"ops":[{"op":"set_goal","title":"定位登录 401"},{"op":"upsert_node","id":"flow:auth","kind":"flow","parent":"goal:session"}]}. '
    "Retry the mind_map call."
)

# Backward compat alias (after_model / tests)
MIND_MAP_OPS_REQUIRED_ERROR = MIND_MAP_COMPANION_REQUIRED_ERROR

MIND_MAP_GOAL_REQUIRED_ERROR = (
    "Error: session mind map has no goal yet (enforced by runtime). "
    "Include set_goal as the first op, e.g. "
    '{"ops":[{"op":"set_goal","title":"定位并修复登录页 401 错误"}]}. '
    "Retry the mind_map call."
)

# Model sometimes calls op types as standalone tools; route to mind_map tool.
MIND_MAP_OP_NAMES = frozenset(
    {
        "set_goal",
        "upsert_node",
        "patch_node",
        "delete_node",
        "upsert_edge",
        "delete_edge",
        "mind_map_ops",
    }
)


def mind_map_misinvoked_tool_hint(tool_name: str) -> str | None:
    """Hint when the model tries to invoke a mind-map op as a real tool."""
    name = str(tool_name or "").strip()
    if name not in MIND_MAP_OP_NAMES:
        return None
    op_example = "patch_node" if name in {"mind_map_ops", "patch_node"} else name
    return (
        f"'{name}' is NOT a standalone tool — call the `mind_map` tool with an `ops` array. "
        f'Do NOT call tool `{name}`. Instead: '
        f'{{"name":"mind_map","args":{{"ops":[{{"op":"{op_example}","id":"file:path/to/file","append_body":"…"}}]}}}}'
    )


def parse_mind_map_ops_value(raw: Any) -> list[dict[str, Any]]:
    """Normalize ops from tool args (list, JSON string, or single object)."""
    if raw is None:
        return []
    if isinstance(raw, str):
        s = raw.strip()
        if not s:
            return []
        try:
            raw = json.loads(s)
        except json.JSONDecodeError:
            return []
    if isinstance(raw, dict):
        return [raw]
    if not isinstance(raw, list):
        return []
    out: list[dict[str, Any]] = []
    for x in raw:
        if isinstance(x, dict):
            out.append(dict(x))
        elif hasattr(x, "model_dump"):
            out.append(x.model_dump(by_alias=True, exclude_none=True))
    return out


def tool_call_args_dict(tool_call: Any) -> dict[str, Any]:
    """Read args from a LangChain/OpenAI-style tool_call dict."""
    if not isinstance(tool_call, dict):
        return {}
    raw = tool_call.get("args")
    if isinstance(raw, dict):
        return dict(raw)
    if isinstance(raw, str):
        s = raw.strip()
        if not s:
            return {}
        try:
            parsed = json.loads(s)
            return dict(parsed) if isinstance(parsed, dict) else {}
        except json.JSONDecodeError:
            try:
                from evoflow.tools.arg_coerce import parse_loose_json_object

                parsed = parse_loose_json_object(s)
                return dict(parsed) if parsed else {}
            except Exception:
                return {}
    return {}


def mind_map_ops_from_tool_call(tool_call: Any) -> list[dict[str, Any]]:
    args = tool_call_args_dict(tool_call)
    name = str(tool_call.get("name") or "").strip() if isinstance(tool_call, dict) else ""
    if name == MIND_MAP_TOOL_NAME:
        return parse_mind_map_ops_value(args.get("ops"))
    return parse_mind_map_ops_value(args.get("mind_map_ops"))


def _tool_call_name(tool_call: Any) -> str:
    if not isinstance(tool_call, dict):
        return ""
    return str(tool_call.get("name") or "").strip()


def tool_calls_missing_mind_map_companion(tool_calls: list[Any] | None) -> list[str]:
    """Return evidence tool names when batch lacks a concurrent ``mind_map`` call."""
    calls = list(tool_calls or [])
    if not calls:
        return []
    names = [_tool_call_name(tc) for tc in calls]
    if MIND_MAP_TOOL_NAME in names:
        return []
    evidence = [name for name in names if name and name.lower() in EVIDENCE_TOOLS]
    return evidence


def tool_calls_missing_mind_map_ops(tool_calls: list[Any] | None) -> list[str]:
    """Backward-compat alias for after_model enforcement."""
    return tool_calls_missing_mind_map_companion(tool_calls)


def ops_include_set_goal(ops: list[dict[str, Any]]) -> bool:
    for raw in ops or []:
        if not isinstance(raw, dict):
            continue
        op = str(raw.get("op") or "").strip()
        if op == "set_goal":
            return True
        if op == "upsert_node" and str(raw.get("kind") or "").strip() == "goal":
            return True
    return False


def graph_has_goal(thread_id: str) -> bool:
    tid = str(thread_id or "").strip()
    if not tid:
        return False
    try:
        from evoflow.persistence.exploration_graph_repositories import (
            get_graph_header,
            get_node,
            resolve_scope_thread_id,
        )

        scope = resolve_scope_thread_id(tid)
        header = get_graph_header(scope)
        if header and str(header.goal or "").strip():
            return True
        node = get_node(scope, "goal:session")
        return node is not None and str(node.status or "") != "deleted"
    except Exception:
        return False


def mind_map_goal_missing_for_calls(tool_calls: list[Any] | None, *, thread_id: str) -> bool:
    """True when graph has no goal and no mind_map call in the batch sets one."""
    if graph_has_goal(thread_id):
        return False
    for tc in tool_calls or []:
        if _tool_call_name(tc) != MIND_MAP_TOOL_NAME:
            continue
        if ops_include_set_goal(mind_map_ops_from_tool_call(tc)):
            return False
    return bool(tool_calls)
