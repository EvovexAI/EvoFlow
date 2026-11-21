"""Drive EvoPanel right-side UI panels (not conversation ``scenario`` modes)."""

from __future__ import annotations

import json
import logging
import re
from typing import Annotated, Any, Literal

from langchain_core.messages import ToolMessage
from langchain_core.tools import InjectedToolCallId, tool
from langgraph.config import get_stream_writer
from langgraph.types import Command
from langgraph.typing import ContextT
from pydantic import BeforeValidator, Field

from evoflow.core.tool_runtime_type import ToolRuntime
from evoflow.stage.stage_context import clear_thread_stage, set_thread_stage

# 【self-evolution-bot · 2026-11-20 · 第100轮续 · 模型:deepseek-v4.1-flash-1017】
# 改了什么：新增专用 logger。为什么：右栏推送失败原先被 `except: pass` 吞掉，
# 工具返回 ok 而屏幕上什么都没发生，排查时一点线索都没有（用户明确要求加日志）。
_RIGHT_STAGE_LOGGER_NAME = "evoflow.right_stage"


def get_right_stage_logger() -> logging.Logger:
    return logging.getLogger(_RIGHT_STAGE_LOGGER_NAME)


def _coerce_to_dict_or_none(v: Any) -> dict[str, Any] | None:
    """Coerce str / JSON-string / dict / None into a dict or None.

    Fixes the common issue where LLMs serialise nested JSON objects as plain
    strings, causing Pydantic ``dict`` validation to reject them.
    """
    if v is None:
        return None
    if isinstance(v, dict):
        return v
    if isinstance(v, str):
        v = v.strip()
        if not v:
            return None
        # Try JSON parse first (handles '{"url": "..."}' etc.)
        try:
            parsed = json.loads(v)
            if isinstance(parsed, dict):
                return parsed
        except (json.JSONDecodeError, ValueError):
            pass
        # Try <url>...</url> XML-ish pattern
        url_match = re.search(r"<url>\s*(.+?)\s*</url>", v, re.IGNORECASE)
        if url_match:
            return {"url": url_match.group(1).strip()}
        # Try bare URL pattern (http/https/file)
        url_match = re.match(r"^(https?://\S+|file:///\S+)$", v, re.IGNORECASE)
        if url_match:
            return {"url": url_match.group(0).strip()}
    # fallback: return as-is so downstream validation can surface a clear error
    return v


panel_set_ui_metadata = {
    "label": "右侧面板",
    "icon": "📺",
    "group": "hosted_panel",
    "description": (
        "已并入 platform：ui.show / ui.hide / ui.update。"
        "打开/关闭 EvoPanel 右侧面板（产物、资讯、网页内嵌、进度等）。"
        "用户要盯进度：collab-workflow / collabSubtaskTranscript / employeeProcess。"
    ),
}

# Backward compat for ui_metadata resolver
stage_set_ui_metadata = panel_set_ui_metadata

_PANEL_SET_TOOL_DESCRIPTION = """\
Control EvoPanel right-side panels (NOT mode_set). action show|hide|update|stream.
Deliverables: kind=artifacts, data.items[{type,path|url|content}].
Web for the user: kind=web-embed, data.url — do not only paste a bare link in chat.
Do not auto-open write preview after write/replace — only when user asks.
Progress (any chat): collab-workflow data.mainTaskId; collabSubtaskTranscript data.mainTaskId+subtaskId;
employeeProcess data.agentCode (taskId optional) — only when user should watch live progress (not after every platform call).
【self-evolution-bot · 2026-11-20 · 第87轮 · 模型:deepseek-v4.1-flash-1017】
改了什么：employeeProcess 那行由 data.taskId+agentCode 改为 data.agentCode (taskId optional)。
为什么：上一处只改了 _build_progress_surface 的校验，没改这段给模型看的描述——
校验说「只要 agentCode」，描述仍说「要 taskId+agentCode」，模型照描述传参就白传一个
taskId 或以为必须带 task，等于同一件事又写了两份且互相矛盾。
"""


def _first_str(*values: Any) -> str:
    for value in values:
        text = str(value or "").strip()
        if text:
            return text
    return ""


def _normalize_shell_path(raw: Any) -> str:
    """把 shell-page 的 path 归一成站内路径；不是站内路径返回 ""（由调用方报错）。

    【self-evolution-bot · 2026-11-21 · 第103轮 · 模型:deepseek-v4.1-flash-1017】
    改了什么：新增本函数，规则与前端 ``open-shell-page-stage.ts:normalizePath`` /
    ``shell-page-mount-table.ts:shellPageTabId`` 完全一致。
    为什么（本轮现网实测）：``ui.show(kind=shell-page, data.path="https://example.com")``
    返回 ok、日志里有 emit sent，右栏真的开出一个签 —— 契约写的是「path 必须是站内
    路径（以 / 开头），外网用 web-embed」，实际却照单全收。前端 normalizePath 对
    ``https://example.com`` 补成 ``/https://example.com``，于是出现一个永远挂不出来的
    空壳签，还把用户原来 /tasks 的签顶掉了。契约只有后端能拦，前端只能兜。
    判据：带 scheme（``a:``）、``//`` 开头、空串 → 一律拒；其余按前端规则归一。
    """
    p = str(raw or "").strip()
    if not p:
        return ""
    if re.match(r"^[a-zA-Z][a-zA-Z0-9+.\-]*:", p) or p.startswith("//"):
        return ""
    if p.startswith("#"):
        p = p[1:]
    if not p.startswith("/"):
        p = f"/{p}"
    p = p.split("?")[0].rstrip("/") or "/"
    # 与挂载表一致：/employees → /proactive
    if p == "/employees":
        return "/proactive"
    m = re.match(r"^/employees/([^/]+)$", p)
    if m:
        return f"/proactive/{m.group(1)}"
    return p


