"""Human-friendly stream activity labels (match evopanel tool-display icons/short labels)."""

from __future__ import annotations

import json
from typing import Any

from evoflow.tools.chat_panel_tools import tool_omit_from_chat_panel

_ICON: dict[str, str] = {
    "search_code_index": "🔍",
    "find": "📂",
    "find_file": "📂",
    "read": "📄",
    "read_file": "📄",
    "rg": "🔎",
    "grep": "🔎",
    "web_search": "🌐",
    "web_fetch": "🌐",
    "fetch_url": "🌐",
    "terminal": "⌨️",
    "bash": "⌨️",
    "write": "✏️",
    "write_to_file": "✏️",
    "write_file": "✏️",
    "replace": "✏️",
    "str_replace": "✏️",
    "replace_in_file": "✏️",
    "delete_file": "🗑️",
    "delete": "🗑️",
    "supervisor": "📋",
    "subagent": "🤖",
    "task": "🤖",
    "list_dir": "📂",
    "ls": "📂",
    "assets": "🗂️",
}

_SHORT: dict[str, str] = {
    "search_code_index": "工作区搜索",
    "find": "找文件",
    "find_file": "找文件",
    "read": "读取",
    "read_file": "读取",
    "rg": "内容搜",
    "grep": "内容搜",
    "web_search": "搜索",
    "web_fetch": "抓取",
    "fetch_url": "抓取",
    "terminal": "终端",
    "bash": "终端",
    "write": "写入",
    "write_to_file": "写入",
    "write_file": "写入",
    "replace": "编辑",
    "str_replace": "编辑",
    "replace_in_file": "编辑",
    "delete_file": "删除",
    "delete": "删除",
    "supervisor": "任务",
    "subagent": "子代理",
    "task": "子代理",
    "list_dir": "目录",
    "ls": "目录",
    "read_lints": "诊断",
    "assets": "资产",
}


def _normalize_key(name: str) -> str:
    return str(name or "tool").strip().lower()


def _parse_tool_call_args(tc: dict[str, Any]) -> dict[str, Any]:
    direct = tc.get("args") or tc.get("input") or tc.get("parameters")
    if isinstance(direct, dict):
        return direct
    fn = tc.get("function") if isinstance(tc.get("function"), dict) else None
    if fn and isinstance(fn.get("arguments"), str):
        raw = str(fn.get("arguments") or "").strip()
        if raw:
            try:
                parsed = json.loads(raw)
                return parsed if isinstance(parsed, dict) else {}
            except Exception:
                return {}
    return {}


def _label(name: str) -> str:
    key = _normalize_key(name)
    icon = _ICON.get(key, "🔧")
    short = _SHORT.get(key) or key.replace("_", " ")[:8] or "工具"
    return f"{icon} {short}"


def _worker_task_labels(args: dict[str, Any]) -> list[str]:
    tasks = args.get("tasks") if isinstance(args.get("tasks"), list) else []
    out: list[str] = []
    for task in tasks:
        if not isinstance(task, dict):
            continue
        action = str(task.get("action") or "").strip().lower()
        if action == "search":
            out.append(_label("search_code_index"))
        elif action == "locate":
            out.append(_label("find"))
        elif action in {"write", "replace", "edit"}:
            out.append(_label("write_to_file"))
        elif action == "delete":
            out.append(_label("delete_file"))
    return out


def labels_for_tool_call(tc: dict[str, Any]) -> list[str]:
    if not isinstance(tc, dict):
        return []
    name = str(tc.get("name") or (tc.get("function") or {}).get("name") or "tool").strip()
    key = _normalize_key(name)
    if tool_omit_from_chat_panel(tc):
        return []
    if key == "worker":
        return _worker_task_labels(_parse_tool_call_args(tc))
    label = _label(key)
    if key in {"write", "write_file", "write_to_file", "replace", "str_replace", "replace_in_file"}:
        args = _parse_tool_call_args(tc)
        path = str(args.get("path") or args.get("target_file") or args.get("file_path") or "").strip()
        if path:
            short = path.replace("\\", "/").rsplit("/", 1)[-1] or path
            return [f"{label} · {short}"]
    return [label]


def format_activity_detail_from_tool_calls(
    tool_calls: list[dict[str, Any]] | None,
    *,
    latest_only: bool = False,
) -> str:
    calls = [c for c in (tool_calls or []) if isinstance(c, dict)]
    if latest_only and calls:
        calls = calls[-1:]
    labels: list[str] = []
    seen: set[str] = set()
    for tc in calls:
        if not isinstance(tc, dict):
            continue
        for lab in labels_for_tool_call(tc):
            if lab in seen:
                continue
            seen.add(lab)
            labels.append(lab)
    if not labels:
        return "调用工具…"
    return f"调用：{' · '.join(labels)}"
