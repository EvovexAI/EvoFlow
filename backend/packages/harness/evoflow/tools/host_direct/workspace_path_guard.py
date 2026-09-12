"""Resolve host-direct file paths (workspace hint optional; no confinement to workspace root)."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from evoflow.tools.host_direct.workspace_context import resolve_tool_workspace_root
from evoflow.utils.workspace_browse import (
    flatten_bound_workspace_absolute,
    resolve_bound_workspace_file,
    strip_bound_workspace_prefix,
)

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
        from langchain.tools import ToolRuntime

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


def resolve_search_workspace_root(*, runtime: Any = None) -> tuple[str, str | None] | str:
    """Directory root for code-index search: bound workspace or thread sandbox, else error."""
    root_s, thread_id = resolve_tool_workspace_root(runtime=runtime)
    if root_s:
        root = Path(os.path.expanduser(os.path.expandvars(root_s))).resolve()
        norm_root = _normalize_bound_workspace_dir(root)
        if not isinstance(norm_root, str):
            return str(norm_root), thread_id or None
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

    expanded = os.path.expanduser(os.path.expandvars(raw))
    if _is_absolute_path(raw, expanded):
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
    default_root = (
        Path(os.path.expanduser(os.path.expandvars(root_s))).resolve()
        if root_s
        else Path.cwd().resolve()
    )

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

    expanded = os.path.expanduser(os.path.expandvars(wd))
    if _is_absolute_path(wd, expanded):
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
        return (
            "Hint: Large tool output was also saved here; if read fails, use the inline summary above."
        )
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


def _finalize_path(
    p: Path,
    *,
    must_exist: bool,
    must_be_file: bool,
    must_be_dir: bool,
    label: str,
) -> Path | str:
    if must_exist and not p.exists():
        return f"Error: Path not found: {label}"
    if must_be_file and p.exists() and not p.is_file():
        hint = (
            " Use terminal (e.g. dir / ls) to browse a directory, or read with a concrete file path "
            "(e.g. outputs/result.txt), not the workspace root '.'."
            if p.is_dir()
            else ""
        )
        return f"Error: Path is not a file: {label}.{hint}" if hint else f"Error: Path is not a file: {label}"
    if must_be_dir and not p.is_dir():
        return f"Error: Path is not a directory: {label}"
    return p
