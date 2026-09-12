"""File-level import dependency extraction (Python / JS / TS / Java)."""

from __future__ import annotations

import ast
import logging
import os
import re
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

FileDep = dict[str, Any]

_JS_IMPORT = re.compile(
    r"""(?:import\s+(?:[^'"]+\s+from\s+)?|export\s+[^'"]*from\s+)['"]([^'"]+)['"]""",
    re.MULTILINE,
)
_JS_REQUIRE = re.compile(r"""require\s*\(\s*['"]([^'"]+)['"]\s*\)""")
_JS_DYNAMIC_IMPORT = re.compile(r"""import\s*\(\s*['"]([^'"]+)['"]\s*\)""")
_JAVA_IMPORT = re.compile(r"^\s*import\s+(?:static\s+)?([a-zA-Z0-9_.]+)(?:\.\*)?\s*;", re.MULTILINE)

_PY_EXTS = (".py",)
_JS_EXTS = (".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx")
_INDEXABLE = _PY_EXTS + _JS_EXTS + (".java",)


def _is_internal_spec(spec: str) -> bool:
    s = str(spec or "").strip()
    if not s:
        return False
    if s.startswith("."):
        return True
    if s.startswith("@"):
        return False
    if s.startswith("node:"):
        return False
    return "." not in s or s.startswith("./") or s.startswith("../")


_package_root_cache: dict[str, list[Path]] | None = None


def _discover_package_roots(root: Path) -> list[Path]:
    """Scan workspace for directories containing ``__init__.py`` (package roots).

    Returns a list of parent directories of ``__init__.py`` files, deduplicated.
    Cached per-process for performance.  This lets ``_resolve_py_module`` find
    packages in nested structures like ``backend/packages/harness/evoflow/...``
    where the top-level package name (``evoflow``) is not a direct child of
    ``root``.
    """
    global _package_root_cache
    if _package_root_cache is not None:
        cache = _package_root_cache.get(str(root))
        if cache is not None:
            return cache

    roots: list[Path] = []
    seen: set[Path] = set()
    root_resolved = root.resolve()

    # Limit scan depth to avoid walking huge node_modules etc.
    _SKIP = {".git", "node_modules", "__pycache__", ".venv", "venv", "dist", "build", ".next", "target"}
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in _SKIP and not d.startswith(".")]
        if "__init__.py" in filenames:
            pkg_dir = Path(dirpath)
            try:
                pkg_dir.relative_to(root_resolved)
            except ValueError:
                continue
            if pkg_dir not in seen:
                seen.add(pkg_dir)
                roots.append(pkg_dir)

    # Sort by depth (shallowest first) so shorter paths are tried first
    roots.sort(key=lambda p: len(p.parts))

    if _package_root_cache is None:
        _package_root_cache = {}
    _package_root_cache[str(root)] = roots
    return roots


def _resolve_py_module(root: Path, from_rel: str, module: str, *, level: int = 0) -> str | None:
    from_dir = (root / from_rel).parent
    base = from_dir
    if level:
        for _ in range(level):
            base = base.parent
    parts = [p for p in str(module or "").split(".") if p]
    if not parts:
        return None
    candidates: list[Path] = [
        base.joinpath(*parts).with_suffix(".py"),
        base.joinpath(*parts) / "__init__.py",
    ]
    if len(parts) == 1:
        candidates.append(base / f"{parts[0]}.py")
    # Workspace-root packages (internal top-level modules)
    candidates.extend(
        [
            root.joinpath(*parts).with_suffix(".py"),
            root.joinpath(*parts) / "__init__.py",
        ]
    )
    # Discovered package roots — resolve nested package structures like
    # ``backend/packages/harness/evoflow/...`` where the top-level package
    # name (``evoflow``) lives deep under root.
    top_name = parts[0]
    for pkg_root in _discover_package_roots(root):
        if pkg_root.name == top_name:
            candidates.append(pkg_root.joinpath(*parts[1:]).with_suffix(".py"))
            candidates.append(pkg_root.joinpath(*parts[1:]) / "__init__.py")
    for cand in candidates:
        try:
            if cand.is_file():
                return cand.resolve().relative_to(root.resolve()).as_posix()
        except ValueError:
            continue
    return None


