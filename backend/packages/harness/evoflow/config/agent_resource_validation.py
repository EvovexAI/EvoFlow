"""Validate tool/skill identifiers for custom agent configs (create/update)."""

from __future__ import annotations

import json
import re
from typing import Any


def model_name_from_tool_runtime(runtime: Any) -> str | None:
    """Resolve chat model name from LangGraph ToolRuntime (same sources as task_tool)."""
    cfg: dict[str, Any] = getattr(runtime, "config", None) or {}
    meta = cfg.get("metadata") or {}
    m = meta.get("model_name") or meta.get("model")
    if m:
        s = str(m).strip()
        return s or None
    conf = cfg.get("configurable") or {}
    m2 = conf.get("model_name") or conf.get("model")
    if m2:
        s2 = str(m2).strip()
        return s2 or None
    return None


def assignable_tool_names(*, model_name: str | None = None) -> set[str]:
    """Tool names returned by the same loader used for subagent allowlists."""
    from evoflow.tools import get_available_tools

    tools = get_available_tools(model_name=model_name, subagent_enabled=False)
    return {str(getattr(t, "name", "") or "") for t in tools if getattr(t, "name", None)}


def valid_skill_names(*, enabled_only: bool = True) -> set[str]:
    """Skill frontmatter ``name`` values known to the loader."""
    from evoflow.skills import load_skills

    return {str(s.name).strip() for s in load_skills(enabled_only=enabled_only) if str(s.name).strip()}


def normalize_str_or_list_argument(val: Any) -> list[str] | None:
    """Coerce args that models often emit as JSON/CSV strings into ``list[str]``.

    LangGraph tool validation may run before the handler—union ``str | list`` on the
    Python signature allows values like ``'[\"read_file\", ...]'`` through; normalize here.
    """
    if val is None:
        return None
    if isinstance(val, list):
        out = [str(x).strip() for x in val if str(x).strip()]
        return out or None
    if isinstance(val, str):
        s = val.strip()
        if not s:
            return None
        if s.startswith("["):
            try:
                parsed = json.loads(s)
                if isinstance(parsed, list):
                    out = [str(x).strip() for x in parsed if str(x).strip()]
                    return out or None
            except (json.JSONDecodeError, TypeError, ValueError):
                pass
        parts = [p.strip().strip("\"'\u201c\u201d") for p in re.split(r"[,，;]", s)]
        parts = [p for p in parts if p]
        return parts or None
    sx = str(val).strip()
    return [sx] if sx else None


def partition_tool_names(names: list[str] | None, *, model_name: str | None = None) -> tuple[list[str], list[str]]:
    """Return (known, unknown) preserving input order for known."""
    if not names:
        return [], []
    allowed = assignable_tool_names(model_name=model_name)
    seen: set[str] = set()
    known: list[str] = []
    unknown: list[str] = []
    for raw in names:
        n = str(raw or "").strip()
        if not n or n in seen:
            continue
        seen.add(n)
        if n in allowed:
            known.append(n)
        else:
            unknown.append(n)
    return known, unknown


def partition_skill_names(names: list[str] | None, *, enabled_only: bool = True) -> tuple[list[str], list[str]]:
    if not names:
        return [], []
    allowed = valid_skill_names(enabled_only=enabled_only)
    seen: set[str] = set()
    known: list[str] = []
    unknown: list[str] = []
    for raw in names:
        n = str(raw or "").strip()
        if not n or n in seen:
            continue
        seen.add(n)
        if n in allowed:
            known.append(n)
        else:
            unknown.append(n)
    return known, unknown
