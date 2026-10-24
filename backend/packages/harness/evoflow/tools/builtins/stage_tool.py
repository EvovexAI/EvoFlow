"""Drive EvoPanel right-side UI panels (not conversation ``scenario`` modes)."""

from __future__ import annotations

import json
import re
from typing import Annotated, Any, Literal

from langchain.tools import InjectedToolCallId, ToolRuntime, tool
from langchain_core.messages import ToolMessage
from langgraph.config import get_stream_writer
from langgraph.types import Command
from langgraph.typing import ContextT
from pydantic import BeforeValidator, Field

from evoflow.stage.stage_context import clear_thread_stage, set_thread_stage


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
employeeProcess data.taskId+agentCode — only when user should watch live progress (not after every platform call).
"""


def _first_str(*values: Any) -> str:
    for value in values:
        text = str(value or "").strip()
        if text:
            return text
    return ""


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
) -> tuple[dict[str, Any] | None, str | None]:
    """Validate progress kinds and return (surface, error)."""
    data = dict(payload_data)

    if kind == "collab-workflow":
        main_id = _first_str(
            data.get("mainTaskId"), data.get("main_task_id"), data.get("taskId"), data.get("task_id")
        )
        if not main_id:
            return None, "collab-workflow requires data.mainTaskId (or taskId)"
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
        task_id = _first_str(
            data.get("taskId"), data.get("task_id"), data.get("mainTaskId"), data.get("main_task_id")
        )
        code = _first_str(data.get("agentCode"), data.get("agent_code"), data.get("assigned_to"))
        if not task_id or not code:
            return None, "employeeProcess requires data.taskId and data.agentCode"
        data["taskId"] = task_id
        data["agentCode"] = code
        round_id = _first_str(data.get("roundId"), data.get("round_id"), data.get("source_ref"))
        if round_id:
            data["roundId"] = round_id
        if "busy" in data:
            data["busy"] = bool(data.get("busy"))
        label = str(title or "").strip() or _first_str(data.get("title")) or "执行过程"
        data["title"] = label
        surface = {
            "id": f"process:{task_id}",
            "kind": kind,
            "title": label,
            "layout": layout or "wide",
            "data": data,
        }
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
    try:
        writer = get_stream_writer()
        if callable(writer):
            writer(event)
    except Exception:
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
) -> dict[str, Any]:
    """Core right-panel driver used by ``platform ui.*`` (and legacy ``panel_set`` wrapper).

    Emits ``right_stage`` / ``right_stage_stream`` / ``chat_artifacts`` SSE; returns a
    plain result dict (no LangChain Command).
    """
    act = str(action or "show").strip().lower() or "show"
    tid = str(thread_id or "").strip() or _resolve_thread_id_loose()
    sk = str(session_key or "").strip() or _resolve_session_key_loose(tid)

    if act == "hide":
        if tid:
            clear_thread_stage(tid)
        _emit_surface("hide", None)
        return {"ok": True, "action": "hide", "surface": None}

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

    if k in ("collab-workflow", "collabSubtaskTranscript", "employeeProcess"):
        progress_surface, err = _build_progress_surface(
            kind=k,
            payload_data=payload_data,
            title=panel_title,
            layout=layout,
        )
        if err or not progress_surface:
            return {"ok": False, "error": err or "invalid progress panel"}
        surface = progress_surface
        if act == "update":
            _emit_surface("update", surface)
        else:
            _emit_surface("show", surface)
        if tid:
            set_thread_stage(tid, kind=k, data=surface.get("data"))
        return {"ok": True, "action": act, "kind": k, "surface": surface}

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

    return {"ok": True, "action": act, "kind": k, "surface": surface}


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
