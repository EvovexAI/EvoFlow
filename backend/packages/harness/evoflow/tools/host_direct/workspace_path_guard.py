"""Resolve host-direct file paths (workspace hint optional; no confinement to workspace root)."""

from __future__ import annotations

import functools
import logging
import os
from pathlib import Path
from typing import Any

from evoflow.tools.host_direct.workspace_context import resolve_tool_workspace_root
from evoflow.utils.bundled_tools import from_bash_posix_path
from evoflow.utils.workspace_browse import (
    flatten_bound_workspace_absolute,
    resolve_bound_workspace_file,
    strip_bound_workspace_prefix,
)

logger = logging.getLogger(__name__)

NO_WORKSPACE_BOUND = "Error: No workspace bound to this session. Select a local workspace in the UI, then retry."
# Kept for compatibility; path confinement is disabled.
PATH_ESCAPE = "Error: Path escapes the bound workspace. Use a path under the selected workspace root."
WORKDIR_ESCAPE = "Error: Working directory must be inside the bound workspace."


def _is_absolute_path(raw: str, expanded: str) -> bool:
    norm = str(raw or "").replace("\\", "/")
    return bool(os.path.isabs(expanded) or (len(norm) >= 2 and norm[1] == ":"))


def runtime_with_workspace(root: str, thread_id: str | None = None) -> Any:
    """Minimal runtime for scheduler/tests with a fixed workspace root."""

    class _Ctx:
        def get(self, key: str, default: Any = None) -> Any:
            data = {
                "local_workspace_root": str(root or "").strip(),
                "thread_id": str(thread_id or "test"),
            }
            return data.get(key, default)

    try:
        # 【self-evolution-bot · 2026-11-19 · 第65轮 · 模型:deepseek-v4.1-flash-1017】
        # 真构造实例用真类；直取 langgraph.prebuilt 以避免 `langchain.tools` 拉 torch。
        from langgraph.prebuilt.tool_node import ToolRuntime

        return ToolRuntime(
            state={},
            context=_Ctx(),
            config={},
            stream_writer=lambda _event: None,
            tool_call_id="test",
            store=None,
        )
    except ImportError:

        class _Rt:
            context = _Ctx()

        return _Rt()


def resolve_filesystem_search_root(*, runtime: Any = None) -> tuple[str, str | None]:
    """Directory root for search tools: session workspace if bound, else process cwd."""
    root_s, thread_id = resolve_tool_workspace_root(runtime=runtime)
    if root_s:
        root = Path(os.path.expanduser(os.path.expandvars(root_s))).resolve()
        norm_root = _normalize_bound_workspace_dir(root)
        if not isinstance(norm_root, str):
            return str(norm_root), thread_id or None
    return str(Path.cwd().resolve()), thread_id or None


# 【self-evolution-bot · 2026-11-16 · 第23轮】员工岗位工作区检索根（判定单 2611162156 §三①）
# 为什么：员工值守会话无侧栏 local_workspace_root，旧解析链直接落到 profile 目录的
# code_index（root=profile），仓库索引（root=D:/dev/github/EvoFlow）从未进查询范围。
# 在 session 绑定与 thread sandbox 之间插入「employee workspace_path」一级；
# 非员工会话（main/小V/普通聊天）解析为 None → 走原分支，行为零变化。
@functools.lru_cache(maxsize=64)
def _employee_workspace_root_cached(agent_code: str) -> str:
    """Resolve hired employee's workspace_path once per agent_code (process cache)."""
    code = str(agent_code or "").strip()
    if not code:
        return ""
    try:
        from evoflow.proactive.employee_prompting.identity import resolve_employee_identity

        info = resolve_employee_identity(code)
    except Exception:
        logger.debug("employee identity lookup failed code=%s", code, exc_info=True)
        return ""
    if not info:
        return ""
    ws = str(info.get("workspace_path") or "").strip()
    if not ws:
        return ""
    try:
        p = Path(os.path.expanduser(os.path.expandvars(ws))).resolve()
    except (OSError, ValueError):
        return ""
    # 必须是存在的目录才采用；不做 parent 兜底（判定单 §三①）。
    return str(p) if p.is_dir() else ""


