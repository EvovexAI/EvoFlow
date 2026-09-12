"""Per-thread EvoFlow workspace: query / create dir / set root (syncs to EvoPanel via custom stream)."""

from __future__ import annotations

import json
import logging
from typing import Literal

from langchain.tools import ToolRuntime, tool
from langgraph.typing import ContextT

from evoflow.agents.thread_state import ThreadState
from evoflow.tools.builtins.session_workspace_ops import (
    format_workspace_reply,
    workspace_mkdir,
    workspace_query_payload,
)

logger = logging.getLogger(__name__)

session_workspace_tool_ui_metadata = {
    "label": "工作空间",
    "icon": "📁",
    "group": "workspace",
    "description": "查询当前会话工作目录、创建文件夹、指定项目根目录（会同步到 EvoPanel 会话）",
}


@tool("session_workspace", parse_docstring=True)
def session_workspace_tool(
    runtime: ToolRuntime[ContextT, ThreadState],
    action: Literal["query", "create"],
    path: str | None = None,
) -> str:
    """Manage the EvoFlow chat session workspace (project root for Claude Code / tools).

    Args:
        action: ``query`` — show ``local_workspace_root`` from context, resolved path, cwd;
            ``create`` — ``mkdir -p`` (requires ``path``).
        path: Directory path for ``create``.

    Returns:
        JSON string with ``ok``, details, and human hints.
    """
    cfg = {}
    try:
        cfg = (getattr(runtime, "config", None) or {}).get("configurable") or {}
        if not isinstance(cfg, dict):
            cfg = {}
    except Exception:
        cfg = {}

    if action == "query":
        payload = workspace_query_payload(cfg)
        return json.dumps({"text": format_workspace_reply(payload), **payload}, ensure_ascii=False)

    if action == "create":
        if not (path or "").strip():
            return json.dumps({"ok": False, "error": "path is required for create"}, ensure_ascii=False)
        payload = workspace_mkdir(path or "")
        return json.dumps({"text": format_workspace_reply(payload), **payload}, ensure_ascii=False)

    return json.dumps({"ok": False, "error": f"unknown action: {action}"}, ensure_ascii=False)