def _employee_process_tab_id(*, task_id: str, agent_code: str, session_key: str) -> str:
    """员工执行过程签的 id —— 与前端 ``employeeProcessStageTabId`` 同一规则。

    【self-evolution-bot · 2026-11-21 · 第103轮 · 模型:deepseek-v4.1-flash-1017】
    改了什么：新增本函数，id 从 ``process:{task_id or code}`` 改为按前端规则算。
    为什么（本轮现网实测）：我开 ``employeeProcess agentCode=xiaomi``，后端 surface.id
    是 ``process:xiaomi`` → keyHint ``employeeProcess:process:xiaomi``；前端实际建签
    是 ``process:live:xiaomi``（一人一签），真实 key ``employeeProcess:process:live:xiaomi``。
    模型照 keyHint 调 ui.activate 一定「目标签不存在」。根因就是同一规则写了两个版本。
    判据：对话侧 ``process:live:{code}``；任务中心（sessionKey 以 ``task-center:`` 开头）
    ``tc:process:{taskId|live:{code}}`` —— 逐字对齐前端。
    """
    code = str(agent_code or "").strip()
    tid = str(task_id or "").strip()
    if str(session_key or "").strip().startswith("task-center:"):
        base = tid or (f"live:{code}" if code else "")
        return f"tc:process:{base}" if base else ""
    if code:
        return f"process:live:{code}"
    return f"process:{tid}" if tid else ""


def _normalize_panel_kind(kind: str) -> str:
    k = str(kind or "").strip()
    aliases = {
        "write-stream": "write",
        "write_stream": "write",
        "workspace-write": "write",
        "workspace_write": "write",
        "artifact": "artifacts",
        "deliverable": "artifacts",
        "deliverables": "artifacts",
        "browser": "web-embed",
        "webpage": "web-embed",
        "web": "web-embed",
        "web_embed": "web-embed",
        "embed": "web-embed",
        "workflow": "collab-workflow",
        "collab_workflow": "collab-workflow",
        "collab-subtask": "collabSubtaskTranscript",
        "collab_subtask": "collabSubtaskTranscript",
        "subtask-transcript": "collabSubtaskTranscript",
        "subtask_transcript": "collabSubtaskTranscript",
        "employee-process": "employeeProcess",
        "employee_process": "employeeProcess",
        "employee": "employeeProcess",
        "employee-progress": "employeeProcess",
    }
    return aliases.get(k, k)


def _build_progress_surface(
    *,
    kind: str,
    payload_data: dict[str, Any],
    title: str | None,
    layout: str | None,
    session_key: str = "",
) -> tuple[dict[str, Any] | None, str | None]:
    """Validate progress kinds and return (surface, error)."""
    data = dict(payload_data)

    if kind == "collab-workflow":
        main_id = _first_str(
            data.get("mainTaskId"), data.get("main_task_id"), data.get("taskId"), data.get("task_id")
        )
        if not main_id:
            # 【self-evolution-bot · 2026-11-20 · 第87轮 · 模型:deepseek-v4.1-flash-1017】
            # 改了什么：缺字段报错补上「怎么查/怎么传」，指向 ui.kinds。
            # 为什么：只报缺什么，模型下一轮仍要猜第二个字段叫什么。
            return (
                None,
                "collab-workflow requires data.mainTaskId (or taskId); "
                "call platform action=ui.kinds for the full contract",
            )
        data["mainTaskId"] = main_id
        lead = _first_str(
            data.get("leadThreadId"),
            data.get("lead_thread_id"),
            data.get("threadId"),
            data.get("thread_id"),
        )
        if lead:
            data["leadThreadId"] = lead
        surface: dict[str, Any] = {
            "id": f"workflow:{main_id}",
            "kind": kind,
            "title": str(title or "").strip() or "工作流",
            "layout": layout or "half",
            "data": data,
        }
        return surface, None

    if kind == "collabSubtaskTranscript":
        main_id = _first_str(
            data.get("mainTaskId"), data.get("main_task_id"), data.get("taskId"), data.get("task_id")
        )
        sid = _first_str(data.get("subtaskId"), data.get("subtask_id"))
        if not main_id or not sid:
            return None, "collabSubtaskTranscript requires data.mainTaskId and data.subtaskId"
        data["mainTaskId"] = main_id
        data["subtaskId"] = sid
        lead = _first_str(
            data.get("leadThreadId"),
            data.get("lead_thread_id"),
            data.get("threadId"),
            data.get("thread_id"),
        )
        if lead:
            data["leadThreadId"] = lead
        label = str(title or "").strip() or _first_str(data.get("title")) or "节点进度"
        data["title"] = label
        surface = {
            "id": f"collabSubtaskTranscript:{sid}",
            "kind": kind,
            "title": label,
            "layout": layout or "wide",
            "data": data,
        }
        return surface, None

    if kind == "employeeProcess":
        # 【self-evolution-bot · 2026-11-20 · 第87轮 · 模型:deepseek-v4.1-flash-1017】
        # 改了什么：employeeProcess 只强制 agentCode，taskId 改为可选。
        # 为什么：契约真源（stage/right_panel_kinds.py）里 taskId 本就是可选——
        # 跟岗/唤醒场景只有 agent 没有 task，前端 open-progress-from-panel-set.ts
        # 早就只查 agentCode。是这里多要了一个 taskId，导致「模型按前端能开的方式
        # 调、后端却报错」这一类对不齐。生产侧自动开 CTA 一直靠 live:{code} 兜底
        # 才没暴露，属规则写了两份且不一致。
        task_id = _first_str(
            data.get("taskId"), data.get("task_id"), data.get("mainTaskId"), data.get("main_task_id")
        )
        code = _first_str(data.get("agentCode"), data.get("agent_code"), data.get("assigned_to"))
        if not code:
            return None, "employeeProcess requires data.agentCode"
        if task_id:
            data["taskId"] = task_id
        else:
            # 跟岗占位：不写假 taskId，避免拼出 proactive:…:task:live-… 这种死链
            data.pop("taskId", None)
            data.pop("task_id", None)
        data["agentCode"] = code
        round_id = _first_str(data.get("roundId"), data.get("round_id"), data.get("source_ref"))
        if round_id:
            data["roundId"] = round_id
        if "busy" in data:
            data["busy"] = bool(data.get("busy"))
        label = str(title or "").strip() or _first_str(data.get("title")) or "执行过程"
        data["title"] = label
        surface = {
            # 【self-evolution-bot · 2026-11-21 · 第103轮 · 模型:deepseek-v4.1-flash-1017】
            # 改了什么：id 不再自己拼 ``process:{taskId|code}``，改为调用
            # ``_employee_process_tab_id``（与前端 employeeProcessStageTabId 同一规则）。
            # 为什么：后端 ``process:xiaomi`` vs 前端 ``process:live:xiaomi``，
            #   keyHint 因此指向一个不存在的签（ui.activate 必失败）。
            "id": _employee_process_tab_id(
                task_id=task_id, agent_code=code, session_key=session_key
            )
            or f"process:{task_id or code}",
            "kind": kind,
            "title": label,
            "layout": layout or "wide",
            "data": data,
        }
        return surface, None

    if kind == "sessionRuntime":
        # 【self-evolution-bot · 2026-11-21 · 第103轮 · 模型:deepseek-v4.1-flash-1017】
        # 改了什么：补上 sessionRuntime 分支（契约里有必填 data.sessionKey，代码里没有）。
        # 为什么（本轮现网实测）：``ui.show(kind=sessionRuntime, data={})`` 被接受并 emit，
        #   前端 opener（open-progress-from-panel-set.ts）查不到 sessionKey 直接 return ''
        #   → 后端回 ok、用户屏幕上什么都没发生。对照 web-embed / employeeProcess 都会
        #   正确报缺字段，唯独这个 kind 静默通过。
        # 判据：缺 sessionKey 必须报错并指向 ui.kinds；补齐后 id 与前端
        #   ``sessionRuntime:${sessionKey}`` 逐字一致（后端原先写 primary）。
        sk_in = _first_str(data.get("sessionKey"), data.get("session_key"))
        if not sk_in:
            return (
                None,
                "sessionRuntime requires data.sessionKey "
                "(the session key, e.g. agent:main:new-xxxx); "
                "call platform action=ui.kinds for the full contract",
            )
        data["sessionKey"] = sk_in
        works = data.get("works")
        if works is not None and not isinstance(works, list):
            data.pop("works", None)
        surface = {
            "id": f"sessionRuntime:{sk_in}",
            "kind": kind,
            "title": str(title or "").strip() or "运行中",
            "layout": layout or "wide",
            "data": data,
        }
        return surface, None

    if kind == "shell-page":
        # 【self-evolution-bot · 2026-11-21 · 第103轮 · 模型:deepseek-v4.1-flash-1017】
        # 改了什么：补上 shell-page 分支 —— 校验必填 path、必须是站内路径、id 用
        #   ``shell:{归一后的 path}``（前端 shellPageTabId 的形状）。
        # 为什么（本轮现网实测两条）：① ``data.path="https://example.com"`` 被接受并真的
        #   开了个空壳签，还顶掉了用户原来的 /tasks 签；② 后端 id 恒为 primary，
        #   而前端真实 key 是 ``shell-page:shell:/tasks``，keyHint 因此永远是错的。
        norm = _normalize_shell_path(data.get("path") or data.get("route"))
        if not norm:
            raw_path = str(data.get("path") or data.get("route") or "").strip()
            if raw_path:
                return (
                    None,
                    "shell-page data.path must be an in-app path starting with '/' "
                    f"(got {raw_path!r}); for an external page use kind=web-embed with data.url",
                )
            return (
                None,
                "shell-page requires data.path (e.g. '/tasks'), an in-app path starting with '/'; "
                "call platform action=ui.kinds for the full contract",
            )
        data["path"] = norm
        data["route"] = norm
        label = str(title or "").strip() or _first_str(data.get("title")) or ""
        if label:
            data["title"] = label
        # 【self-evolution-bot · 2026-11-21 · 第103轮 · 模型:deepseek-v4.1-flash-1017】
        # 改了什么：没有可读名时**不再**把裸路径塞进 ``surface.title``（原为 ``label or norm``）。
        # 为什么（本轮真机实测抓到的回执缺陷）：``ui.show kind=shell-page data.path=/knowledge``
        #   不传 title 时，底层 surface.title 变成 ``"/knowledge"`` —— 回执里就写
        #   ``title: "/knowledge"``。用户签上最终显示的是「知识库」（前端
        #   resolveShellPageTabTitle 按挂载表兜底），所以签本身没错，错的是**回执**：
        #   模型自己读到的是一段路径，会以为名字丢了/要自己再传一遍。
        # 判据：路径不是名字。宁可留空让前端那唯一一份挂载表去兜底，
        #   也不要在后端再造一个"看起来像名字"的假值（两处真源必然漂移）。
        surface = {
            "id": f"shell:{norm}",
            "kind": kind,
            "layout": layout or "wide",
            "data": data,
        }
        if label:
            surface["title"] = label
        return surface, None

    return None, None


