"""Safe directory listing under a bound local workspace root."""

from __future__ import annotations

import fnmatch
import os
from pathlib import Path

_DEFAULT_IGNORE = frozenset(
    {
        ".git",
        "__pycache__",
        "node_modules",
        ".venv",
        "venv",
        ".idea",
        ".vscode",
        ".DS_Store",
        ".next",
        "dist",
        "build",
        ".env",
        ".cache",
        ".pytest_cache",
        ".coverage",
    }
)


def resolve_under_workspace(root: str | Path, relative: str = ".") -> Path:
    """Resolve *relative* under *root* (no confinement; ``..`` allowed)."""
    base = Path(os.path.expanduser(os.path.expandvars(str(root or "").strip()))).resolve()
    if not base.is_dir():
        raise ValueError(f"Workspace root is not a directory: {base}")
    rel = str(relative or ".").strip().replace("\\", "/")
    if rel in {"", "."}:
        return base
    rel_path = Path(rel)
    if rel_path.is_absolute():
        return rel_path.resolve()
    return (base / rel.lstrip("/")).resolve()


def strip_bound_workspace_prefix(path: str) -> str:
    """Strip legacy ``workspace/`` prefix (not a default subdir). Keeps ``outputs/``, ``uploads/``."""
    v = str(path or "").strip().replace("\\", "/").lstrip("/")
    if v == "workspace":
        return ""
    if v.startswith("workspace/"):
        return v[len("workspace/") :]
    return v


def flatten_bound_workspace_absolute(target: Path, root: str | Path) -> Path:
    """Map ``{root}/workspace/foo`` → ``{root}/foo`` for bound local workspace reads/writes."""
    base = Path(os.path.expanduser(os.path.expandvars(str(root or "").strip()))).resolve()
    resolved = target.resolve()
    try:
        rel = resolved.relative_to(base)
        if rel.parts and rel.parts[0] == "workspace" and len(rel.parts) > 1:
            return (base / Path(*rel.parts[1:])).resolve()
    except ValueError:
        pass
    return resolved


def resolve_bound_workspace_file(root: str | Path, relative: str) -> Path:
    """Resolve paths under a bound local project root.

    - ``outputs/…`` → ``{root}/outputs/…`` (legacy ``{root}/workspace/outputs/`` only if flat missing).
    - ``uploads/…`` → ``{root}/uploads/…``.
    - Legacy ``workspace/…`` → stripped, then under ``{root}/`` directly.
    """
    base = Path(os.path.expanduser(os.path.expandvars(str(root or "").strip()))).resolve()
    if not base.is_dir():
        raise ValueError(f"Workspace root is not a directory: {base}")
    rel = str(relative or "").strip().replace("\\", "/").lstrip("/")
    if not rel:
        raise ValueError("path must name a file")
    head = rel.split("/", 1)[0]
    tail = rel.split("/", 1)[1] if "/" in rel else ""

    if head == "outputs":
        flat = base / "outputs"
        nested = base / "workspace" / "outputs"
        if flat.is_dir():
            target = (flat / tail) if tail else flat
        elif nested.is_dir():
            target = (nested / tail) if tail else nested
        else:
            target = (flat / tail) if tail else flat
        return target.resolve()

    if head == "uploads":
        target = (base / "uploads" / tail) if tail else (base / "uploads")
        return target.resolve()

    rel = strip_bound_workspace_prefix(rel)
    return resolve_under_workspace(base, rel)


def _should_skip(name: str, *, show_hidden: bool) -> bool:
    if name in _DEFAULT_IGNORE:
        return True
    for pattern in _DEFAULT_IGNORE:
        if "*" in pattern and fnmatch.fnmatch(name, pattern):
            return True
    if not show_hidden and name.startswith("."):
        return True
    return False


def list_workspace_entries(
    root: str | Path,
    relative: str = ".",
    *,
    show_hidden: bool = False,
) -> tuple[str, list[dict]]:
    """List immediate children of *relative* under *root*.

    Returns ``(resolved_dir, entries)`` where each entry has
    ``name``, ``path`` (posix relative from root), ``is_dir``, ``size``.
    """
    directory = resolve_under_workspace(root, relative)
    if not directory.exists():
        raise FileNotFoundError(str(directory))
    if not directory.is_dir():
        raise NotADirectoryError(str(directory))

    base = Path(os.path.expanduser(os.path.expandvars(str(root or "").strip()))).resolve()
    entries: list[dict] = []
    try:
        children = sorted(directory.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
    except PermissionError as e:
        raise PermissionError(f"Permission denied: {directory}") from e

    for child in children:
        if _should_skip(child.name, show_hidden=show_hidden):
            continue
        try:
            rel = child.relative_to(base).as_posix()
        except ValueError:
            rel = child.name
        stat = child.stat()
        size = stat.st_size if child.is_file() else None
        entries.append(
            {
                "name": child.name,
                "path": rel,
                "is_dir": child.is_dir(),
                "size": size,
                "mtime": stat.st_mtime,
            }
        )
    return str(directory), entries
