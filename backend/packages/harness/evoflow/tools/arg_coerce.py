"""Coerce LLM tool arguments (models often pass JSON strings instead of lists)."""

from __future__ import annotations

import json
import re
from typing import Any

_PATH_PREFIX_RE = re.compile(r"^path:(\S+)\s*(.*)$", re.IGNORECASE)


def parse_search_path_prefix(query: str) -> tuple[str | None, str]:
    """Split ``path:evopanel/src/react MessageRow`` into (path_prefix, keyword_query)."""
    s = str(query or "").strip()
    if not s:
        return None, ""
    m = _PATH_PREFIX_RE.match(s)
    if not m:
        return None, s
    prefix = str(m.group(1) or "").strip().replace("\\", "/").strip("/")
    rest = str(m.group(2) or "").strip()
    return (prefix or None), rest


def split_pipe_terms(text: str) -> list[str]:
    """Split ``飞书|feishu|lark`` into terms (pipe is the compact multi-keyword syntax)."""
    s = str(text or "").strip()
    if not s:
        return []
    if "|" in s:
        return [p.strip().strip("\"'") for p in s.split("|") if p.strip()]
    return [s.strip("\"'")]


def coerce_str_list(value: Any) -> list[str]:
    """Accept ``list[str]``, pipe-separated, JSON array string, or comma-separated string."""
    if value is None:
        return []
    if isinstance(value, list):
        out: list[str] = []
        for item in value:
            for part in split_pipe_terms(str(item or "")):
                if part:
                    out.append(part)
        return out
    if isinstance(value, str):
        s = value.strip()
        if not s:
            return []
        if s.startswith("["):
            try:
                parsed = json.loads(s)
                if isinstance(parsed, list):
                    return [p for x in parsed for p in split_pipe_terms(str(x)) if p]
            except json.JSONDecodeError:
                pass
        if "|" in s:
            return split_pipe_terms(s)
        if "," in s:
            return [p.strip().strip("\"'") for p in s.split(",") if p.strip()]
        return [s.strip("\"'")]
    return []


# Tool names → argument keys that must be real lists (models often emit JSON strings).
_INT_ARG_FIELDS_BY_TOOL: dict[str, tuple[str, ...]] = {
    "search_code_index": ("read_offset", "read_limit", "limit"),
}

# Legacy bundled mind_map_ops stripped if models still send it on other tools.
_GLOBAL_STRIP_ARG_FIELDS: tuple[str, ...] = ("mind_map_ops",)

# Model must not override session workspace; strip if present in tool_call args.
# search_content ``path`` stripping is handled in tool_error_handling middleware (host_direct only).
_STRIP_ARG_FIELDS_BY_TOOL: dict[str, tuple[str, ...]] = {
    "search_code_index": ("workspace_root",),
}


def _coerce_int_field(value: Any, *, default: int = 0) -> int:
    if value is None or value == "":
        return default
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return default


_LIST_ARG_FIELDS_BY_TOOL: dict[str, tuple[str, ...]] = {
    "search_code_index": ("queries",),
    "create_agent": ("tools", "skills", "mcp_servers", "disallowed_tools"),
    "update_agent": ("tools", "skills", "mcp_servers", "disallowed_tools"),
    "ask_clarification": ("options",),
    # Models often stringify list args: paths='["a.md"]' → validation "Input should be a valid list"
    "knowledge": ("paths", "tags", "scopes", "add_tags", "remove_tags", "related_paths"),
}


def _json_loads_if_string(value: Any) -> Any:
    if isinstance(value, str):
        s = value.strip()
        if s and s[0] in "[{":
            try:
                return json.loads(s)
            except json.JSONDecodeError:
                pass
    return value


def parse_loose_json_object(text: str) -> dict[str, Any] | None:
    """Parse JSON object; salvage prefix when models append garbage (e.g. merged tool names)."""
    raw = str(text or "").strip()
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, dict) else None
    except json.JSONDecodeError:
        pass
    start = raw.find("{")
    if start < 0:
        return None
    for end in range(len(raw), start, -1):
        if raw[end - 1] != "}":
            continue
        chunk = raw[start:end]
        try:
            parsed = json.loads(chunk)
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            continue
    return None


def coerce_plan_tool_call_args(args: dict[str, Any]) -> dict[str, Any]:
    """Normalize ``plan`` kwargs via PlanInput (steps JSON string, step field aliases, etc.)."""
    from evoflow.tools.builtins.plan_tool import PlanInput

    out = dict(args)
    out.pop("markdown", None)
    for junk in ("action", "task_id", "task_name", "task_description", "authorized_by"):
        out.pop(junk, None)
    if not out.get("steps") and out.get("subtasks"):
        out["steps"] = out.pop("subtasks")
    if "steps" in out:
        loaded = _json_loads_if_string(out["steps"])
        if loaded is not out["steps"]:
            out["steps"] = loaded
    if "validation" in out:
        loaded = _json_loads_if_string(out["validation"])
        if loaded is not out["validation"]:
            out["validation"] = loaded
    steps = out.get("steps")
    if isinstance(steps, dict):
        out["steps"] = [steps]
    validated = PlanInput.model_validate(out)
    dumped = validated.model_dump(mode="python")
    if validated.steps:
        dumped["steps"] = [step.model_dump(mode="python") for step in validated.steps]
    return dumped


def _coerce_list_field(value: Any) -> list[str] | None:
    """Coerce to ``list[str]``; return ``None`` when absent/empty."""
    if value is None:
        return None
    if isinstance(value, list):
        out = [str(x).strip() for x in value if str(x).strip()]
        return out or None
    coerced = coerce_str_list(value)
    return coerced or None


def coerce_tool_call_args(tool_name: str, args: Any) -> dict[str, Any]:
    """Normalize tool kwargs before LangChain/Pydantic validation (middleware hook)."""
    if not isinstance(args, dict):
        return {}
    name = str(tool_name or "").strip()
    out = dict(args)
    for field in _GLOBAL_STRIP_ARG_FIELDS:
        out.pop(field, None)
    for field in _STRIP_ARG_FIELDS_BY_TOOL.get(name, ()):
        out.pop(field, None)
    for field in _INT_ARG_FIELDS_BY_TOOL.get(name, ()):
        if field not in out:
            continue
        default = 0 if field.startswith("read_") else 15 if field == "limit" else 0
        out[field] = _coerce_int_field(out[field], default=default)
    list_fields = _LIST_ARG_FIELDS_BY_TOOL.get(name)
    if name == "plan":
        try:
            return coerce_plan_tool_call_args(out)
        except Exception:
            return out
    if not list_fields:
        return out
    for field in list_fields:
        if field not in out:
            continue
        coerced = _coerce_list_field(out[field])
        out[field] = coerced
    return out


def normalize_search_query_inputs(
    query: str = "",
    queries: Any = None,
) -> tuple[str, list[str]]:
    """One field ``飞书|feishu|lark`` or query + queries; returns (primary, rest) for search_index."""
    parts: list[str] = []
    seen: set[str] = set()
    for raw in [query, *coerce_str_list(queries)]:
        for term in split_pipe_terms(str(raw or "")):
            key = term.casefold()
            if not term or key in seen:
                continue
            seen.add(key)
            parts.append(term)
    if not parts:
        return "", []
    return parts[0], parts[1:]