def _resolve_js_spec(root: Path, from_rel: str, spec: str) -> str | None:
    s = str(spec or "").strip()
    if not s.startswith("."):
        return None
    from_dir = (root / from_rel).parent
    raw = (from_dir / s).resolve()
    tries: list[Path] = []
    if raw.suffix:
        tries.append(raw)
    else:
        for ext in (".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", "/index.ts", "/index.tsx", "/index.js"):
            if ext.startswith("/"):
                tries.append(Path(str(raw) + ext))
            else:
                tries.append(raw.with_suffix(ext))
    for cand in tries:
        try:
            if cand.is_file():
                return cand.relative_to(root.resolve()).as_posix()
        except (ValueError, OSError):
            continue
    return None


def _resolve_java_spec(root: Path, spec: str) -> str | None:
    s = str(spec or "").strip()
    if not s or s.endswith(".*"):
        s = s[:-2] if s.endswith(".*") else s
    rel = Path(*s.split(".")).with_suffix(".java")
    cand = root / rel
    try:
        if cand.is_file():
            return cand.resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        pass
    return None


def resolve_py_import_from(
    root: Path,
    from_rel: str,
    mod: str,
    name: str,
    *,
    level: int = 0,
) -> str | None:
    """Resolve ``from mod import name`` to a workspace file (module or submodule)."""
    if mod:
        tp = _resolve_py_module(root, from_rel, f"{mod}.{name}", level=level)
        if tp:
            return tp
        return _resolve_py_module(root, from_rel, mod, level=level)
    return _resolve_py_module(root, from_rel, name, level=level)


def _extract_python_deps(text: str, from_rel: str, root: Path) -> list[FileDep]:
    out: list[FileDep] = []
    try:
        tree = ast.parse(text)
    except SyntaxError:
        return out

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                to_path = _resolve_py_module(root, from_rel, alias.name)
                if to_path:
                    out.append(
                        {
                            "spec": alias.name,
                            "to_path": to_path,
                            "line": int(node.lineno or 0),
                            "dep_kind": "import",
                        }
                    )
        elif isinstance(node, ast.ImportFrom):
            level = int(node.level or 0)
            mod = node.module or ""
            seen_edges: set[tuple[str, str]] = set()

            def _add(spec: str, to_path: str | None, *, line: int) -> None:
                if not to_path:
                    return
                key = (spec, to_path)
                if key in seen_edges:
                    return
                seen_edges.add(key)
                out.append(
                    {
                        "spec": spec,
                        "to_path": to_path,
                        "line": line,
                        "dep_kind": "import",
                    }
                )

            for alias in node.names:
                if alias.name == "*":
                    tp = _resolve_py_module(root, from_rel, mod, level=level)
                    _add(f"from {'.' * level}{mod} import *", tp, line=int(node.lineno or 0))
                    continue
                if mod:
                    spec = f"from {'.' * level}{mod} import {alias.name}"
                else:
                    spec = f"from {'.' * level} import {alias.name}"
                tp = resolve_py_import_from(root, from_rel, mod, alias.name, level=level)
                _add(spec, tp, line=int(node.lineno or 0))
    return out


def list_importers(conn: Any, paths: list[str], *, limit: int = 20) -> list[dict]:
    """Files that import any of *paths* (reverse internal dependency)."""
    if not paths:
        return []
    out: list[dict] = []
    seen: set[str] = set()
    for p in paths:
        if not p or p in seen:
            continue
        seen.add(p)
        rows = conn.execute(
            """
            SELECT from_path, spec, line FROM file_deps
            WHERE to_path = ?
            ORDER BY from_path
            LIMIT ?
            """,
            (p, limit),
        ).fetchall()
        for r in rows:
            out.append(
                {
                    "from_path": str(r[0]),
                    "to_path": p,
                    "spec": str(r[1]),
                    "line": int(r[2] or 0),
                    "kind": "imported_by",
                }
            )
    return out[:limit]


