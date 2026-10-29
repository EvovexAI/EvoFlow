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


def _ctx_get(runtime: ToolRuntime[ContextT, dict] | None, key: str) -> Any:
    ctx = getattr(runtime, "context", None) if runtime is not None else None
    if ctx is None:
        return None
    get = getattr(ctx, "get", None)
    if callable(get):
        return get(key)
    return getattr(ctx, key, None)


def _session_from_runtime(runtime: ToolRuntime[ContextT, dict] | None) -> tuple[str, str]:
    """Return ``(session_key, thread_id)`` from runtime context when present."""
    sk = str(_ctx_get(runtime, "session_key") or "").strip()
    tid = str(_ctx_get(runtime, "thread_id") or "").strip()
    return sk, tid


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

        emp = ""
        raw = _ctx_get(runtime, "proactive_agent_code")
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
action format: domain.op (knowledge.*, workflow.*, settings.*, openai.*, assets.*, agents.*, employees.*, tasks.*, items.*, skills.*, mcp, automation.*, approvals.*, sessions.*, diagnostics.*, appearance.*, ui.*, media.*, verification.*). Long-term memory → assets tool / evoflow-admin assets-contract (not platform memory.*).
catalog: pass domain via tool arg ``domain`` or args_json {\"domain\":\"mcp\"}; summary mode args_json {\"summary\":true}.
items.* = user notes; tasks.* = collab ledger (prefer tasks tool on duty); todo = chat checklist only.
Reusable craft/experience → assets tool (not platform experience.*).
sessions.status = current conversation run/context usage; sessions.compact (confirm=true) = manually compress context (same as /compact; applies to later turns).
Right panel: ui.show kind+data (collab-workflow / collabSubtaskTranscript / employeeProcess / web-embed / artifacts…); ui.hide to close. Read-risk, no confirm. Only when user should watch progress — not after every write.
OpenAI-compat analysis (CLI evoflow openai / models invoke): openai.models → openai.chat (confirm=true) for text; openai.vision (confirm=true, image+message) for vision; settings.invoke_model also covers text invoke.
Media: media.catalog → media.generate_image (confirm=true, sync poll) / media.generate_video (confirm=true, async) → media.task_wait. Default Volcengine jimeng (Agent Plan Seedream/Seedance). Do not call retired media_* tool names. UI shows image/video preview from absolute_path — do not paste ![markdown] again.
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
        sk, tid = _session_from_runtime(runtime)
        data = dispatch_platform_action(
            action,
            args_json=args_json,
            domain=domain or None,
            confirm=bool(confirm),
            principal_id=_principal_from_runtime(runtime),
            session_key=sk,
            thread_id=tid,
        )
        return _json(data)
    except Exception as exc:
        logger.exception("platform tool failed action=%s", action)
        return _json({"ok": False, "error": str(exc), "action": action})