def _resolve_employee_workspace_root(runtime: Any = None) -> str:
    """Current run's employee workspace_path, or empty for non-employee sessions."""
    agent_code = ""
    try:
        from evoflow.authz.agent_actor import agent_actor_from_runtime

        agent_code = str(agent_actor_from_runtime(runtime=runtime) or "").strip()
    except Exception:
        logger.debug("agent actor lookup failed", exc_info=True)
        return ""
    if not agent_code:
        return ""
    try:
        from evoflow.proactive.employee_prompting.identity import normalize_employee_agent_code

        agent_code = str(normalize_employee_agent_code(agent_code) or "").strip()
    except Exception:
        pass
    if not agent_code or agent_code.lower() in {"main", "lead_agent", "auto", "user"}:
        return ""
    return _employee_workspace_root_cached(agent_code)


def resolve_search_workspace_root(*, runtime: Any = None) -> tuple[str, str | None] | str:
    """Directory root for code-index search: bound workspace → employee workspace → thread sandbox, else error."""
    root_s, thread_id = resolve_tool_workspace_root(runtime=runtime)
    if root_s:
        root = Path(os.path.expanduser(os.path.expandvars(root_s))).resolve()
        norm_root = _normalize_bound_workspace_dir(root)
        if not isinstance(norm_root, str):
            return str(norm_root), thread_id or None
    emp_ws = _resolve_employee_workspace_root(runtime=runtime)
    if emp_ws:
        return emp_ws, str(thread_id or "").strip() or None
    tid = str(thread_id or "").strip()
    if tid:
        try:
            from evoflow.code_index.store import resolve_index_root

            return str(resolve_index_root(workspace_root=None, thread_id=tid)), tid
        except ValueError:
            pass
    return NO_WORKSPACE_BOUND


def _normalize_bound_workspace_dir(root: Path) -> Path | str:
    """Workspace binding must be a directory; if a file was bound, use its parent."""
    resolved = root.resolve()
    if resolved.is_dir():
        return resolved
    if resolved.is_file():
        return resolved.parent
    return f"Error: Workspace root is not a directory: {root}"


def require_workspace_root(*, runtime: Any = None) -> tuple[Path, str] | str:
    """Return ``(root_path, thread_id)`` when a workspace is bound, else error string."""
    root_s, thread_id = resolve_tool_workspace_root(runtime=runtime)
    if not root_s:
        return NO_WORKSPACE_BOUND
    root = Path(os.path.expanduser(os.path.expandvars(root_s))).resolve()
    norm = _normalize_bound_workspace_dir(root)
    if isinstance(norm, str):
        return norm
    return norm, str(thread_id or "")


def _resolve_relative_under_root(root: Path, raw: str) -> Path:
    """Join *raw* under *root* (outputs/uploads aliases); no traversal block."""
    norm = str(raw or "").strip().replace("\\", "/").removeprefix("./").lstrip("/")
    if not norm or norm == ".":
        return root
    head = norm.split("/", 1)[0]
    if head in ("outputs", "uploads"):
        try:
            return resolve_bound_workspace_file(root, norm)
        except (ValueError, OSError):
            pass
    rel = strip_bound_workspace_prefix(norm)
    return (root / rel.lstrip("/")).resolve()