def list_outgoing_imports(conn: Any, paths: list[str], *, limit: int = 20) -> list[dict]:
    """Internal files imported by *paths*."""
    if not paths:
        return []
    out: list[dict] = []
    for p in paths:
        rows = conn.execute(
            """
            SELECT to_path, spec, line FROM file_deps
            WHERE from_path = ? AND to_path IS NOT NULL
            ORDER BY to_path
            LIMIT ?
            """,
            (p, limit),
        ).fetchall()
        for r in rows:
            out.append(
                {
                    "from_path": p,
                    "to_path": str(r[0]),
                    "spec": str(r[1]),
                    "line": int(r[2] or 0),
                    "kind": "imports",
                }
            )
    return out[:limit]


def _extract_js_ts_deps(text: str, from_rel: str, root: Path) -> list[FileDep]:
    out: list[FileDep] = []
    seen: set[str] = set()
    for rx in (_JS_IMPORT, _JS_REQUIRE, _JS_DYNAMIC_IMPORT):
        for m in rx.finditer(text):
            spec = m.group(1).strip()
            if spec in seen or not _is_internal_spec(spec):
                continue
            seen.add(spec)
            to_path = _resolve_js_spec(root, from_rel, spec)
            if to_path:
                out.append(
                    {
                        "spec": spec,
                        "to_path": to_path,
                        "line": _line_at(text, m.start()),
                        "dep_kind": "import",
                    }
                )
    return out


def _line_at(text: str, index: int) -> int:
    return text[:index].count("\n") + 1 if index >= 0 else 0


def _extract_java_deps(text: str, from_rel: str, root: Path) -> list[FileDep]:
    del from_rel
    out: list[FileDep] = []
    seen: set[str] = set()
    for m in _JAVA_IMPORT.finditer(text):
        spec = m.group(1).strip()
        if spec in seen or spec.startswith("java.") or spec.startswith("javax."):
            continue
        seen.add(spec)
        to_path = _resolve_java_spec(root, spec)
        if to_path:
            out.append(
                {
                    "spec": spec,
                    "to_path": to_path,
                    "line": _line_at(text, m.start()),
                    "dep_kind": "import",
                }
            )
    return out


def extract_file_deps(path: Path, text: str, workspace_root: str | Path) -> list[FileDep]:
    """Return resolved internal import edges from *path* (relative to *workspace_root*)."""
    root = Path(workspace_root).resolve()
    try:
        from_rel = path.resolve().relative_to(root).as_posix()
    except ValueError:
        return []

    suffix = path.suffix.lower()
    if suffix in _PY_EXTS:
        return _extract_python_deps(text, from_rel, root)
    if suffix in _JS_EXTS:
        return _extract_js_ts_deps(text, from_rel, root)
    if suffix == ".java":
        return _extract_java_deps(text, from_rel, root)
    return []


def dependency_neighbors(
    conn: Any,
    seed_paths: list[str],
    *,
    hops: int = 1,
    limit: int = 32,
) -> list[str]:
    """BFS over file_deps from *seed_paths* (outgoing + incoming)."""
    if hops < 1 or not seed_paths:
        return []
    seen = {p for p in seed_paths if p}
    frontier = list(seen)
    for _ in range(hops):
        if not frontier:
            break
        next_frontier: list[str] = []
        for p in frontier:
            rows = conn.execute(
                """
                SELECT to_path AS p FROM file_deps WHERE from_path = ? AND to_path IS NOT NULL
                UNION
                SELECT from_path AS p FROM file_deps WHERE to_path = ? AND from_path IS NOT NULL
                """,
                (p, p),
            ).fetchall()
            for r in rows:
                tp = str(r[0])
                if tp and tp not in seen:
                    seen.add(tp)
                    next_frontier.append(tp)
                    if len(seen) >= limit:
                        return list(seen)[:limit]
        frontier = next_frontier
    return [p for p in seen if p not in set(seed_paths)][: max(0, limit - len(seed_paths))]
