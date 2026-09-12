"""Tools omitted from the main chat bubble stream (handled by sidebar / dedicated UI)."""

from __future__ import annotations

import json
from typing import Any

CHAT_PANEL_HIDDEN_TOOL_NAMES: frozenset[str] = frozenset(
    {
        # ask_clarification / propose_goal：须在 SSE 下发，供询问条与目标确认条解析
        "present_files",
        "present_file",
        "todo_write",
        "todo_reminder",
        "scenario",
        "mode_set",
        "scenario_activation",
    }
)


def _normalize_tool_name(name: str) -> str:
    return str(name or "tool").strip().lower()


def _parse_tool_call_args(tc: dict[str, Any]) -> dict[str, Any]:
    direct = tc.get("args") or tc.get("input") or tc.get("parameters")
    if isinstance(direct, dict):
        return direct
    fn = tc.get("function") if isinstance(tc.get("function"), dict) else None
    if fn and isinstance(fn.get("arguments"), str):
        raw = str(fn.get("arguments") or "").strip()
        if raw:
            try:
                parsed = json.loads(raw)
                return parsed if isinstance(parsed, dict) else {}
            except Exception:
                return {}
    return {}


def resolve_tool_call_name(tc: dict[str, Any]) -> str:
    if not isinstance(tc, dict):
        return ""
    fn = tc.get("function") if isinstance(tc.get("function"), dict) else {}
    return str(tc.get("name") or tc.get("tool_name") or fn.get("name") or "").strip()


def tool_omit_from_chat_panel(
    tool_or_name: str | dict[str, Any],
    *,
    args: dict[str, Any] | None = None,
) -> bool:
    """Return True when the tool must not appear in the main chat bubble stream."""
    if isinstance(tool_or_name, dict):
        tc = tool_or_name
        name = resolve_tool_call_name(tc)
        parsed_args = _parse_tool_call_args(tc)
        if args:
            parsed_args = {**parsed_args, **args}
    else:
        name = str(tool_or_name or "").strip()
        parsed_args = dict(args or {})

    key = _normalize_tool_name(name)
    if not key or key == "tool":
        return True
    if key.startswith("scheduler:"):
        return True
    inv = str(parsed_args.get("invocation_source") or "").strip().lower()
    if inv in {"prefetch", "scheduler"}:
        return True
    return key in CHAT_PANEL_HIDDEN_TOOL_NAMES
