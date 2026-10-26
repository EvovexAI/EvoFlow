"""小V工具边界：``platform`` + bash + read + assets（记忆/画像） + 全量 MCP；其余工程师写仓面仍禁止。

不问澄清空转——先 ``employees.org_status`` / ``board_overview`` / ``brief``，
再 ``employees.dispatch`` / ``wake``；文档走 ``knowledge.search``；行政一律 ``platform``。
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any

# 小V 强制挂载：系统 platform（读写视图与行政同源）
XIAOMI_SYSTEM_TOOL_NAMES = frozenset({"platform"})

# 额外内置：bash（终端）、read（只读文件；别名 read_file 在别名归一前过滤，两个名字都放行）、
# assets（记忆/画像/经验读写 — 仍受会话记忆开关门控）
XIAOMI_EXTRA_BUILTIN_TOOLS = frozenset({"bash", "read", "read_file", "assets"})

# 角色配置 tools 白名单默认（可配置面）；系统工具另由 get_xiaomi_tools 强制挂载
XIAOMI_DEFAULT_CONFIG_TOOLS = ("bash",)

XIAOMI_ALLOWED_TOOLS = frozenset(XIAOMI_SYSTEM_TOOL_NAMES | XIAOMI_EXTRA_BUILTIN_TOOLS)

# 兼容旧名 / 文档：写仓 / 澄清等仍拒
XIAOMI_DENIED_FRONTLINE = frozenset(
    {
        "ask_clarification",
        "write_file",
        "write",
        "write_to_file",
        "edit_file",
        "str_replace",
        "replace",
        "replace_in_file",
        "apply_patch",
        "notebook_edit",
        "multi_edit",
        "delete_file",
        "delete",
        "move_file",
        "terminal",
        "process",
        "plan",
        "supervisor",
        "task",
        "tool_search",
        "write_file",
        "web_search",
        "fetch_url",
    }
)
XIAOMI_DENIED_ASK = XIAOMI_DENIED_FRONTLINE


def is_xiaomi_mcp_tool_name(name: str) -> bool:
    """True for native ``mcp__server__tool`` (and legacy ``server__tool``)."""
    try:
        from evoflow.mcp.binding import is_mcp_tool_name

        return bool(is_mcp_tool_name(name))
    except Exception:
        n = str(name or "").strip()
        return n.startswith("mcp__") and "__" in n[5:]


def is_xiaomi_allowed_tool_name(name: str) -> bool:
    n = str(name or "").strip().lower()
    if not n:
        return False
    if n in XIAOMI_DENIED_FRONTLINE:
        return False
    if n in XIAOMI_ALLOWED_TOOLS:
        return True
    if is_xiaomi_mcp_tool_name(n):
        return True
    return False


def xiaomi_bound_tool_name_set() -> frozenset[str]:
    """Session/proactive allowlist for non-MCP names (MCP allowed by name pattern)."""
    return frozenset(XIAOMI_SYSTEM_TOOL_NAMES | XIAOMI_EXTRA_BUILTIN_TOOLS)


def filter_xiaomi_tools(
    tools: Iterable[Any],
    *,
    session_mode: str | None = None,
    intent_hint: str | None = None,
) -> list[Any]:
    """Keep platform + bash + MCP; drop engineer write/clarify surface."""
    _ = session_mode, intent_hint
    out: list[Any] = []
    seen: set[str] = set()
    for t in tools:
        name = str(getattr(t, "name", "") or "").strip()
        key = name.lower()
        if not key or key in seen:
            continue
        if not is_xiaomi_allowed_tool_name(key):
            continue
        seen.add(key)
        out.append(t)
    return out


def merge_xiaomi_system_tools(filtered: Iterable[Any], system_tools: Iterable[Any]) -> list[Any]:
    """Ensure platform is present after filtering the lead catalog."""
    out = list(filtered or [])
    have = {str(getattr(t, "name", "") or "").strip().lower() for t in out}
    for t in system_tools or []:
        name = str(getattr(t, "name", "") or "").strip().lower()
        if not name or name in have:
            continue
        out.append(t)
        have.add(name)
    return out