def resolve_tool_path(
    path: str,
    *,
    runtime: Any = None,
    must_exist: bool = False,
    must_be_file: bool = False,
    must_be_dir: bool = False,
    allow_skill_uri: bool = True,
    allow_skills_install: bool = False,
) -> Path | str:
    """Resolve *path* on the host filesystem; return ``Path`` or error string.

    Workspace binding is optional: absolute paths are honored as given; relative paths
    resolve under the session workspace when bound, otherwise under the process cwd.
    """
    del allow_skills_install  # skills tree no longer needs a separate escape bypass
    raw = str(path or "").strip()
    if not raw:
        return "Error: path is required"

    if allow_skill_uri and raw.startswith("skill:"):
        from evoflow.skills.skill_uri import format_skill_uri_error, resolve_skill_uri

        resolved = resolve_skill_uri(raw, require_enabled=True)
        if resolved is None:
            return format_skill_uri_error(raw, require_enabled=True)
        p = Path(resolved).resolve()
        return _finalize_path(p, must_exist=must_exist, must_be_file=must_be_file, must_be_dir=must_be_dir, label=path)

    norm = raw.replace("\\", "/")
    if norm.startswith("skill:"):
        return f"Error: Invalid skill path: {path}"

    # Git Bash /d/... and WSL /mnt/d/... must become D:/... before Path.resolve()
    # on Windows; otherwise write/read land under a ghost D:\\d\\... tree.
    expanded = from_bash_posix_path(os.path.expanduser(os.path.expandvars(raw)))
    if _is_absolute_path(expanded, expanded):
        target = Path(expanded).resolve()
        root_s, _tid = resolve_tool_workspace_root(runtime=runtime)
        if root_s:
            root = Path(os.path.expanduser(os.path.expandvars(root_s))).resolve()
            target = flatten_bound_workspace_absolute(target, root)
        return _finalize_path(
            target,
            must_exist=must_exist,
            must_be_file=must_be_file,
            must_be_dir=must_be_dir,
            label=path,
        )

    root_s, _tid = resolve_tool_workspace_root(runtime=runtime)
    if root_s:
        root = Path(os.path.expanduser(os.path.expandvars(root_s))).resolve()
        norm_root = _normalize_bound_workspace_dir(root)
        if isinstance(norm_root, str):
            return norm_root
        root = norm_root
        target = _resolve_relative_under_root(root, norm)
    else:
        target = (Path.cwd() / expanded).resolve()

    return _finalize_path(
        target,
        must_exist=must_exist,
        must_be_file=must_be_file,
        must_be_dir=must_be_dir,
        label=path,
    )


def resolve_tool_workdir(
    workdir: str | None,
    *,
    runtime: Any = None,
    allow_skill: bool = True,
) -> Path | str:
    """Resolve terminal/process cwd: workspace root, explicit path, or skill dir."""
    root_s, _tid = resolve_tool_workspace_root(runtime=runtime)
    default_root = Path(os.path.expanduser(os.path.expandvars(root_s))).resolve() if root_s else Path.cwd().resolve()

    if not workdir or not str(workdir).strip():
        if root_s and default_root.is_dir():
            return default_root
        return Path.cwd().resolve()

    wd = str(workdir).strip()
    if wd.startswith("skill:"):
        if not allow_skill:
            return f"Error: skill workdir not allowed here: {workdir!r}"
        from evoflow.skills.skill_uri import resolve_skill_workdir

        r = resolve_skill_workdir(wd, require_enabled=True)
        if r is None or not r.is_dir():
            return f"Error: invalid skill workdir (unknown, disabled, or not a directory): {workdir!r}"
        return r.resolve()

    expanded = from_bash_posix_path(os.path.expanduser(os.path.expandvars(wd)))
    if _is_absolute_path(expanded, expanded):
        target = Path(expanded).resolve()
        if not target.is_dir():
            return f"Error: Path is not a directory: {workdir}"
        return target

    if root_s and default_root.is_dir():
        target = _resolve_relative_under_root(default_root, wd)
    else:
        target = (Path.cwd() / expanded).resolve()
    if not target.is_dir():
        return f"Error: Path is not a directory: {workdir}"
    return target


def _is_large_tool_results_path(p: Path) -> bool:
    parts = {x.casefold() for x in p.parts}
    return "large_tool_results" in parts or ".evoflow" in parts and p.name.endswith(".txt")