def _normalize_embed_url(raw: str) -> str:
    value = str(raw or "").strip()
    if not value:
        return ""
    if re.match(r"^https?://", value, re.IGNORECASE):
        return value
    if value.startswith("//"):
        return f"https:{value}"
    return f"https://{value}"


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


def _emit(event: dict[str, Any]) -> None:
    """把右栏事件推给前端。

    【self-evolution-bot · 2026-11-20 · 第100轮续 · 模型:deepseek-v4.1-flash-1017】
    改了什么：`except: pass` 改为记日志（含事件类型、action、是否真有 writer、失败原因）。
    为什么（用户当场指出 + 明确建议）：「我看你调用右侧工具的时候，右侧的侧边面板
      我没看到打开。如果你查不到问题的话，可以加一点日志呀。」
      此前这里一旦 writer 为 None 或抛异常，工具照样返回 ok，而屏幕上什么都没有 ——
      **工具层「成功」与「屏幕变了」之间没有任何留痕**，我只能靠猜。
      日志落到 gateway 日志文件，排查时直接 grep `[right-stage-emit]`。
    """
    action = event.get("action") or event.get("type")
    try:
        writer = get_stream_writer()
    except Exception as exc:  # noqa: BLE001 - 取不到 writer 也是重要事实
        _audit_emit("no-writer", event, action, detail=f"{type(exc).__name__}: {exc}")
        get_right_stage_logger().warning(
            "[right-stage-emit] no writer (error=%s) type=%s action=%s",
            type(exc).__name__,
            event.get("type"),
            action,
        )
        return
    if not callable(writer):
        # 这条最关键：工具返回值仍是 ok，但根本没有通道把事件送到前端。
        _audit_emit("writer-not-callable", event, action, detail=type(writer).__name__)
        get_right_stage_logger().warning(
            "[right-stage-emit] writer is not callable (writer=%r) type=%s action=%s",
            type(writer).__name__,
            event.get("type"),
            action,
        )
        return
    try:
        writer(event)
        _audit_emit("sent", event, action)
        get_right_stage_logger().info(
            "[right-stage-emit] sent type=%s action=%s surface=%s key=%s",
            event.get("type"),
            action,
            (event.get("surface") or {}).get("kind") if isinstance(event.get("surface"), dict) else None,
            event.get("key"),
        )
    except Exception as exc:  # noqa: BLE001 - 推送失败必须留痕，不许静默
        _audit_emit("writer-failed", event, action, detail=f"{type(exc).__name__}: {exc}")
        get_right_stage_logger().warning(
            "[right-stage-emit] writer failed (error=%s: %s) type=%s action=%s",
            type(exc).__name__,
            exc,
            event.get("type"),
            action,
        )


