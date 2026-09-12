"""Shared workspace helpers for ``session_workspace`` tool and Claude Code slash commands."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Literal

WorkspaceVerb = Literal["query", "create", "set"]


def emit_session_workspace_to_client(local_workspace_root: str, *, use_virtual_paths: bool = False) -> None:
    """Notify EvoPanel (stream_mode=custom) to merge ``local_workspace_root`` into the active session map."""
    try:
        from langgraph.config import get_stream_writer

        w = get_stream_writer()
        if callable(w):
            w(
                {
                    "type": "evoflow_session_workspace",
                    "local_workspace_root": local_workspace_root,
                    "use_virtual_paths": bool(use_virtual_paths),
                }
            )
    except Exception:
        pass


def normalize_workspace_dir(raw: str) -> tuple[str | None, str | None]:
    """Return ``(resolved_absolute, error)`` for an on-disk workspace root."""
    p = (raw or "").strip()
    if not p:
        return None, "path is empty"
    try:
        expanded = Path(p).expanduser()
        resolved = str(expanded.resolve())
        return resolved, None
    except OSError as e:
        return None, str(e)


def workspace_query_payload(configurable: dict[str, Any]) -> dict[str, Any]:
    """Current thread workspace from runtime context (and cwd fallback)."""
    cfg = configurable or {}
    raw = str(cfg.get("local_workspace_root") or "").strip()
    thread_id = str(cfg.get("thread_id") or "").strip()
    resolved, err = (None, None)
    if raw:
        resolved, err = normalize_workspace_dir(raw)
    exists: bool | None = None
    is_dir: bool | None = None
    if resolved:
        try:
            p = Path(resolved)
            exists = p.exists()
            is_dir = p.is_dir()
        except OSError:
            exists, is_dir = None, None
    return {
        "ok": True,
        "action": "query",
        "thread_id": thread_id or None,
        "local_workspace_root": raw or None,
        "resolved": resolved,
        "resolve_error": err,
        "exists": exists,
        "is_dir": is_dir,
        "cwd": str(Path.cwd()),
        "use_virtual_paths": cfg.get("use_virtual_paths"),
    }


def workspace_mkdir(path: str) -> dict[str, Any]:
    """Create a directory tree (parents=True)."""
    resolved, err = normalize_workspace_dir(path)
    if err or not resolved:
        return {"ok": False, "action": "create", "error": err or "invalid path"}
    try:
        Path(resolved).mkdir(parents=True, exist_ok=True)
    except OSError as e:
        return {"ok": False, "action": "create", "error": str(e), "path": resolved}
    return {"ok": True, "action": "create", "path": resolved}


def workspace_specify(path: str) -> dict[str, Any]:
    """Validate directory exists and return resolved path for Claude / panel."""
    resolved, err = normalize_workspace_dir(path)
    if err or not resolved:
        return {"ok": False, "action": "set", "error": err or "invalid path"}
    try:
        p = Path(resolved)
        if not p.exists():
            return {"ok": False, "action": "set", "error": f"path does not exist: {resolved}", "path": resolved}
        if not p.is_dir():
            return {"ok": False, "action": "set", "error": f"not a directory: {resolved}", "path": resolved}
    except OSError as e:
        return {"ok": False, "action": "set", "error": str(e), "path": resolved}
    return {"ok": True, "action": "set", "local_workspace_root": resolved}


_WS_LINE = re.compile(
    r"^/workspace\s+(?P<verb>[^\s]+)(?:\s+(?P<arg>.+))?\s*$",
    re.IGNORECASE | re.DOTALL,
)

_VERB_QUERY = frozenset({"query", "查询", "list", "status"})
_VERB_CREATE = frozenset({"create", "新增", "mkdir", "md"})
_VERB_SET = frozenset({"set", "指定", "use", "使用"})


def parse_workspace_slash_command(message: str) -> tuple[WorkspaceVerb, str | None] | None:
    """Parse a whole-user-message ``/workspace …`` command. Returns ``(verb, arg)`` or None."""
    text = (message or "").strip()
    m = _WS_LINE.match(text)
    if not m:
        return None
    raw_verb = (m.group("verb") or "").strip().lower()
    arg = (m.group("arg") or "").strip() or None
    if raw_verb in _VERB_QUERY:
        if arg:
            return None
        return "query", None
    if raw_verb in _VERB_CREATE:
        return "create", arg
    if raw_verb in _VERB_SET:
        return "set", arg
    return None


def format_workspace_reply(payload: dict[str, Any]) -> str:
    """Short human-readable line for chat + JSON for scripts."""
    head = "[工作空间]"
    if not payload.get("ok", True):
        return f"{head} {payload.get('action', '')} 失败: {payload.get('error', 'unknown')}"
    action = payload.get("action")
    if action == "query":
        lines = [
            f"{head} 查询",
            f"- thread_id: {payload.get('thread_id')}",
            f"- local_workspace_root (context): {payload.get('local_workspace_root')}",
            f"- resolved: {payload.get('resolved')}",
            f"- exists/is_dir: {payload.get('exists')}/{payload.get('is_dir')}",
            f"- cwd: {payload.get('cwd')}",
        ]
        return "\n".join(lines) + "\n\n" + json.dumps(payload, ensure_ascii=False, indent=2)
    if action == "create":
        return f"{head} 已创建目录: {payload.get('path')}"
    if action == "set":
        return f"{head} 已指定工作空间（后续 Claude Code 将用此目录；已尝试同步到面板）: {payload.get('local_workspace_root')}"
    return f"{head} {json.dumps(payload, ensure_ascii=False)}"
