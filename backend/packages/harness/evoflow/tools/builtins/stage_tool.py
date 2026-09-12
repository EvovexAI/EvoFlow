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
        "打开/关闭 EvoPanel 右侧面板（产物、资讯、网页内嵌、写入内容、工作区等）。"
        "交付物用 kind=artifacts；正文路径用 @@…@@ 括起。"
        "给用户看网页用 kind=web-embed + data.url，不要只在聊天里贴链接。"
        "与 mode_set 工具（激活 plan/agent 对话模式）无关；"
        "Agent 模式系统必带，无需 tool_search 加载"
    ),
}

# Backward compat for ui_metadata resolver
stage_set_ui_metadata = panel_set_ui_metadata

_PANEL_SET_TOOL_DESCRIPTION = """\
Control EvoPanel right-side panels (NOT mode_set). action show|hide|update|stream.
Deliverables: kind=artifacts, data.items[{type,path|url|content}]; wrap file paths in chat as @@…@@.
Web for the user: kind=web-embed, data.url — do not only paste a bare link in chat.
Do not auto-open write preview after write/replace — only when user asks.
"""


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
    }
    return aliases.get(k, k)


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


def _handle_artifacts_panel(
    *,
    act: str,
    payload_data: dict[str, Any],
    title: str | None,
    layout: str | None,
    runtime: ToolRuntime[ContextT, Any],
    tool_call_id: str,
) -> Command | str:
    """kind=artifacts: persist session deliverables (append) + open/update panel."""
    from evoflow.artifacts.chat_artifact import artifact_state_key, normalize_chat_artifacts

    raw_items = payload_data.get("items")
    if raw_items is None and (
        payload_data.get("path") or payload_data.get("url") or payload_data.get("content")
    ):
        raw_items = [payload_data]
    normalized = normalize_chat_artifacts(raw_items)
    if act in ("show", "update") and not normalized:
        return json.dumps(
            {
                "ok": False,
                "error": "artifacts requires data.items[{type, path|url|content, name?}]",
            },
            ensure_ascii=False,
        )

    tid = _resolve_thread_id(runtime)
    sk = _resolve_session_key(runtime)
    saved: list[dict[str, Any]] = []
    if sk and normalized:
        try:
            from evoflow.persistence.artifact_repositories import upsert_artifacts

            saved = upsert_artifacts(sk, tid or sk, normalized)
        except Exception as exc:
            return json.dumps(
                {"ok": False, "error": f"persist failed: {exc}"},
                ensure_ascii=False,
            )
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
    payload = {"ok": True, "action": act, "kind": "artifacts", "count": len(panel_items), "items": panel_items}
    message = ToolMessage(content=json.dumps(payload, ensure_ascii=False), tool_call_id=tool_call_id)
    update: dict[str, Any] = {"messages": [message]}
    if state_keys:
        update["artifacts"] = state_keys
    return Command(update=update)


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
                "artifacts | web-embed | news-dashboard | workspace-browse | write | mind-map | collab-workflow. "
                "Deliverables: artifacts + data.items[{type,path|url|content}]. Web: web-embed + data.url."
            ),
        ),
    ] = None,
    data: Annotated[
        dict[str, Any] | None,
        BeforeValidator(_coerce_to_dict_or_none),
        Field(
            default=None,
            description="Panel payload. artifacts: {items:[…]}; web-embed: {url}.",
        ),
    ] = None,
    layout: Annotated[str | None, Field(default=None, description="half|wide|narrow|workspace-write")] = None,
    title: Annotated[str | None, Field(default=None, description="Panel title")] = None,
    stream_id: Annotated[str | None, Field(default=None, description="stream id")] = None,
    text: Annotated[str | None, Field(default=None, description="stream text chunk")] = None,
    *,
    runtime: ToolRuntime[ContextT, Any],
    tool_call_id: Annotated[str, InjectedToolCallId],
) -> Command | str:
    """Open/update/hide EvoPanel right-side UI panels."""
    act = str(action or "show").strip().lower()
    tid = _resolve_thread_id(runtime)

    if act == "hide":
        if tid:
            clear_thread_stage(tid)
        _emit_surface("hide", None)
        return json.dumps({"ok": True, "action": "hide", "surface": None}, ensure_ascii=False)

    if act == "stream":
        sid = str(stream_id or "write_file").strip() or "write_file"
        chunk = str(text or "")
        path = (data or {}).get("path") if isinstance(data, dict) else None
        fmt = (data or {}).get("format") if isinstance(data, dict) else None
        _emit_stream(action="write", stream_id=sid, text=chunk, path=str(path or "") or None, fmt=str(fmt or "") or None)
        if tid:
            set_thread_stage(tid, kind="write", data={"streamId": sid, "path": path, "format": fmt})
        return json.dumps({"ok": True, "action": "stream", "streamId": sid, "chars": len(chunk)}, ensure_ascii=False)

    k = _normalize_panel_kind(kind or "")
    if k in ("browser-live", "browser_live"):
        return json.dumps({"ok": False, "error": "browser-live is no longer supported"}, ensure_ascii=False)
    if not k:
        return json.dumps({"ok": False, "error": "kind is required for show/update"}, ensure_ascii=False)

    payload_data = dict(data or {})
    if k == "artifacts":
        return _handle_artifacts_panel(
            act=act,
            payload_data=payload_data,
            title=title,
            layout=layout,
            runtime=runtime,
            tool_call_id=tool_call_id,
        )

    if k == "web-embed":
        page_url = _normalize_embed_url(
            str(payload_data.get("url") or payload_data.get("href") or payload_data.get("link") or "")
        )
        if act in ("show", "update") and not page_url:
            return json.dumps(
                {"ok": False, "error": "web-embed requires data.url (or href/link)"},
                ensure_ascii=False,
            )
        if page_url:
            payload_data["url"] = page_url
            # Keep address bar editable so users can fix / re-navigate when iframe is blocked.
            payload_data["editable"] = True
            if not title:
                title = "浏览器"

    surface: dict[str, Any] = {
        "id": "primary",
        "kind": k,
        "data": payload_data,
    }
    if layout:
        surface["layout"] = layout
    elif k == "write":
        surface["layout"] = "workspace-write"
    if title:
        surface["title"] = title

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

    return json.dumps(
        {"ok": True, "action": act, "kind": k, "surface": surface},
        ensure_ascii=False,
    )


# Legacy export name (tool wire name is panel_set)
stage_set_tool = panel_set_tool
