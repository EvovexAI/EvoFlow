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


# 生图成片 stage 进 viewed_images 的 action 白名单（generate_video 是视频，不进像素上下文）。
_MEDIA_IMAGE_STAGE_ACTIONS = frozenset({"media.generate_image", "media.task_wait"})
_STAGE_IMAGE_MIME_BY_EXT = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
}
_MAX_STAGED_MEDIA_IMAGES = 4


def _stage_media_result_images(action: str, data: Any, runtime: Any) -> dict[str, dict[str, Any]] | None:
    """生图成片 → ``viewed_images`` auto 条目（下一轮模型调用前自动注入像素）。

    对齐 browser / node_repl 截图的 staging 管线（agents/image_staging.py）：
    - 只认**本地**图片文件；远端 URL / 视频 / 失败结果不 stage；
    - 主模型无视觉或用户选 text 路由时 ``stage_image_entry`` 返回 None，
      自动退化为现状（模型只拿 absolute_path 文本 + UI 预览卡）；
    - 返回 None 表示无需 Command，调用方退化为纯文本 payload。
    """
    if action not in _MEDIA_IMAGE_STAGE_ACTIONS:
        return None
    if not isinstance(data, dict) or data.get("ok") is False:
        return None
    if str(data.get("media_kind") or "image").strip().lower() not in ("", "image"):
        return None
    try:
        candidates: list[str] = []
        for key in ("absolute_path", "local_path"):
            p = str(data.get(key) or "").strip()
            if p:
                candidates.append(p)
        extra = data.get("extra") if isinstance(data.get("extra"), dict) else {}
        for raw in extra.get("local_paths") or data.get("local_paths") or []:
            p = str(raw or "").strip()
            if p:
                candidates.append(p)
        seen: set[str] = set()
        ordered: list[str] = []
        for p in candidates:
            if p not in seen:
                seen.add(p)
                ordered.append(p)

        from pathlib import Path

        staged: dict[str, dict[str, Any]] = {}
        for p in ordered[:_MAX_STAGED_MEDIA_IMAGES]:
            mime = _STAGE_IMAGE_MIME_BY_EXT.get(Path(p).suffix.lower())
            if mime is None:
                continue
            if not Path(p).is_file():
                continue
            from evoflow.agents.image_staging import stage_image_entry

            entry = stage_image_entry(runtime=runtime, path=p, mime_type=mime, label="generated image")
            if entry:
                staged[entry["path"]] = entry
        return staged or None
    except Exception:
        logger.debug("stage media result images failed action=%s", action, exc_info=True)
        return None


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
Media: media.catalog → media.generate_image (confirm=true, sync poll) / media.generate_video (confirm=true, async) → media.task_wait. Default Volcengine jimeng (Agent Plan Seedream/Seedance). Do not call retired media_* tool names. UI shows image/video preview from absolute_path — do not paste ![markdown] again. Generated-image pixels are auto-staged into your next turn (vision models) — do not re-read the file to see it; absolute_path is for UI preview and image2image references.
When result has assistant_guide.say_to_user: tell the user that text.
employees.create/hire → relay say_to_user; bind channel with employees.bind_channel_begin (not channels.registration_*; not ui.show/artifacts QR png; not Markdown ![](url)). UI renders QR under the tool result.
settings.* also covers web-search setup (Agent Plan Doubao Harness key / Tavily / Bocha…): prefer settings.get_web_search → follow assistant_guide → patch/test; do not push users into the complex Settings UI.
"""


def _coerce_args_json(args_json: Any) -> str:
    """Models often pass a JSON object for args_json; schema wants a string.

    Obs: ValidationError ``args_json: Input should be a valid string`` burns a turn
    on scenario activate / media calls — coerce dict/list before dispatch.
    """
    if args_json is None:
        return ""
    if isinstance(args_json, (dict, list)):
        try:
            return json.dumps(args_json, ensure_ascii=False)
        except Exception:
            return str(args_json)
    return str(args_json)


@tool("platform", description=_PLATFORM_TOOL_DESCRIPTION, parse_docstring=False)
def platform_tool(
    action: str,
    runtime: ToolRuntime[ContextT, dict],
    tool_call_id: Annotated[str, InjectedToolCallId],
    args_json: str | dict | list | None = "",
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
            args_json=_coerce_args_json(args_json),
            domain=domain or None,
            confirm=bool(confirm),
            principal_id=_principal_from_runtime(runtime),
            session_key=sk,
            thread_id=tid,
        )
        payload = _json(data)
        # 生图成片自动进下一轮上下文（viewed_images auto 条目，对齐截图管线）；
        # 无视觉主模型 / text 路由 / 无本地文件时原样返回文本。
        staged = _stage_media_result_images(action, data, runtime)
        if staged:
            from evoflow.agents.image_staging import command_with_staged_images

            return command_with_staged_images(payload, tool_call_id, staged)
        return payload
    except Exception as exc:
        logger.exception("platform tool failed action=%s", action)
        return _json({"ok": False, "error": str(exc), "action": action})