def _audit_emit(outcome: str, event: dict[str, Any], action: Any, detail: str | None = None) -> None:
    """把一次推送决策写进 ``right-stage-YYYY-MM-DD.log``（含事件全文）。

    【self-evolution-bot · 2026-11-20 · 第101轮 · 模型:deepseek-v4.1-flash-1017】
    改了什么：``_emit`` 的三个分支（取不到 writer / writer 不可调用 / 已发出）
    统一落到专用审计文件，而不是只写 stdlib logger。
    为什么（现网实测）：本轮检查 ``grep -c 'right-stage-emit'`` 在
      ``gateway-2026-11-20.log`` 与 ``langgraph-2026-11-20.log`` 里都是 **0** ——
      上一轮加的 logger 在这两个进程里根本没进文件（langgraph 会重建 logging 树）。
      于是「工具说 ok、屏幕没动」这个现象我依然查不了。改成直接写文件，
      与 ``browser_debug_log`` 同型：单锁 append、失败静默。
    判据：调一次右栏工具后 ``right-stage-<今天>.log`` 必须新增一行 ``[py]``；
      outcome 三态可区分（sent / no-writer / writer-failed），不许只写"成功"。
    """
    try:
        from evoflow.stage.right_stage_audit_log import right_stage_log

        payload = dict(event)
        right_stage_log(
            "py",
            f"emit {outcome} type={event.get('type')} action={action}"
            + (f" detail={detail}" if detail else "")
            + f" event={json.dumps(payload, ensure_ascii=False, default=str)}",
        )
    except Exception:  # noqa: BLE001 - 审计绝不冒泡
        pass


def _emit_surface(action: str, surface: dict[str, Any] | None = None) -> None:
    _emit({"type": "right_stage", "action": action, "surface": surface})


def _emit_stream(
    *,
    action: str,
    stream_id: str,
    text: str = "",
    path: str | None = None,
    fmt: str | None = None,
    title: str | None = None,
) -> None:
    payload: dict[str, Any] = {
        "type": "right_stage_stream",
        "action": action,
        "streamId": stream_id,
        "text": text,
    }
    if path:
        payload["path"] = path
    if fmt:
        payload["format"] = fmt
    if title:
        payload["title"] = title
    _emit(payload)


def _resolve_thread_id_loose() -> str:
    try:
        from langgraph.config import get_config

        return str(get_config().get("configurable", {}).get("thread_id") or "").strip()
    except Exception:
        return ""


def _resolve_session_key_loose(thread_id: str = "") -> str:
    tid = str(thread_id or "").strip() or _resolve_thread_id_loose()
    if not tid:
        return ""
    try:
        from evoflow.persistence.session_repositories import find_session_key_by_thread_id

        return str(find_session_key_by_thread_id(tid) or "").strip()
    except Exception:
        return ""


