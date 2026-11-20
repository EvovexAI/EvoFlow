"""通用平台行政工具 ``platform`` — catalog → confirm → execute。"""

from __future__ import annotations

import json
import logging
from typing import Annotated, Any

from langchain_core.tools import InjectedToolCallId, tool
from langgraph.typing import ContextT
from pydantic import BaseModel, ConfigDict, Field

from evoflow.core.tool_runtime_type import ToolRuntime

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


# 【self-evolution-bot · 2026-11-20 · 第87轮 · 模型:deepseek-v4.1-flash-1017】
# 描述里 Right panel 段改写：先调 ui.kinds 查契约；只读动作永不自动弹栏；
# 逐 kind 列出必需字段（web-embed/shell-page/employeeProcess/collab-workflow/…）。
_PLATFORM_TOOL_DESCRIPTION = """\
Platform admin: catalog/help → pick action → confirm writes (confirm=true).
action format: domain.op (knowledge.*, workflow.*, settings.*, openai.*, assets.*, agents.*, employees.*, tasks.*, items.*, skills.*, mcp, automation.*, approvals.*, sessions.*, diagnostics.*, appearance.*, ui.*, media.*, verification.*).
Long-term memory → assets tool / evoflow-admin assets-contract (not platform memory.*).
catalog: pass domain via tool arg ``domain`` or args_json {\"domain\":\"mcp\"}; summary mode args_json {\"summary\":true}.
items.* = user notes; tasks.* = collab ledger (prefer tasks tool on duty); todo = chat checklist only.
Reusable craft/experience → assets tool (not platform experience.*).
sessions.status = current conversation run/context usage; sessions.compact (confirm=true) = manually compress context (same as /compact; applies to later turns).
Right panel: call action=ui.kinds FIRST to read supported kinds + required fields, then ui.show kind+data.
Nothing auto-opens the panel except actions the user is actively waiting on
(employees.wake/dispatch/resume/chat_send, workflow.run) — read-only ops (list/get/brief) never pop it.
Required fields: web-embed data.url; shell-page data.path (site-internal route);
employeeProcess data.agentCode (taskId optional); collab-workflow data.mainTaskId;
collabSubtaskTranscript data.mainTaskId+subtaskId; sessionRuntime data.sessionKey.
OpenAI-compat analysis (CLI evoflow openai / models invoke): openai.models → openai.chat (confirm=true) for text; openai.vision (confirm=true, image+message) for vision; settings.invoke_model also covers text invoke.
Media: media.catalog → media.generate_image (confirm=true, sync poll) / media.generate_video (confirm=true, async) → media.task_wait. Default Volcengine jimeng (Agent Plan Seedream/Seedance). Do not call retired media_* tool names.
UI shows image/video preview from absolute_path — do not paste ![markdown] again.
Generated-image pixels are auto-staged into your next turn (vision models) — do not re-read the file to see it; absolute_path is for UI preview and image2image references.
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


def _note_platform_timing(tool_call_id: str, **fields: object) -> None:
    """Attach per-action timing for observability (which platform ops are slow)."""
    if not tool_call_id:
        return
    try:
        from evoflow.observability.tool_timing import note_tool_exec_detail

        note_tool_exec_detail(tool_call_id, {"kind": "platform", **fields})
        exec_ms = float(fields.get("exec_ms") or 0)
        if exec_ms >= 1500:
            logger.info(
                "platform slow action=%s domain=%s risk=%s exec_ms=%.0f ok=%s",
                fields.get("action"),
                fields.get("domain"),
                fields.get("risk"),
                exec_ms,
                fields.get("ok"),
            )
    except Exception:
        return


class _PlatformArgsSchema(BaseModel):
    """platform 工具入参 schema：允许额外字段，不让顶层多传的参数被静默丢弃。

    【self-evolution-bot · 2026-11-18 · 第54轮 · 模型:deepseek-v4.1-flash-1017】
    默认 ``extra='ignore'`` 会把模型放在工具顶层的 ``title`` / ``notes`` / ``text``
    直接吃掉（现网 4 次 ``title is required`` 就是这么来的），然后工具再回一句
    「你没传」。改成 allow 后由 ``platform_tool`` 把它们并进 args_json。
    """

    model_config = ConfigDict(extra="allow")

    action: str = Field(..., description="平台动作，形如 items.create / settings.get_model")
    args_json: str | dict | list | None = Field("", description="该 action 的参数对象")
    domain: str = Field("", description="可选：仅传叶子动作名时用域限定")
    confirm: bool = Field(False, description="写操作确认闸门")
    # 【self-evolution-bot · 2026-11-18 · 第57轮 · 模型:deepseek-v4.1-flash-1017】
    # 改了什么：把 tool_call_id 补进 args_schema。
    # 为什么：langchain 只在 **args_schema 的注解里**看到 InjectedToolCallId 时才注入
    # 这个参数（见 langchain_core.tools.base 里 `get_all_basemodel_annotations(input_args)`
    # 那段）。第54轮引入自定义 schema 后它不在 schema 里，注入链直接断掉，真实调用一律
    # 报 `platform_tool() missing 1 required positional argument: 'tool_call_id'`
    # —— 现网 2026-11-18 23:2x 重启后实测 2 次，工具完全不可用。
    # 这是「自定义 args_schema」的通用坑：函数签名里的注入参数必须在 schema 里登记一份。
    tool_call_id: Annotated[str, InjectedToolCallId] = Field(
        "", description="由运行时注入的调用 id，调用方不要传"
    )
    


@tool("platform", args_schema=_PlatformArgsSchema, description=_PLATFORM_TOOL_DESCRIPTION, parse_docstring=False)
def platform_tool(
    action: str,
    tool_call_id: Annotated[str, InjectedToolCallId],
    runtime: ToolRuntime[ContextT, dict] | None = None,
    args_json: str | dict | list | None = "",
    domain: str = "",
    confirm: bool = False,
    **extra_args: Any,
) -> str:
    """Platform admin dispatch (policy in tool description)."""
    import time

    from evoflow.admin.platform_actions import dispatch_platform_action

    # 【self-evolution-bot · 2026-11-18 · 第54轮 · 模型:deepseek-v4.1-flash-1017】
    # 改了什么：接住模型放在**工具顶层**的额外字段（title / notes / text / path …），
    # 合并进 args_json，而不是让它们被 pydantic 静默丢弃。
    # 为什么：现网 obs 实证，`items.create` 报 `title is required` 5 次，其中 **4 次
    # title 就在工具顶层**（input_json 顶层键里有 title，args_json 里没有）。签名里没有
    # 这些参数、model_config 又是默认 extra='ignore'，于是字段被无声吃掉，工具再回一句
    # 「你没传 title」——调用方看到的却是"我明明传了"。这不是报错文案问题，是**静默丢数据**，
    # 必须在这里接住。合并规则：args_json 已有的键不被顶层覆盖（显式容器优先），
    # 只补空位；runtime / tool_call_id / domain / confirm 属工具自身参数，不参与合并。
    _TOOL_OWN_KEYS = {"action", "args_json", "domain", "confirm", "runtime", "tool_call_id"}
    _extra = {
        str(k): v for k, v in (extra_args or {}).items() if str(k) not in _TOOL_OWN_KEYS and v is not None
    }
    if _extra:
        _merged: dict[str, Any] = {}
        if isinstance(args_json, dict):
            _merged.update(args_json)
        elif isinstance(args_json, str) and args_json.strip():
            try:
                _parsed = json.loads(args_json)
                if isinstance(_parsed, dict):
                    _merged.update(_parsed)
            except Exception:
                logger.debug("platform: args_json not a JSON object, extra merge skipped", exc_info=True)
        for _k, _v in _extra.items():
            _merged.setdefault(_k, _v)
        if _merged:
            args_json = _merged
            logger.info("platform: merged %d top-level arg(s) into args_json: %s", len(_extra), sorted(_extra))

    act = str(action or "").strip()
    dom = str(domain or "").strip()
    if not dom and "." in act:
        dom = act.split(".", 1)[0]
    t0 = time.perf_counter()
    try:
        _bind_runtime_identity(runtime)
        sk, tid = _session_from_runtime(runtime)
        data = dispatch_platform_action(
            act,
            args_json=_coerce_args_json(args_json),
            domain=domain or None,
            confirm=bool(confirm),
            principal_id=_principal_from_runtime(runtime),
            session_key=sk,
            thread_id=tid,
        )
        exec_ms = round((time.perf_counter() - t0) * 1000.0, 2)
        risk = ""
        ok = None
        if isinstance(data, dict):
            risk = str(data.get("risk") or "")
            ok = data.get("ok")
            if not risk and data.get("pending_confirm"):
                risk = "write"
        _note_platform_timing(
            tool_call_id,
            action=act,
            domain=dom or None,
            risk=risk or None,
            confirm=bool(confirm),
            exec_ms=exec_ms,
            ok=ok,
            pending_confirm=bool(isinstance(data, dict) and data.get("pending_confirm")),
        )
        payload = _json(data)
        # 生图成片自动进下一轮上下文（viewed_images auto 条目，对齐截图管线）；
        # 无视觉主模型 / text 路由 / 无本地文件时原样返回文本。
        staged = _stage_media_result_images(act, data, runtime)
        if staged:
            from evoflow.agents.image_staging import command_with_staged_images

            return command_with_staged_images(payload, tool_call_id, staged)
        return payload
    except Exception as exc:
        _note_platform_timing(
            tool_call_id,
            action=act,
            domain=dom or None,
            confirm=bool(confirm),
            exec_ms=round((time.perf_counter() - t0) * 1000.0, 2),
            ok=False,
            error=type(exc).__name__,
        )
        logger.exception("platform tool failed action=%s", action)
        return _json({"ok": False, "error": str(exc), "action": action})
