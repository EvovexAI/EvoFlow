"""Find files by glob pattern under the bound workspace (bounded rglob)."""

from __future__ import annotations

import fnmatch
import os
from pathlib import Path

from langchain.tools import ToolRuntime, tool

from evoflow.tools.minimal_schema import FIND_TOOL_DESCRIPTION

_DEFAULT_IGNORE_DIRS = frozenset(
    {
        ".git",
        "node_modules",
        "__pycache__",
        ".venv",
        "venv",
        "dist",
        "build",
        ".next",
        ".pytest_cache",
        ".mypy_cache",
        "target",
    }
)
_MAX_RESULTS = 40
_MAX_SCAN_FILES = 12_000


def _escape_fnmatch_literal(text: str) -> str:
    out: list[str] = []
    for ch in str(text or ""):
        if ch in "*?[]":
            out.append(f"[{ch}]")
        else:
            out.append(ch)
    return "".join(out)


def query_to_glob_pattern(query: str) -> str:
    """Turn a UI filename/path fragment into a bounded glob pattern."""
    q = str(query or "").strip().replace("\\", "/")
    if not q:
        return "*"
    return f"*{_escape_fnmatch_literal(q)}*"


def _iter_substring_matches(
    root: Path,
    needle: str,
    *,
    max_results: int,
    exclude: frozenset[str] | set[str] | None = None,
) -> list[str]:
    """Case-insensitive filename/path substring scan (fallback when glob misses)."""
    q = str(needle or "").strip().lower()
    if not q:
        return []
    skip = exclude or set()
    matches: list[str] = []
    scanned = 0
    for dirpath, dirnames, filenames in os.walk(root, topdown=True):
        dirnames[:] = [d for d in dirnames if d not in _DEFAULT_IGNORE_DIRS and not d.startswith(".")]
        for name in filenames:
            scanned += 1
            if scanned > _MAX_SCAN_FILES:
                break
            rel_dir = Path(dirpath).relative_to(root).as_posix()
            rel = f"{rel_dir}/{name}" if rel_dir != "." else name
            if rel in skip:
                continue
            if q in name.lower() or q in rel.lower():
                matches.append(rel)
                if len(matches) >= max_results:
                    return matches
        if scanned > _MAX_SCAN_FILES:
            break
    return matches


def find_workspace_files(
    workspace_root: str | Path,
    query: str,
    *,
    limit: int = _MAX_RESULTS,
) -> list[dict[str, str]]:
    """Find workspace files by name/path fragment for EvoPanel @-mention and file tree search."""
    root = Path(workspace_root).expanduser().resolve()
    if not root.is_dir():
        raise ValueError(f"Workspace root is not a directory: {root}")
    q = str(query or "").strip()
    if not q:
        return []
    cap = max(1, min(int(limit), _MAX_RESULTS))
    pattern = query_to_glob_pattern(q)
    hits = _iter_matches(root, pattern, max_results=cap)
    if len(hits) < cap:
        extra = _iter_substring_matches(
            root,
            q,
            max_results=cap - len(hits),
            exclude=frozenset(hits),
        )
        hits.extend(extra)

    def _rank(path: str) -> tuple[int, str]:
        name = Path(path).name
        q_lower = q.lower()
        name_lower = name.lower()
        path_lower = path.lower()
        if name_lower == q_lower:
            score = 0
        elif name_lower.startswith(q_lower):
            score = 1
        elif q_lower in name_lower:
            score = 2
        elif q_lower in path_lower:
            score = 3
        else:
            score = 4
        return score, path.lower()

    hits.sort(key=_rank)
    return [{"path": rel, "name": Path(rel).name} for rel in hits[:cap]]


def _iter_matches(root: Path, pattern: str, *, max_results: int) -> list[str]:
    pat = str(pattern or "").strip() or "*"
    norm_pat = pat.replace("\\", "/")
    matches: list[str] = []
    scanned = 0
    for dirpath, dirnames, filenames in os.walk(root, topdown=True):
        dirnames[:] = [d for d in dirnames if d not in _DEFAULT_IGNORE_DIRS and not d.startswith(".")]
        for name in filenames:
            scanned += 1
            if scanned > _MAX_SCAN_FILES:
                break
            rel_dir = Path(dirpath).relative_to(root).as_posix()
            rel = f"{rel_dir}/{name}" if rel_dir != "." else name
            if fnmatch.fnmatch(name, pat) or fnmatch.fnmatch(rel, norm_pat) or fnmatch.fnmatch(rel, pat):
                matches.append(rel)
                if len(matches) >= max_results:
                    return matches
        if scanned > _MAX_SCAN_FILES:
            break
    return matches


def find_file_wallclock(
    *,
    pattern: str,
    root: str = ".",
    max_results: int = _MAX_RESULTS,
    runtime: object = None,
) -> str:
    from evoflow.tools.host_direct.workspace_path_guard import resolve_search_workspace_root

    resolved = resolve_search_workspace_root(runtime=runtime)
    if isinstance(resolved, str):
        return resolved
    workspace_root, _tid = resolved

    rel_root = str(root or ".").strip() or "."
    base = Path(workspace_root)
    if rel_root not in (".", ""):
        from evoflow.tools.host_direct.workspace_path_guard import resolve_tool_path

        target = resolve_tool_path(rel_root, runtime=runtime, must_exist=True)
        if isinstance(target, str):
            return target
        if target.is_file():
            base = target.parent
        else:
            base = target

    if not base.is_dir():
        return f"Error: root is not a directory: {rel_root}"

    hits = _iter_matches(base.resolve(), pattern, max_results=max(1, min(int(max_results), _MAX_RESULTS)))
    if not hits:
        return (
            f"No files matching pattern {pattern!r} under {rel_root} "
            f"(workspace {workspace_root}). Try a broader pattern or another root subdirectory."
        )
    lines = [f"Found {len(hits)} file(s) matching {pattern!r} under {rel_root}:", ""]
    for i, rel in enumerate(hits):
        lines.append(f"  [{i}] {rel}")
    lines.append("")
    lines.append("Next: read on the most relevant path; do not run unbounded shell find.")
    return "\n".join(lines)


@tool("find", description=FIND_TOOL_DESCRIPTION, parse_docstring=False)
def find_file_hd(
    pattern: str,
    *,
    root: str = ".",
    max_results: int = 40,
    runtime: ToolRuntime,
) -> str:
    """Find workspace files by glob pattern."""
    tid = ""
    if runtime is not None and getattr(runtime, "context", None):
        tid = str(runtime.context.get("thread_id") or "").strip()
    if tid:
        from evoflow.exploration.exploration_budget import check_tool_budget

        budget_err = check_tool_budget(tid, "find", {"pattern": pattern, "root": root})
        if budget_err:
            return budget_err
    return find_file_wallclock(
        pattern=pattern,
        root=root,
        max_results=max_results,
        runtime=runtime,
    )