def format_read_access_hint(
    resolved: str | Path,
    *,
    raw_path: str = "",
    runtime: Any = None,
) -> str:
    """Optional hint for internal persist paths only (not a workspace access gate)."""
    del raw_path, runtime
    try:
        p = Path(resolved).resolve()
    except (OSError, ValueError):
        return ""
    if _is_large_tool_results_path(p):
        return "Hint: Large tool output was also saved here; if read fails, use the inline summary above."
    return ""


def format_tool_path_label(resolved: Path, *, runtime: Any = None) -> str:
    """Return root-relative posix path for tool success messages when under workspace."""
    root_s, _tid = resolve_tool_workspace_root(runtime=runtime)
    if not root_s:
        return resolved.as_posix()
    root = Path(os.path.expanduser(os.path.expandvars(root_s))).resolve()
    try:
        return resolved.resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        return resolved.as_posix()


def _not_found_detail(p: Path, label: str) -> str:
    r"""路径不存在时的报错：回显入参 + 实际查找的绝对路径。

    【self-evolution-bot · 2026-11-19 · 第60轮 · 模型:deepseek-v4.1-flash-1017】
    改了什么：原本只回显 `label`（即调用方传进来的原始路径），现在补上实际
    查找的绝对路径。为什么：相对路径会被拼到工作区根下（本岗那根是
    C:/Users/admin/.evoflow/profiles/default），而传相对路径的人心里想的往往是仓库根；
    只报入参就分不清“路径写错”还是“根不对”，只能猜一次再绕一步。
    实证：2026-11-19 00:31 本岗 replace("craft/电脑控制写入长文本-记事本实测.md")
    报“Path not found”，没说查的是哪，只能去槽位本地反复确认目录。
    与 read_file.py 第20轮的修法同一口径（“实际查找的绝对路径”），保持全仓一致。

    不变部分：第一行仍然以 `Error: Path not found: <入参>` 开头。
    evopanel/src/lib/chat-normalize.js:1221 用
    /Error: (?:Path not found|File not found):\s*(.+?)(?:\r?\n|$)/ 从这句里抽路径显示给用户，
    操作端只读第一行；补充信息必须放第二行起，否则前端会把整段当成路径。
    """
    base = f"Error: Path not found: {label}"
    try:
        actual = str(p)
    except (OSError, ValueError):
        return base
    if not actual:
        return base
    raw = str(label or "").replace("\\", "/")
    is_absolute = bool(raw) and (raw[1:3] == ":/" or raw.startswith("//"))
    # 绝对路径入参：只有在真被重映射时才补一句，否则只回显入参。
    # 否则就是把「相对路径按工作区根拼」这句无关话术塞给绝对路径调用方
    # —— read_file.py 第20轮的反证用例已经把它钉死了（本轮我自己先踩一次）。
    if is_absolute:
        if actual.replace("\\", "/").lower() == raw.lower():
            return base
        return f"{base}\n（实际查找的绝对路径：{actual}）"
    if actual == str(label):
        return base
    return (
        f"{base}\n"
        f"（实际查找的绝对路径：{actual}；相对路径是按会话工作区根拼的，"
        f"如果你想指的是仓库，请改用 D:/ 开头的绝对路径）"
    )


def _finalize_path(
    p: Path,
    *,
    must_exist: bool,
    must_be_file: bool,
    must_be_dir: bool,
    label: str,
) -> Path | str:
    if must_exist and not p.exists():
        return _not_found_detail(p, label)
    if must_be_file and p.exists() and not p.is_file():
        hint = " Use terminal (e.g. dir / ls) to browse a directory, or read with a concrete file path (e.g. outputs/result.txt), not the workspace root '.'." if p.is_dir() else ""
        return f"Error: Path is not a file: {label}.{hint}" if hint else f"Error: Path is not a file: {label}"
    if must_be_dir and not p.is_dir():
        return f"Error: Path is not a directory: {label}"
    return p