def apply_right_panel(
    *,
    action: str = "show",
    kind: str | None = None,
    data: dict[str, Any] | None = None,
    title: str | None = None,
    layout: str | None = None,
    stream_id: str | None = None,
    text: str | None = None,
    thread_id: str | None = None,
    session_key: str | None = None,
    expand: bool = False,
    key: str | None = None,
    target_key: str | None = None,
) -> dict[str, Any]:
    """Core right-panel driver used by ``platform ui.*`` (and legacy ``panel_set`` wrapper).

    Emits ``right_stage`` / ``right_stage_stream`` / ``chat_artifacts`` SSE; returns a
    plain result dict (no LangChain Command).

    【self-evolution-bot · 2026-11-20 · 第91轮 · 模型:deepseek-v4.1-flash-1017】
    改了什么：新增 ``expand`` 参数；为真时在 surface 上带 ``expand: true``。
    为什么：用户让我「直接用平台工具打开面板给他看」，我实测发现右栏一旦被用户
    收起（``userCollapsed`` = true），``ui.show`` 返回 ok 但**完全不撑开**，
    用户屏幕上什么都没有——工具说「已打开」，人看不见，这就是最直接的一步绕路。
    默认仍为 False，保持「模型不得抢用户视线」的既有语义；只有调用方
    （用户明确要求展示）显式传 expand 才撑开。
    """
    act = str(action or "show").strip().lower() or "show"
    tid = str(thread_id or "").strip() or _resolve_thread_id_loose()
    sk = str(session_key or "").strip() or _resolve_session_key_loose(tid)

    if act == "hide":
        if tid:
            clear_thread_stage(tid)
        _emit_surface("hide", None)
        # 【self-evolution-bot · 2026-11-21 · 第104轮 · 模型:deepseek-v4.1-flash-1017】
        # 改了什么：hide 回执补上 ``userScreen``，把「收起前有没有东西可收」如实说出来。
        # 为什么（本轮真机实测）：10:29:30 我调 ui.hide 拿到 ``ok:true``，但右栏纹丝不动，
        #   状态盘之后 24 秒仍写 collapsed=False / tabs=2 —— ok 只代表事件送出去了。
        #   真因（前端）已单独修：applyRemote 的 hide 派给 store.hide()（关一个签）而不是
        #   collapse()（整栏收起），遇到 shell-page 这类受保护 kind 直接 return 什么都不做。
        #   后端这一侧的判据是：收起动作必须回读一份「收起前快照」，让调用方下一轮能自己核对
        #   「到底收掉了几个签」，而不是继续把 ok 当结果。
        try:
            from app.gateway.routers.stage_right_panel import read_right_stage_state

            prev_hide = read_right_stage_state()
        except Exception:
            prev_hide = {"known": False}
        hide_out: dict[str, Any] = {"ok": True, "action": "hide", "surface": None}
        if prev_hide.get("known"):
            hide_tabs = prev_hide.get("tabs") or []
            hide_out["userScreen"] = {
                "known": True,
                "action": "hide",
                "before": {
                    "activeKey": prev_hide.get("activeKey") or None,
                    "collapsed": prev_hide.get("collapsed") is True,
                    "tabs": len(hide_tabs),
                },
                "expect": "整栏收起：面板占位消失，标签全部保留（不是关签）。",
                "verifyHint": "下一轮用 ui.current 看 collapsed 是否为 true；标签数应仍是 "
                f"{len(hide_tabs)}。若 collapsed 仍为 false，说明前端没收到或没处理这条 hide。",
            }
            if prev_hide.get("stale") is True:
                hide_out["userScreen"]["staleBefore"] = True
                hide_out["userScreen"]["ageSeconds"] = prev_hide.get("ageSeconds")
        return hide_out

    if act == "activate":
        # 【self-evolution-bot · 2026-11-20 · 第100轮 · 模型:deepseek-v4.1-flash-1017】
        # 改了什么：新增 act="activate" —— 把右栏**切到用户已有的某个标签页**。
        # 为什么（用户明确指出）：「你要知道当前是哪一个，然后怎么去切换到哪一个要处理好。」
        #   此前只有 show/update/hide：update 只能对着某个 kind 灌内容，hide 是整体收起，
        #   **没有任何"切到第 N 个签"的表达**。模型想让用户看回某页时只能重新 show 一遍，
        #   结果是同一份东西被新开成第二个签（用户原话担心的正是这个）。
        # 与 show 的区别（这是本动作存在的唯一理由）：
        #   show 会写标签/改 data，甚至 forceExpand 抢视线；
        #   activate **只改 activeKey**，不新建签、不改内容、不删内容，
        #   用户自己拉开的其它签原样保留（tabCount 不变）。
        target = str(key or "").strip()
        if not target:
            return {
                "ok": False,
                "action": "activate",
                "error": "key is required (read it from platform action=ui.current → activeKey/tabs[].key)",
            }
        _emit({"type": "right_stage", "action": "activate", "surface": None, "key": target})
        return {
            "ok": True,
            "action": "activate",
            "key": target,
            "note": "已请求前端切到该标签；只改当前查看的签，不新建/不关闭任何标签。",
            "userScreen": _describe_user_screen_for_activate(target),
        }

    if act == "close":
        # 【self-evolution-bot · 2026-11-20 · 第101轮 · 模型:deepseek-v4.1-flash-1017】
        # 改了什么：新增 action=close，只关**一个**标签，不动其它签、不整栏收起。
        # 为什么（用户当场要求，原话）：「你可以切换到哪个进行一个显示，或者是给它关掉，
        #   或者是打开，或者给它调换位置。就这种像人一样的操作。」
        #   此前只有 hide（整栏收起）：前端 store 明明有 closeTab(key)，后端一个动作都没暴露，
        #   模型想「关掉那一个」只能整栏收起，用户的其它签被一起藏了 —— 这不是人的操作。
        # 判据：close 必须带 key；发出去之后前端 tabCount 减 1，其它签的 key 原样保留。
        target = str(key or "").strip()
        if not target:
            return {
                "ok": False,
                "action": "close",
                "error": (
                    "key is required (read it from platform action=ui.current → tabs[].key). "
                    "若要整栏收起请用 ui.hide。"
                ),
            }
        _emit({"type": "right_stage", "action": "close", "surface": None, "key": target})
        return {
            "ok": True,
            "action": "close",
            "key": target,
            "note": "已请求前端关闭该标签；其它标签与整栏展开状态不受影响。",
            "userScreen": _describe_user_screen_for_close(target),
        }

    if act == "move":
        # 【self-evolution-bot · 2026-11-20 · 第101轮 · 模型:deepseek-v4.1-flash-1017】
        # 改了什么：新增 action=move，把某个标签调到另一个标签的位置（前端 reorderTab）。
        # 为什么：用户要求「给它调换位置」。前端 store 有 reorderTab(activeId, overId)，
        #   后端完全没有入口，模型无法做到 —— 用户只能自己拖。
        # 判据：move 必须同时带 key 与 target（目标位置那个签）；发出去之后
        #   tabCount 不变、两个签的先后顺序互换。
        src = str(key or "").strip()
        dst = str(target_key or "").strip() or str((data or {}).get("target") or "").strip()
        if not src or not dst:
            return {
                "ok": False,
                "action": "move",
                "error": (
                    "move requires key (要移动的签) and target (移到哪个签的位置)，"
                    "两个都从 platform action=ui.current → tabs[].key 取。"
                ),
            }
        if src == dst:
            return {"ok": False, "action": "move", "error": "key and target are the same tab"}
        _emit(
            {
                "type": "right_stage",
                "action": "move",
                "surface": None,
                "key": src,
                "target": dst,
            }
        )
        return {
            "ok": True,
            "action": "move",
            "key": src,
            "target": dst,
            "note": "已请求前端调整标签顺序；不新建、不关闭、不改内容。",
        }

    if act == "stream":
        sid = str(stream_id or "write_file").strip() or "write_file"
        chunk = str(text or "")
        path = (data or {}).get("path") if isinstance(data, dict) else None
        fmt = (data or {}).get("format") if isinstance(data, dict) else None
        _emit_stream(
            action="write",
            stream_id=sid,
            text=chunk,
            path=str(path or "") or None,
            fmt=str(fmt or "") or None,
        )
        if tid:
            set_thread_stage(tid, kind="write", data={"streamId": sid, "path": path, "format": fmt})
        return {"ok": True, "action": "stream", "streamId": sid, "chars": len(chunk)}

    k = _normalize_panel_kind(kind or "")
    if k in ("browser-live", "browser_live"):
        return {"ok": False, "error": "browser-live is no longer supported"}
    if not k:
        return {"ok": False, "error": "kind is required for show/update"}

    payload_data = dict(data or {})
    if k == "artifacts":
        return _apply_artifacts_panel(
            act=act,
            payload_data=payload_data,
            title=title,
            layout=layout,
            thread_id=tid,
            session_key=sk,
        )

    panel_title = title
    if k == "web-embed":
        page_url = _normalize_embed_url(
            str(payload_data.get("url") or payload_data.get("href") or payload_data.get("link") or "")
        )
        if act in ("show", "update") and not page_url:
            return {"ok": False, "error": "web-embed requires data.url (or href/link)"}
        if page_url:
            payload_data["url"] = page_url
            payload_data["editable"] = True
            if not panel_title:
                panel_title = "浏览器"

    if k in ("collab-workflow", "collabSubtaskTranscript", "employeeProcess", "sessionRuntime", "shell-page"):
        # 【self-evolution-bot · 2026-11-21 · 第103轮 · 模型:deepseek-v4.1-flash-1017】
        # 改了什么：把 sessionRuntime / shell-page 也交给 _build_progress_surface 校验，
        #   并把 session_key 传进去（employeeProcess 的签 id 规则要用它区分任务中心）。
        # 为什么：这两个 kind 此前落到下面「通用分支」，surface.id 恒为 primary —— 既不做
        #   必填校验（缺 sessionKey 也 emit），又让 keyHint 与前端真实 key 不符。
        progress_surface, err = _build_progress_surface(
            kind=k,
            payload_data=payload_data,
            title=panel_title,
            layout=layout,
            session_key=sk,
        )
        if err or not progress_surface:
            return {"ok": False, "error": err or "invalid progress panel"}
        surface = progress_surface
        if expand:
            surface["expand"] = True
        if act == "update":
            _emit_surface("update", surface)
        else:
            _emit_surface("show", surface)
        if tid:
            set_thread_stage(tid, kind=k, data=surface.get("data"))
        # 【self-evolution-bot · 2026-11-20 · 第100轮 · 模型:deepseek-v4.1-flash-1017】
        # 为什么必须在这里也补：进度类面板（collab-workflow / collabSubtaskTranscript /
        # employeeProcess）走的是这条**独立 return 分支**，主分支加的 userScreen 覆盖不到。
        # 我第一次只改了主分支，测试当场红——这就是「改一处、漏另一处」的老毛病。
        return {
            "ok": True,
            "action": act,
            "kind": k,
            "surface": surface,
            "userScreen": _describe_user_screen_before_after(
                act=act, kind=k, surface=surface, expand=expand
            ),
        }

    surface = {
        "id": "primary",
        "kind": k,
        "data": payload_data,
    }
    if layout:
        surface["layout"] = layout
    elif k == "write":
        surface["layout"] = "workspace-write"
    if panel_title:
        surface["title"] = panel_title
    # 【self-evolution-bot · 2026-11-20 · 第91轮 · 模型:deepseek-v4.1-flash-1017】
    # 非进度类面板（web-embed / shell-page / file / mind-map …）同样要能把
    # 「用户明确要我看」透传到前端，否则用户收起右栏后 ui.show 就是空转。
    if expand:
        surface["expand"] = True

    if act == "update":
        _emit_surface("update", surface)
    else:
        _emit_surface("show", surface)
        if k == "write":
            sid = str((data or {}).get("streamId") or "write_file")
            fmt = str((data or {}).get("format") or "plain")
            path = str((data or {}).get("path") or "")
            _emit_stream(action="open", stream_id=sid, path=path or None, fmt=fmt or None)

    if tid:
        set_thread_stage(tid, kind=k, data=surface.get("data"))

    return {
        "ok": True,
        "action": act,
        "kind": k,
        "surface": surface,
        # 【self-evolution-bot · 2026-11-20 · 第100轮 · 模型:deepseek-v4.1-flash-1017】
        # 改了什么：每次开/更新面板都带回「用户原本在看哪一页」以及是否被顶掉。
        # 为什么（用户明确指出）：模型开面板时不知道用户右栏正在看什么，抢了视线自己还不知道。
        #   现在把 before/after 一起回给调用方，模型下一句就能说清楚「我把你原来的 X 换成 Y 了」。
        "userScreen": _describe_user_screen_before_after(
            act=act, kind=k, surface=surface, expand=expand
        ),
    }


