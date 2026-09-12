"""List directory — enhanced version with ignore patterns and flexible output."""

import fnmatch
from pathlib import Path
from typing import Literal

from langchain.tools import ToolRuntime

from evoflow.tools.host_direct.workspace_path_guard import resolve_tool_path

_DEFAULT_IGNORE = [
    ".git",
    "__pycache__",
    "node_modules",
    ".venv",
    "venv",
    ".idea",
    ".vscode",
    ".DS_Store",
    "*.pyc",
    ".next",
    "dist",
    "build",
    ".env",
    ".cache",
    "*.log",
    "*.tmp",
    ".coverage",
    ".pytest_cache",
]


def list_dir_hd(
    path: str,
    *,
    depth: int = 2,
    ignore: list | None = None,
    show_hidden: bool = False,
    format: Literal["tree", "list"] = "tree",
    runtime: ToolRuntime,
) -> str:
    """List directory contents (tree or flat).

    **When to use**
    - Browse folder layout when search does not give enough structure (new/unindexed trees, assets-only dirs).
    - Confirm paths before ``read_file``.

    **When not to use**
    - Find code by symbol/keyword in an indexed workspace → ``search_code_index`` first (not a recursive ``list_dir`` hunt).

    Args:
        path: Workspace path, or ``skill:<name>`` / ``skill:<name>/subdir`` for bundled skill trees.
        depth: Max traversal depth (default 2).
        ignore: Extra glob patterns to skip.
        show_hidden: Include dotfiles (default False).
        format: ``tree`` or ``list``.

    Common dirs (``.git``, ``node_modules``, …) are always ignored.
    """
    resolved = resolve_tool_path(
        path,
        runtime=runtime,
        must_exist=True,
        must_be_dir=True,
        allow_skills_install=True,
    )
    if isinstance(resolved, str):
        return resolved
    try:
        root = resolved

        all_ignore = set(_DEFAULT_IGNORE) | set(ignore or [])

        def should_skip(name: str) -> bool:
            for pattern in all_ignore:
                if fnmatch.fnmatch(name, pattern):
                    return True
            if not show_hidden and name.startswith("."):
                return True
            return False

        if format == "list":
            return _format_list(root, depth, should_skip)
        else:
            return _format_tree(root, depth, should_skip, prefix="")

    except PermissionError:
        return f"Error: Permission denied: {path}"
    except Exception as e:
        return f"Error: Listing directory failed: {e}"


def _format_tree(current: Path, max_depth: int, skip_fn, prefix: str = "", current_depth: int = 1) -> str:
    """Format as visual tree."""
    try:
        entries = sorted(
            [e for e in current.iterdir() if not skip_fn(e.name)],
            key=lambda e: (not e.is_dir(), e.name.lower()),
        )
    except PermissionError:
        return "(permission denied)"

    if not entries:
        return "(empty)"

    lines = []
    total = len(entries)
    for i, entry in enumerate(entries):
        is_last = i == total - 1
        connector = "└── " if is_last else "├── "
        post_fix = "/" if entry.is_dir() else ""
        size_str = ""
        if entry.is_file():
            size = entry.stat().st_size
            if size > 1024 * 1024:
                size_str = f" ({size / (1024 * 1024):.1f} MB)"
            elif size > 1024:
                size_str = f" ({size / 1024:.1f} KB)"
            else:
                size_str = f" ({size} B)"
        lines.append(f"{prefix}{connector}{entry.name}{post_fix}{size_str}")

        if entry.is_dir() and current_depth < max_depth:
            extension = "    " if is_last else "│   "
            sub_tree = _format_tree(entry, max_depth, skip_fn, prefix + extension, current_depth + 1)
            lines.append(sub_tree)

    return "\n".join(lines)


def _format_list(root: Path, max_depth: int, skip_fn) -> str:
    """Format as flat list with metadata (easy for LLM to parse)."""
    results = []

    def walk(current: Path, d: int):
        if d > max_depth:
            return
        try:
            for entry in sorted(current.iterdir()):
                if skip_fn(entry.name):
                    continue
                kind = "d" if entry.is_dir() else "-"
                size = entry.stat().st_size if entry.is_file() else 0
                size_fmt = f"{size:>8,}" if entry.is_file() else "       -"
                rel = str(entry.relative_to(root)) if entry != root else entry.name
                results.append(f"{kind}{kind}r--r-- {rel:<50} {size_fmt:>10}")
                if entry.is_dir():
                    walk(entry, d + 1)
        except PermissionError:
            pass

    walk(root, 1)
    return "\n".join(results) if results else "(empty)"
