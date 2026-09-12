"""Non-overridable dangerous pattern denylist for tool calls.

This layer runs BEFORE risk-level assessment in ``ToolApprovalMiddleware``.
Even when the session policy is ``grant_all``, patterns matched here are blocked
unconditionally — they cannot be overridden by any user or policy setting.

Design:
- Pattern registry: ``tool_name → [(compiled_regex, human_reason)]``
- ``is_dangerous(tool_name, args)`` → ``(blocked, reason)``
- Compound tools (``worker``) are decomposed: each sub-task is checked individually.
- To add a new dangerous pattern, append to the appropriate ``_PATTERNS`` list.

Integration point:
    ``ToolApprovalMiddleware.wrap_tool_call`` / ``awrap_tool_call`` — called first,
    before ``tool_requires_approval``.
"""

from __future__ import annotations

import re
from typing import Any

# ── Terminal / process command dangerous patterns ───────────
# Matched against the raw ``command`` string (case-insensitive).
_TERMINAL_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    # ── Recursive force-deletion of critical paths ──
    (
        re.compile(
            r"\brm\s+(-[a-z]*r[a-z]*\s+)?(-[a-z]*f[a-z]*\s+)?"
            r"(/(\s|$|\*)|~(\s|$)|\$HOME(\s|$)|\*(\s|$))",
            re.I,
        ),
        "递归删除根目录 / 主目录 / 通配符 — 可能造成不可恢复的数据丢失",
    ),
    (
        re.compile(r"\brm\s+(-[a-z]*r[a-z]*\s+)?(-[a-z]*f[a-z]*\s+)?\.\.(/|$)", re.I),
        "递归删除上级目录 — 可能造成意外数据丢失",
    ),
    # ── Git force push ──
    (
        re.compile(r"\bgit\s+push\s+.*(--force\b|--force-with-lease\b|-f\b)", re.I),
        "git force push — 会覆盖远程提交历史，不可恢复",
    ),
    # ── Disk / filesystem operations ──
    (re.compile(r"\bmkfs\b", re.I), "格式化文件系统 — 不可恢复"),
    (re.compile(r"\bformat\s+[a-z]:", re.I), "格式化磁盘 — 不可恢复"),
    (re.compile(r"\bdd\s+if=", re.I), "dd 磁盘操作 — 可能覆盖磁盘数据"),
    # ── Fork bomb ──
    (
        re.compile(r":\(\)\s*\{\s*:\s*\|\s*&\s*\}\s*;\s*:", re.I),
        "Fork bomb — 会导致系统资源耗尽",
    ),
    # ── Remote code execution via pipe ──
    (
        re.compile(r"\b(curl|wget)\b.*\|\s*(bash|sh|zsh)\b", re.I),
        "远程代码执行 — 从网络下载并直接执行脚本，极其危险",
    ),
    # ── Privilege escalation + dangerous command ──
    (
        re.compile(r"\bsudo\s+(rm|mkfs|dd|format|chmod|chown)\b", re.I),
        "提权执行危险命令 — 可能造成系统级损坏",
    ),
    # ── chmod 777 recursive ──
    (
        re.compile(r"\bchmod\s+(-[a-z]*r[a-z]*\s+)?777\b", re.I),
        "递归设置 777 权限 — 安全风险极高",
    ),
]

# ── Delete path dangerous patterns ──────────────────────────
# Matched against the ``path`` argument.
_DELETE_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    # ── Git directory ──
    (
        re.compile(
            r"(\.git[/\\](config|HEAD|refs|objects|hooks|index|packed-refs)|\.git[/\\]?$)",
            re.I,
        ),
        "删除 .git 目录 — 会破坏版本控制历史",
    ),
    # ── Unix system paths ──
    (
        re.compile(r"^/(etc|usr|bin|sbin|boot|proc|sys|dev|lib)(/|$)", re.I),
        "删除系统关键目录 — 可能导致系统不可用",
    ),
    # ── Windows system paths ──
    (
        re.compile(r"^[a-z]:\\(windows|system32|program files|boot|programdata)(\\|$)", re.I),
        "删除 Windows 系统目录 — 可能导致系统不可用",
    ),
]