def _infer_tab_key(
    *,
    kind: str,
    surface: dict[str, Any],
    tabs: Any,
) -> str:
    """推算这个 surface 在前端的真实 tab key。

    【self-evolution-bot · 2026-11-21 · 第103轮 · 模型:deepseek-v4.1-flash-1017】
    改了什么：删掉「shell-page 自己按 path 推算 key」那段特例，收敛成唯一一条规则。
    为什么：那段的根因判断错了 —— 问题不在 keyHint 的算法，而在 surface.id 本身
      （后端恒为 primary）。修了 id 之后（shell-page→shell:{path}、
      sessionRuntime→sessionRuntime:{sk}、employeeProcess→process:live:{code}），
      ``${kind}:${id}`` 就逐字等于前端 ``tabKeyOf``。留着特例等于同一条规则写两份，
      下次任何一侧改 id 规则，这里就会再飘一次 —— 正是本轮缺陷的同一个根因。
    判据：先在用户已开的签里按 kind+id 找到真实 key（字面值最可信）；找不到再按
      store 的 ``${kind}:${id}`` 推算。
    """
    kind_s = str(kind or "").strip()
    ident = str(surface.get("id") or "").strip()
    if isinstance(tabs, list) and ident:
        for t in tabs:
            if not isinstance(t, dict):
                continue
            if str(t.get("kind") or "") == kind_s and str(t.get("id") or "") == ident:
                real = str(t.get("key") or "").strip()
                if real:
                    return real
    return f"{kind_s}:{ident}" if ident else ""


