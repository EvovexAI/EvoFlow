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
        from evoflow.authz.runtime_identity import principal_id_from_runtime, set_current_principal_id

        pid = str(principal_id_from_runtime(runtime) or "").strip()
        # Keep ambient in sync so handlers can resolve invoker without threaded args.
        set_current_principal_id(pid)
        return pid
    except Exception:
        return ""


def _bind_runtime_identity(runtime: ToolRuntime[ContextT, dict] | None) -> None:
    """Refresh ambient identity from **runtime-injected** fields for this turn.

    - Human: ``principal_id`` / ``created_by`` on ``runtime.context`` (panel injects
      these from the logged-in user — not from session_key).
    - Employee: ``proactive_agent_code`` only.

    Do **not** bind ambient actor from ``agent_id`` / session channel ids
    (``agent:main:new-…``) — those are lead channel labels, not invoker identity.
    """
    _principal_from_runtime(runtime)
    try:
        from evoflow.authz.agent_actor import (
            is_privileged_task_actor,
            normalize_agent_actor,
            set_current_agent_actor,
        )

        ctx = getattr(runtime, "context", None) if runtime is not None else None
        emp = ""
        if ctx is not None:
            get = getattr(ctx, "get", None)
            raw = get("proactive_agent_code") if callable(get) else getattr(ctx, "proactive_agent_code", None)
            emp = normalize_agent_actor(raw)
            if (
                not emp
                or emp.lower() in {"main", "lead_agent", "auto", "user"}
                or is_privileged_task_actor(emp)
            ):
                emp = ""
        set_current_agent_actor(emp)
    except Exception:
        pass


_PLATFORM_TOOL_DESCRIPTION = """\
Platform admin: catalog/help → pick action → confirm writes (confirm=true).
action format: domain.op (knowledge.*, workflow.*, settings.*, assets.*, agents.*, employees.*, tasks.*, items.*, skills.*, mcp, automation.*, approvals.*, sessions.*, diagnostics.*, appearance.*, ui.*, verification.*). Long-term memory → assets tool / evoflow-admin assets-contract (not platform memory.*).
catalog: pass domain via tool arg ``domain`` or args_json {\"domain\":\"mcp\"}; summary mode args_json {\"summary\":true}.
items.* = user notes; tasks.* = collab ledger (prefer tasks tool on duty); todo = chat checklist only.
Reusable craft/experience → assets tool (not platform experience.*).
Right panel: ui.show kind+data (collab-workflow / collabSubtaskTranscript / employeeProcess / web-embed / artifacts…); ui.hide to close. Read-risk, no confirm. Only when user should watch progress — not after every write.
When result has assistant_guide.say_to_user: tell the user that text.
employees.create/hire → relay say_to_user; bind channel with employees.bind_channel_begin (not channels.registration_*; not ui.show/artifacts QR png; not Markdown ![](url)). UI renders QR under the tool result.
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
        _bind_runtime_identity(runtime)
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
