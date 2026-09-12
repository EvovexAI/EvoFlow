"""Read-only tools + short tool loop for meeting speak (optional 查证 mode)."""

from __future__ import annotations

import json
import logging
from typing import Any

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.tools import StructuredTool

logger = logging.getLogger(__name__)

_MAX_TOOL_ROUNDS = 3
_TOOL_RESULT_CAP = 1800


def _clip(text: str, n: int = _TOOL_RESULT_CAP) -> str:
    s = str(text or "").strip()
    if len(s) <= n:
        return s
    return s[: n - 1] + "…"


def build_meeting_verify_tools(*, agent_code: str, role: Any) -> list[StructuredTool]:
    """Read-only tools bound to one employee for a single speak turn."""
    code = str(agent_code or "").strip().lower()

    def lookup_my_tasks(query: str = "") -> str:
        """查本岗近期任务（含未结/已完成）。可选关键词过滤。只读。"""
        from evoflow.proactive.work_items import (
            format_meeting_task_memory_for_prompt,
            list_role_recent_tasks,
        )

        tasks = list_role_recent_tasks(role, limit=20)
        q = str(query or "").strip().lower()
        if q:
            tasks = [
                t
                for t in tasks
                if q in str(t.get("title") or "").lower()
                or q in str(t.get("id") or "").lower()
                or q in str(t.get("status") or "").lower()
            ]
        if not tasks:
            return "（无匹配任务）" if q else "（暂无登记任务）"
        return _clip(format_meeting_task_memory_for_prompt(tasks))

    def search_my_assets(query: str, kinds: str = "all") -> str:
        """在本岗 Asset Hub 中搜索记忆/反思/经验（只读）。kinds=facts,journal,craft,episodic,all"""
        from evoflow.assets.paths import EntityRef
        from evoflow.assets.search import search_entity_assets

        q = str(query or "").strip()
        if not q:
            return "需要提供 query"
        try:
            ent = EntityRef("employee", code)
            res = search_entity_assets(
                ent,
                q,
                kinds=str(kinds or "all"),
                max_results=8,
                include_inbox=False,
            )
        except Exception as e:
            return f"搜索失败: {e}"
        matches = res.get("matches") or []
        if not matches:
            return "（无匹配资产）"
        lines = []
        for m in matches[:8]:
            if isinstance(m, dict):
                lines.append(
                    f"- {m.get('path')}:{m.get('matchLine')}: {_clip(str(m.get('snippet') or ''), 200)}"
                )
            else:
                lines.append(f"- {_clip(str(m), 200)}")
        return _clip("\n".join(lines))

    def read_my_asset(path: str) -> str:
        """读取本岗资产中心某一相对路径（只读，如 memory/journal/2026-08-28.md）。"""
        from evoflow.assets.hub import read_text_file
        from evoflow.assets.paths import EntityRef

        rel = str(path or "").strip().lstrip("/")
        if not rel:
            return "需要 path"
        if ".." in rel or rel.startswith(("profile/SOUL", "profile/soul")):
            return "该路径不允许在会议室读取"
        try:
            out = read_text_file(EntityRef("employee", code), rel)
            body = str((out or {}).get("content") or (out or {}).get("text") or out or "")
            return _clip(body, 2400)
        except Exception as e:
            return f"读取失败: {e}"

    return [
        StructuredTool.from_function(
            lookup_my_tasks,
            name="lookup_my_tasks",
            description="查本岗近期任务板（只读）。可选 query 过滤标题/状态。",
        ),
        StructuredTool.from_function(
            search_my_assets,
            name="search_my_assets",
            description="搜索本岗记忆/反思/经验资产（只读）。",
        ),
        StructuredTool.from_function(
            read_my_asset,
            name="read_my_asset",
            description="读取本岗资产文件相对路径（只读）。",
        ),
    ]


def _tool_by_name(tools: list[StructuredTool]) -> dict[str, StructuredTool]:
    return {str(t.name): t for t in tools}


def _run_tool(tools: list[StructuredTool], name: str, args: dict[str, Any]) -> str:
    mapping = _tool_by_name(tools)
    tool = mapping.get(str(name or "").strip())
    if not tool:
        return f"未知工具: {name}"
    try:
        raw = tool.invoke(args or {})
        if isinstance(raw, (dict, list)):
            return _clip(json.dumps(raw, ensure_ascii=False))
        return _clip(str(raw))
    except Exception as e:
        return f"工具错误: {e}"


def _message_text(msg: Any) -> str:
    content = getattr(msg, "content", None)
    if content is None:
        return ""
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            if isinstance(block, dict):
                parts.append(str(block.get("text") or ""))
            else:
                parts.append(str(block))
        return "".join(parts).strip()
    return str(content).strip()


async def ainvoke_meeting_speak_with_tools(
    *,
    model: Any,
    system: str,
    user: str,
    tools: list[StructuredTool],
) -> str:
    """Short tool loop then final oral text. Falls back to last AI text if needed."""
    from evoflow.context.internal_model_invoke import ainvoke_internal_chat_model

    bound = model.bind_tools(tools)
    messages: list[Any] = [
        SystemMessage(content=system),
        HumanMessage(content=user),
    ]
    last_text = ""

    for _round in range(_MAX_TOOL_ROUNDS):
        response = await ainvoke_internal_chat_model(bound, messages)
        text = _message_text(response)
        if text:
            last_text = text
        tool_calls = list(getattr(response, "tool_calls", None) or [])
        if not tool_calls:
            return text or last_text
        messages.append(response if isinstance(response, AIMessage) else AIMessage(
            content=getattr(response, "content", "") or "",
            tool_calls=tool_calls,
        ))
        for tc in tool_calls:
            name = str(tc.get("name") if isinstance(tc, dict) else getattr(tc, "name", "") or "")
            args = tc.get("args") if isinstance(tc, dict) else getattr(tc, "args", None)
            if not isinstance(args, dict):
                args = {}
            tid = str(tc.get("id") if isinstance(tc, dict) else getattr(tc, "id", "") or name)
            result = _run_tool(tools, name, args)
            messages.append(ToolMessage(content=result, tool_call_id=tid))

    # Force a final no-tool answer
    messages.append(
        HumanMessage(
            content="查证已结束。请只输出最终圆桌口头发言（方案讨论约 120～220 字，同步约 60～120 字），不要再调用工具。"
        )
    )
    try:
        final = await ainvoke_internal_chat_model(model, messages)
        return _message_text(final) or last_text
    except Exception:
        logger.debug("meeting tool speak final invoke failed", exc_info=True)
        return last_text