def _describe_user_screen_before_after(
    *,
    act: str,
    kind: str,
    surface: dict[str, Any],
    expand: bool = False,
) -> dict[str, Any]:
    """把「用户原本停在哪一页」与「这次操作是复用还是新开」如实描述出来。"""
    try:
        from app.gateway.routers.stage_right_panel import read_right_stage_state

        prev = read_right_stage_state()
    except Exception:
        prev = {"known": False}

    if not prev.get("known"):
        return {
            "known": False,
            "note": "前端还没上报过右栏状态，无法判断是否抢了用户的视线。",
        }

    prev_key = str(prev.get("activeKey") or "")
    prev_kind = str(prev.get("activeKind") or "")
    # 【self-evolution-bot · 2026-11-21 · 第102轮 · 模型:deepseek-v4.1-flash-1017】
    # 改了什么：``reusedSameKindTab`` 改为按「目标 key 是否已在用户已开的标签里」判，
    #   不再只看「activeKind 是否等于本次 kind」。
    # 为什么（本轮现网实测 08:12:05）：我 ui.show path=/tasks 时右栏其实**新建了第 2 个签**
    #   （web-state 紧接着上报 tabs=2），而回执写 ``reusedSameKindTab: true`` +
    #   「用户原本就在同类页面上，本次多半是原地更新」—— 两句都与事实相反。
    #   根因：上一次 activeKind 也是 ``shell-page``，但它是 ``/proactive`` 那一签；
    #   "同 kind" 不等于 "同一个签"，shell-page 一个 kind 底下有几十个页面。
    # 判据：本工具已经算出真实 key（``_infer_tab_key``），直接拿它去比对用户已开的签；
    #   命中才算复用，未命中就是新开 —— 与前端 ``tabKeyOf`` 的唯一事实一致。
    target_key_hint = _infer_tab_key(kind=kind, surface=surface, tabs=prev.get("tabs") or [])
    existing_keys = {str((t or {}).get("key") or "") for t in (prev.get("tabs") or [])}
    reused = bool(target_key_hint) and target_key_hint in existing_keys
    # 【self-evolution-bot · 2026-11-20 · 第101轮 · 模型:deepseek-v4.1-flash-1017】
    # 改了什么：``keyHint`` 改为按前端真实 tabKeyOf 规则算，不再硬套 ``${kind}:${id}``；
    #   同时优先从用户已开的标签里找同 kind 同 path 的真实 key。
    # 为什么（本轮现网实测）：我开 ``shell-page path=/tasks``，工具回我
    #   ``keyHint="shell-page:primary"``，而真实 key 是 ``shell-page:shell:/tasks``
    #   （前端 ``shell-page:${shellPageTabId(path)}``）。模型照 keyHint 去调 ui.activate
    #   必然「目标签不存在」—— 这个错提示是我上一轮引入的。
    # 判据：shell-page 的 keyHint 必须含 path 段；能在当前 tabs 里找到同 kind 同 path 时，
    #   直接返回那个真实 key（用户看到的字面值）。
    # （第102轮：这一行原本在这里重复计算 target_key_hint / same_kind，已上移到 reused 判据处；
    #   same_kind 这条"同 kind"判据实测与事实相反，已彻底删除，不要再加回来。）
    # 【self-evolution-bot · 2026-11-20 · 第101轮 · 模型:deepseek-v4.1-flash-1017】
    # 改了什么：把「本次写入用户到底看不看得见」算成一个显式布尔 ``visible``，
    #   并在看不见时给出可执行的下一步（传 expand=True 重发），而不是只丢个 ok。
    # 为什么（本轮现网实测）：23:22:57 我调 ui.show（未传 expand），工具返回 ok:true，
    #   同一秒 web-state 上报 ``collapsed=True`` —— 右栏压根没撑开，用户屏幕上没有东西。
    #   我把 expand=true 补进参数后再发一次，23:23:28 上报变成 ``collapsed=False``。
    #   同一条工具、同一秒的双侧日志证明：ok 只代表「事件送到了」，不代表「用户看见了」。
    # 判据：右栏处于收起态且本次没带 expand → ``visible`` 必须为 False 且带 hint；
    #   带 expand=True 或本来就没收起 → ``visible`` 为 True。不许再出现「ok 但看不见」无提示。
    prev_collapsed = prev.get("collapsed") is True
    visible = (not prev_collapsed) or bool(expand) or act == "update"
    out: dict[str, Any] = {
        "known": True,
        "action": act,
        "visible": visible,
        "before": {
            "activeKey": prev_key or None,
            "activeKind": prev_kind or None,
            "activeTitle": prev.get("activeTitle") or None,
            "collapsed": prev.get("collapsed") is True,
        },
        "target": {"kind": kind, "id": surface.get("id") or "primary", "keyHint": target_key_hint},
        # 同一 kind 通常沿用同一个签（store.tabKeyOf）；换 kind 才会多一个签。
        # 【第102轮更正】但「同 kind」≠「同一个签」：shell-page 一个 kind 下有几十个页面。
        # 复用的判据必须是目标 key 已在用户已开标签里，见上面 target_key_hint 的注释。
        "reusedSameKindTab": reused,
        "mayStealFocus": bool(prev_key) and not reused and act != "update",
        "note": (
            "目标签本来就在，本次是原地更新，不会多出标签。"
            if reused
            else "本次会在右栏多开一个标签（原标签保留）；若担心抢视线，用 ui.update 或先问一句。"
        ),
    }
    if not visible:
        out["hint"] = (
            "右栏当前处于收起状态，本次只写入了标签、用户屏幕上没有任何变化。"
            "若确实要让用户看到，请带 expand=True 重发一次；否则请如实告诉用户"
            "「已准备好，但你的右栏是收起的」。"
        )
        out["note"] = "用户右栏是收起的；本次写入不可见。"
    return out


def _describe_user_screen_for_activate(target_key: str) -> dict[str, Any]:
    """切换动作的前后描述：目标签在不在、切完会不会多出/少掉一个签。

    【self-evolution-bot · 2026-11-20 · 第100轮 · 模型:deepseek-v4.1-flash-1017】
    为什么单写一份：``_describe_user_screen_before_after`` 的判据是「kind 是否相同」，
    而 activate 的判据是「这个 key 在不在用户已开的标签里」——两者混用会把
    「切到不存在签」误报成「复用成功」，那正是用户担心的情况（他一拉开东西就被顶掉）。
    """
    try:
        from app.gateway.routers.stage_right_panel import read_right_stage_state

        prev = read_right_stage_state()
    except Exception:
        prev = {"known": False}

    if not prev.get("known"):
        return {
            "known": False,
            "target": target_key,
            "note": (
                "前端还没上报过右栏状态，无法确认该标签是否存在；"
                "切换请求已发出，但请以用户看到的为准。"
            ),
        }

    tabs = prev.get("tabs") if isinstance(prev.get("tabs"), list) else []
    keys = [str((t or {}).get("key") or "") for t in tabs]
    exists = target_key in keys
    prev_key = str(prev.get("activeKey") or "")
    return {
        "known": True,
        "target": target_key,
        "targetExists": exists,
        "before": {
            "activeKey": prev_key or None,
            "activeKind": prev.get("activeKind") or None,
            "activeTitle": prev.get("activeTitle") or None,
            "collapsed": prev.get("collapsed") is True,
        },
        # 切签不动标签集合：tabCount 前后必须一样，用户拉开的东西不会被关掉。
        "tabCountBefore": len(keys),
        "tabCountAfter": len(keys),
        "note": (
            "目标签确实存在，已切过去（其它标签原样保留）。"
            if exists
            else f"目标签不在用户当前标签里（现有 {len(keys)} 个：{keys}）；"
            "请先 ui.current 核对 key，或改用 ui.show 新建。已开的标签不会被关掉。"
        ),
    }


