"""通用平台行政工具 ``platform`` — catalog → confirm → execute。"""

from __future__ import annotations

import json
import logging
from typing import Annotated, Any

from langchain.tools import InjectedToolCallId, ToolRuntime, tool
from langgraph.typing import ContextT

logger = logging.getLogger(__name__)


def _json(data: Any) -> str:
    try:
        return json.dumps(data, ensure_ascii=False, indent=2, default=str)
    except Exception:
        return str(data)


def _principal_from_runtime(runtime: ToolRuntime[ContextT, dict] | None) -> str:
    """Current principal id from run context (multi-user asset bucketing)."""
    try:
        from evoflow.authz.runtime_identity import principal_id_from_runtime

        return str(principal_id_from_runtime(runtime) or "").strip()
    except Exception:
        return ""


_PLATFORM_TOOL_DESCRIPTION = """\
Platform admin: catalog/help → pick action → confirm writes (confirm=true).
action format: domain.op (knowledge.*, workflow.*, settings.*, agents.*, employees.*, tasks.*, items.*, skills.*, mcp, automation.*, approvals.*, memory.*, sessions.*, experience.*, diagnostics.*, appearance.*).
items.* = user notes; tasks.* = collab ledger (prefer tasks tool on duty); todo = chat checklist only.
settings.* also covers web-search setup (Agent Plan Doubao Harness key / Tavily / Bocha…): prefer settings.get_web_search → follow assistant_guide → patch/test; do not push users into the complex Settings UI.
"""


@tool("platform", description=_PLATFORM_TOOL_DESCRIPTION, parse_docstring=False)
def platform_tool(
    action: str,
    runtime: ToolRuntime[ContextT, dict],
    tool_call_id: Annotated[str, InjectedToolCallId],
    args_json: str = "",
    domain: str = "",
    confirm: bool = False,
) -> str:
    """Platform admin dispatch (policy in tool description)."""
    from evoflow.admin.platform_actions import dispatch_platform_action

    try:
        data = dispatch_platform_action(
            action,
            args_json=args_json,
            domain=domain or None,
            confirm=bool(confirm),
            principal_id=_principal_from_runtime(runtime),
        )
        return _json(data)
    except Exception as exc:
        logger.exception("platform tool failed action=%s", action)
        return _json({"ok": False, "error": str(exc), "action": action})
