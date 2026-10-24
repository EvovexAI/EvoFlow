"""MCP tool annotation registry — 风险分级用的 hints 记录。

langchain-mcp-adapters 把 MCP 协议的 ``annotations``（readOnlyHint /
destructiveHint / idempotentHint 等）平铺进 ``tool.metadata``。审批层
（``tool_approval_config._mcp_tool_risk``）只拿得到工具名，拿不到工具对象，
因此这里在工具加载时按 qualified name（``mcp__<server>__<tool>``，小写）
登记 hints，审批层查表。

生命周期与 MCP 工具缓存一致：``cache.reset_mcp_tools_cache`` 时清空，
重建（配置指纹失效 / warmup）时重新登记。查不到登记 = 未知工具，走默认分级。
"""

from __future__ import annotations

import logging
import threading
from typing import Any

logger = logging.getLogger(__name__)

_lock = threading.Lock()
_records: dict[str, dict[str, Any]] = {}


def _qualified_key(tool_name: str) -> str:
    return str(tool_name or "").strip().lower()


def record_tool_annotations(tool: Any) -> None:
    """从 langchain 工具对象提取 annotations hints 并登记。

    metadata 形态（langchain-mcp-adapters）：
    ``{**annotations.model_dump(), "_meta": {...}}`` — hints 平铺在顶层。
    非 MCP 工具（无 mcp__ 前缀或无 hints）静默跳过。
    """
    name = _qualified_key(getattr(tool, "name", ""))
    if not name.startswith("mcp__"):
        return
    meta = getattr(tool, "metadata", None)
    if not isinstance(meta, dict):
        return
    hints = {
        key: meta[key]
        for key in ("readOnlyHint", "destructiveHint", "idempotentHint")
        if key in meta
    }
    if not hints:
        return
    with _lock:
        _records[name] = hints


def record_tools_annotations(tools: list[Any]) -> int:
    """批量登记；返回登记成功的数量（仅日志用）。"""
    count = 0
    for tool in tools or []:
        try:
            before = len(_records)
            record_tool_annotations(tool)
            if len(_records) > before:
                count += 1
        except Exception:  # noqa: BLE001 - 登记失败不影响工具加载
            logger.debug("Failed to record MCP annotations", exc_info=True)
    return count


def get_tool_hints(tool_name: str) -> dict[str, Any] | None:
    """按 qualified name 查 hints；未登记返回 None。"""
    with _lock:
        return _records.get(_qualified_key(tool_name))


def reset_tool_annotations() -> None:
    with _lock:
        _records.clear()


def snapshot() -> dict[str, dict[str, Any]]:
    with _lock:
        return dict(_records)