# ── Registry: tool name → patterns ───────────────────────────
_DANGEROUS_REGISTRY: dict[str, list[tuple[re.Pattern[str], str]]] = {
    "terminal": _TERMINAL_PATTERNS,
    "process": _TERMINAL_PATTERNS,
    "process_start": _TERMINAL_PATTERNS,
    "delete": _DELETE_PATTERNS,
}


def _extract_match_text(tool_name: str, args: dict[str, Any]) -> str:
    """Extract the text to pattern-match against for a given tool."""
    if tool_name in ("terminal", "process", "process_start"):
        return str(args.get("command") or "")
    if tool_name == "delete":
        return str(args.get("path") or args.get("file_path") or args.get("target_file") or "")
    return ""


def _check_worker_tasks(args: dict[str, Any]) -> tuple[bool, str | None]:
    """Decompose worker tasks and check each delete target against denylist."""
    tasks = args.get("tasks")
    if not isinstance(tasks, list):
        return False, None
    for task in tasks:
        if not isinstance(task, dict):
            continue
        action = str(task.get("action") or "").strip().lower()
        if action != "delete":
            continue
        path = str(task.get("path") or "")
        for pattern, reason in _DELETE_PATTERNS:
            if pattern.search(path):
                return True, f"[worker delete] {reason}"
    return False, None


def _check_system_tools(tool_name: str, args: dict[str, Any]) -> tuple[bool, str | None]:
    """Check if a command uses a blocked system-level tool.

    When ``system_tools.enabled`` is False (default), commands starting with
    any tool in ``blocked_tools`` are blocked unconditionally.
    """
    name = str(tool_name or "").strip().lower()
    if name not in ("terminal", "process", "process_start"):
        return False, None
    if name == "process":
        action = str((args or {}).get("action") or "start").strip().lower()
        if action != "start":
            return False, None
    command = str((args or {}).get("command") or "").strip()
    if not command:
        return False, None
    try:
        from evoflow.persistence.security_settings_repositories import get_security_settings

        settings = get_security_settings()
        sys_tools = settings.get("system_tools", {})
        if sys_tools.get("enabled", False):
            return False, None  # System tools enabled — don't block
        blocked = sys_tools.get("blocked_tools", [])
        cmd_lower = command.lower().strip()
        for tool in blocked:
            t = str(tool).strip().lower()
            if not t:
                continue
            if cmd_lower == t or cmd_lower.startswith(t + " ") or cmd_lower.startswith(t + "\t"):
                return True, f"系统级工具 {tool} 已被安全策略禁用"
    except Exception:
        pass
    return False, None


def is_dangerous(
    tool_name: str,
    args: dict[str, Any] | None = None,
) -> tuple[bool, str | None]:
    """Check if a tool call matches a non-overridable dangerous pattern.

    Returns:
        ``(True, reason)`` — the call must be blocked; no policy can override.
        ``(False, None)``  — safe to proceed with normal approval flow.

    This function is intentionally side-effect free and fast (regex only).
    """
    name = str(tool_name or "").strip().lower()
    args = args or {}

    # Compound tool: worker — decompose and check each sub-task
    if name == "worker":
        return _check_worker_tasks(args)

    # Security center: system-level tool blocklist (before pattern matching)
    sys_blocked, sys_reason = _check_system_tools(name, args)
    if sys_blocked:
        return True, sys_reason

    # Simple tools: look up in registry
    patterns = _DANGEROUS_REGISTRY.get(name)
    if not patterns:
        return False, None

    text = _extract_match_text(name, args)
    if not text:
        return False, None

    for pattern, reason in patterns:
        if pattern.search(text):
            return True, reason

    return False, None


__all__ = ["is_dangerous"]