def _describe_user_screen_for_close(target_key: str) -> dict[str, Any]:
    """关闭单个标签的前后描述：签数必须减 1，且不碰整栏展开状态。

    【self-evolution-bot · 2026-11-21 · 第102轮 · 模型:deepseek-v4.1-flash-1017】
    为什么单写一份（真机实测抓到的串台）：close 分支原先直接复用
    ``_describe_user_screen_for_activate``，于是 ``ui.close`` 的回执里写着
    「已切过去（其它标签原样保留）」和 ``tabCountBefore == tabCountAfter`` ——
    两句话对关闭操作**全是错的**：关签恰恰要少一个签、也根本不切当前签。
    判据：close 的回执必须给 ``tabCountAfter = 前 - 1``，并且显式说明
    「整栏展开状态不受影响」，与 ui.hide（整栏收起、签还在）区分开。
    """
    try:
        from app.gateway.routers.stage_right_panel import read_right_stage_state

        prev = read_right_stage_state()
    except Exception:
        prev = {"known": False}

    if not prev.get("known"):
        return {
            "known": False,
            "target": target_key,
            "note": "前端还没上报过右栏状态，无法确认该标签是否存在；关闭请求已发出。",
        }

    tabs = prev.get("tabs") if isinstance(prev.get("tabs"), list) else []
    keys = [str((t or {}).get("key") or "") for t in tabs]
    exists = target_key in keys
    return {
        "known": True,
        "action": "close",
        "target": target_key,
        "targetExists": exists,
        "tabCountBefore": len(keys),
        # 关签就是少一个；目标不存在则签数不变（前端会忽略该请求）。
        "tabCountAfter": (len(keys) - 1) if exists else len(keys),
        "note": (
            "目标签确实存在，已请求关闭它；整栏展开状态与其它标签不受影响。"
            if exists
            else f"目标签不在用户当前标签里（现有 {len(keys)} 个：{keys}）；"
            "请先 ui.current 核对 key。若要收起整栏请用 ui.hide。"
        ),
    }


def _apply_artifacts_panel(
    *,
    act: str,
    payload_data: dict[str, Any],
    title: str | None,
    layout: str | None,
    thread_id: str,
    session_key: str,
) -> dict[str, Any]:
    from evoflow.artifacts.chat_artifact import artifact_state_key, normalize_chat_artifacts

    raw_items = payload_data.get("items")
    if raw_items is None and (payload_data.get("path") or payload_data.get("url") or payload_data.get("content")):
        raw_items = [payload_data]
    normalized = normalize_chat_artifacts(raw_items)
    if act in ("show", "update") and not normalized:
        return {
            "ok": False,
            "error": "artifacts requires data.items[{type, path|url|content, name?}]",
        }

    tid = str(thread_id or "").strip()
    sk = str(session_key or "").strip()
    saved: list[dict[str, Any]] = []
    if sk and normalized:
        try:
            from evoflow.persistence.artifact_repositories import upsert_artifacts

            saved = upsert_artifacts(sk, tid or sk, normalized)
        except Exception as exc:
            return {"ok": False, "error": f"persist failed: {exc}"}
    else:
        saved = [{**it, "status": it.get("status") or "new"} for it in normalized]

    panel_items = [
        {
            "id": it.get("id"),
            "type": it.get("type") or "file",
            "path": it.get("path") or "",
            "url": it.get("url") or "",
            "name": it.get("name") or "",
            "label": it.get("label") or "",
            "mime": it.get("mime") or "",
            "status": it.get("status") or "new",
            "size": it.get("size"),
        }
        for it in saved
    ]
    data_out = {
        "items": panel_items,
        "focusPath": str(payload_data.get("focusPath") or "").strip()
        or next((str(x.get("path") or "") for x in panel_items if x.get("path")), ""),
        "focusId": str(payload_data.get("focusId") or "").strip()
        or (str(panel_items[0].get("id") or "") if panel_items else ""),
    }
    surface: dict[str, Any] = {
        "id": "primary",
        "kind": "artifacts",
        "title": str(title or "").strip() or "本轮产物",
        "data": data_out,
        "layout": layout or "workspace-write",
    }
    if act == "update":
        _emit_surface("update", surface)
    else:
        _emit_surface("show", surface)
    if tid:
        set_thread_stage(tid, kind="artifacts", data=data_out)
    if panel_items:
        _emit(
            {
                "type": "chat_artifacts",
                "action": "upsert",
                "sessionKey": sk,
                "threadId": tid,
                "items": panel_items,
            }
        )
    state_keys = [k for k in (artifact_state_key(it) for it in saved) if k]
    out: dict[str, Any] = {
        "ok": True,
        "action": act,
        "kind": "artifacts",
        "count": len(panel_items),
        "items": panel_items,
        "surface": surface,
    }
    if state_keys:
        out["artifact_state_keys"] = state_keys
    return out


@tool("panel_set", description=_PANEL_SET_TOOL_DESCRIPTION, parse_docstring=False)
def panel_set_tool(
    action: Annotated[
        Literal["show", "hide", "update", "stream"],
        Field(description="show|hide|update|stream"),
    ],
    kind: Annotated[
        str | None,
        Field(
            default=None,
            description=(
                "DEPRECATED: use platform action=ui.show. "
                "artifacts | web-embed | … | collab-workflow | collabSubtaskTranscript | employeeProcess."
            ),
        ),
    ] = None,
    data: Annotated[
        dict[str, Any] | None,
        BeforeValidator(_coerce_to_dict_or_none),
        Field(default=None, description="Panel payload (deprecated tool)."),
    ] = None,
    layout: Annotated[str | None, Field(default=None, description="half|wide|narrow|workspace-write")] = None,
    title: Annotated[str | None, Field(default=None, description="Panel title")] = None,
    stream_id: Annotated[str | None, Field(default=None, description="stream id")] = None,
    text: Annotated[str | None, Field(default=None, description="stream text chunk")] = None,
    *,
    runtime: ToolRuntime[ContextT, Any],
    tool_call_id: Annotated[str, InjectedToolCallId],
) -> Command | str:
    """Deprecated standalone tool — prefer ``platform`` ``ui.show`` / ``ui.hide``."""
    tid = _resolve_thread_id(runtime)
    sk = _resolve_session_key(runtime)
    result = apply_right_panel(
        action=action,
        kind=kind,
        data=data,
        title=title,
        layout=layout,
        stream_id=stream_id,
        text=text,
        thread_id=tid,
        session_key=sk,
    )
    # Preserve artifacts state update for any residual callers still binding this tool.
    if result.get("ok") and result.get("kind") == "artifacts" and tool_call_id:
        state_keys = result.get("artifact_state_keys") or []
        payload = {k: v for k, v in result.items() if k != "artifact_state_keys"}
        message = ToolMessage(content=json.dumps(payload, ensure_ascii=False), tool_call_id=tool_call_id)
        update: dict[str, Any] = {"messages": [message]}
        if state_keys:
            update["artifacts"] = state_keys
        return Command(update=update)
    return json.dumps(result, ensure_ascii=False)


# Legacy export name (tool wire name is panel_set). Not registered in get_available_tools.
stage_set_tool = panel_set_tool
