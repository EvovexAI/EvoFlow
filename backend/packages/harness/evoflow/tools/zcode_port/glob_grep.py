"""Glob and Grep handlers.

Sources:
- ZCode packages/core/src/tool/handlers/glob.ts
- ZCode packages/core/src/tool/handlers/grep.ts
- ZCode packages/adapters/src/fs/index.ts searchFiles / searchText
"""

from __future__ import annotations

import fnmatch
import os
import subprocess
import sys
import time
from pathlib import Path

from langchain.tools import ToolRuntime, tool

from evoflow.tools.zcode_port.prelude import GLOB_DESCRIPTION, GREP_DESCRIPTION

MAX_GLOB_RESULTS = 100
DEFAULT_GREP_HEAD_LIMIT = 250


def _workspace_root(runtime: ToolRuntime, path: str | None) -> Path:
    from evoflow.tools.host_direct.workspace_path_guard import resolve_search_workspace_root, resolve_tool_path

    resolved = resolve_search_workspace_root(runtime=runtime)
    if isinstance(resolved, str):
        raise RuntimeError(resolved)
    root, _thread = resolved
    rel = (path or ".").strip() or "."
    if rel in (".", ""):
        return Path(root)
    target = resolve_tool_path(rel, runtime=runtime, must_exist=True)
    if isinstance(target, str):
        raise RuntimeError(target)
    return Path(target)


def _display(path: Path, root: Path) -> str:
    try:
        rel = path.resolve().relative_to(root.resolve())
    except ValueError:
        return str(path)
    return rel.as_posix()


def _skip_dir(name: str) -> bool:
    return name in {".git", "node_modules", "__pycache__", ".venv", "venv", "dist", "build"}


@tool("glob", description=GLOB_DESCRIPTION, parse_docstring=False)
def glob_tool(pattern: str, path: str | None = None, runtime: ToolRuntime = None) -> str:
    """Fast file pattern matching. pattern is required; path defaults to the working directory."""
    started = time.time()
    try:
        root = _workspace_root(runtime, path)
    except Exception as exc:
        return f"Error: {exc}"
    if not pattern.strip():
        return "Error: Glob pattern must not be empty"
    if not root.is_dir():
        return f"Error: Glob search path must be a directory: {root}"
    matches: list[tuple[float, Path]] = []
    # fnmatch's ``*`` crosses separators, so ``**/*.py`` demands a literal slash
    # and misses root-level files (real glob treats ``**/`` as optional). Match
    # against the pattern and its ``**/``-stripped variant.
    patterns = {pattern}
    if pattern.startswith("**/"):
        patterns.add(pattern[3:])
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if not _skip_dir(d)]
        for name in filenames:
            file_path = Path(dirpath) / name
            rel = _display(file_path, root)
            if any(fnmatch.fnmatch(rel, p) or fnmatch.fnmatch(name, p) for p in patterns):
                try:
                    mtime = file_path.stat().st_mtime
                except OSError:
                    mtime = 0
                matches.append((mtime, file_path))
    matches.sort(key=lambda item: (-item[0], str(item[1])))
    truncated = len(matches) > MAX_GLOB_RESULTS
    chosen = matches[:MAX_GLOB_RESULTS]
    if not chosen:
        return "No files found"
    lines = [_display(p, root) for _mtime, p in chosen]
    if truncated:
        lines.append("(Results are truncated. Consider using a more specific path or pattern.)")
    _ = int((time.time() - started) * 1000)
    return "\n".join(lines)


def _rg_binary() -> str | None:
    from evoflow.tools.host_direct.rg import _find_rg_binary

    return _find_rg_binary()


@tool("grep", description=GREP_DESCRIPTION, parse_docstring=False)
def grep_tool(
    pattern: str,
    path: str | None = None,
    glob: str | None = None,
    output_mode: str | None = None,
    context: int | None = None,
    type: str | None = None,
    head_limit: int | None = None,
    offset: int | None = None,
    multiline: bool | None = None,
    runtime: ToolRuntime = None,
    **flags: object,
) -> str:
    """Content search built on ripgrep. output_mode defaults to files_with_matches."""
    mode = output_mode or "files_with_matches"
    limit = DEFAULT_GREP_HEAD_LIMIT if head_limit is None else int(head_limit)
    skip = int(offset or 0)
    ignore_case = bool(flags.get("-i") or flags.get("i"))
    show_lines = True if flags.get("-n") is None else bool(flags.get("-n"))
    before = flags.get("-B")
    after = flags.get("-A")
    if context is not None:
        before = before if before is not None else context
        after = after if after is not None else context
    try:
        root = _workspace_root(runtime, path)
    except Exception as exc:
        return f"Error: {exc}"
    if not pattern.strip():
        return "Error: Grep pattern must not be empty"
    rg = _rg_binary()
    if rg is None:
        return "Error: ripgrep is not available"
    cmd = [rg, "--color=never", "--no-heading"]
    if ignore_case:
        cmd.append("-i")
    if multiline:
        cmd.extend(["-U", "--multiline-dotall"])
    if glob:
        cmd.extend(["--glob", glob])
    if type:
        cmd.extend(["--type", type])
    if mode == "files_with_matches":
        cmd.append("-l")
    elif mode == "count":
        cmd.append("-c")
    elif show_lines:
        cmd.append("-n")
    if before:
        cmd.extend(["-B", str(int(before))])
    if after:
        cmd.extend(["-A", str(int(after))])
    if limit > 0 and mode == "content":
        cmd.extend(["-m", str(limit)])
    cmd.extend([pattern, str(root)])
    kwargs = {}
    if sys.platform == "win32":
        kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30, **kwargs)
    except subprocess.TimeoutExpired:
        return "Error: Grep timed out after 30s"
    if proc.returncode == 2:
        return f"Error: ripgrep: {(proc.stderr or '').strip()[:2000]}"
    lines = [line for line in (proc.stdout or "").splitlines() if line]
    if skip:
        lines = lines[skip:]
    if limit > 0:
        lines = lines[:limit]
    if mode == "files_with_matches":
        if not lines:
            return "No files found"
        return f"Found {len(lines)} file" + ("" if len(lines) == 1 else "s") + "\n" + "\n".join(lines)
    if mode == "count":
        if not lines:
            return "No matches found"
        return "\n".join(lines)
    return "\n".join(lines) if lines else "No matches found"
