"""Workspace-internal symbol use refs (Python / JS / TS / Java)."""

from __future__ import annotations

import ast
import re
from pathlib import Path
from typing import Any

from evoflow.code_index.import_bindings import import_aliases_for_file, python_import_aliases
from evoflow.code_index.tree_sitter_core import walk_identifier_uses

InternalRef = dict[str, Any]

_REF_SUFFIXES = frozenset({".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".java"})
_ATTR_USE = re.compile(r"\b([A-Za-z_]\w*)\s*\.\s*([A-Za-z_]\w*)\b")


def _append_ref(
    out: list[InternalRef],
    seen: set[tuple[str, str, int, str]],
    *,
    from_rel: str,
    to_path: str,
    line: int,
    symbol: str,
    ref_kind: str = "import_use",
) -> None:
    key = (from_rel, to_path, line, symbol)
    if key in seen:
        return
    seen.add(key)
    out.append(
        {
            "from_path": from_rel,
            "to_path": to_path,
            "line": line,
            "ref_kind": ref_kind,
            "symbol": symbol,
        }
    )


def extract_python_internal_refs(path: Path, text: str, workspace_root: str | Path) -> list[InternalRef]:
    root = Path(workspace_root).resolve()
    try:
        from_rel = path.resolve().relative_to(root).as_posix()
    except ValueError:
        return []
    try:
        tree = ast.parse(text)
    except SyntaxError:
        return []

    aliases = python_import_aliases(tree, from_rel, root)
    if not aliases:
        return []

    out: list[InternalRef] = []
    seen: set[tuple[str, str, int, str]] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load):
            tp = aliases.get(node.id)
            if tp:
                _append_ref(
                    out,
                    seen,
                    from_rel=from_rel,
                    to_path=tp,
                    line=int(node.lineno or 0),
                    symbol=node.id,
                )
        elif isinstance(node, ast.Attribute) and isinstance(node.ctx, ast.Load):
            if isinstance(node.value, ast.Name):
                tp = aliases.get(node.value.id)
                if tp:
                    sym = f"{node.value.id}.{node.attr}"
                    _append_ref(
                        out,
                        seen,
                        from_rel=from_rel,
                        to_path=tp,
                        line=int(node.lineno or 0),
                        symbol=sym,
                        ref_kind="attr_use",
                    )
    return out


def extract_js_ts_internal_refs(path: Path, text: str, workspace_root: str | Path) -> list[InternalRef]:
    root = Path(workspace_root).resolve()
    try:
        from_rel = path.resolve().relative_to(root).as_posix()
    except ValueError:
        return []
    aliases = import_aliases_for_file(path, text, root)
    if not aliases:
        return []

    out: list[InternalRef] = []
    seen: set[tuple[str, str, int, str]] = set()
    for name, line in walk_identifier_uses(path, text, aliases):
        tp = aliases.get(name)
        if not tp:
            continue
        _append_ref(out, seen, from_rel=from_rel, to_path=tp, line=line, symbol=name)

    for m in _ATTR_USE.finditer(text):
        base, attr = m.group(1), m.group(2)
        tp = aliases.get(base)
        if not tp:
            continue
        line = text[: m.start()].count("\n") + 1
        _append_ref(
            out,
            seen,
            from_rel=from_rel,
            to_path=tp,
            line=line,
            symbol=f"{base}.{attr}",
            ref_kind="attr_use",
        )
    return out


def extract_java_internal_refs(path: Path, text: str, workspace_root: str | Path) -> list[InternalRef]:
    root = Path(workspace_root).resolve()
    try:
        from_rel = path.resolve().relative_to(root).as_posix()
    except ValueError:
        return []
    aliases = import_aliases_for_file(path, text, root)
    if not aliases:
        return []

    out: list[InternalRef] = []
    seen: set[tuple[str, str, int, str]] = set()
    for name, line in walk_identifier_uses(path, text, aliases):
        tp = aliases.get(name)
        if tp:
            _append_ref(out, seen, from_rel=from_rel, to_path=tp, line=line, symbol=name)

    for m in _ATTR_USE.finditer(text):
        base, attr = m.group(1), m.group(2)
        tp = aliases.get(base)
        if not tp:
            continue
        line = text[: m.start()].count("\n") + 1
        _append_ref(
            out,
            seen,
            from_rel=from_rel,
            to_path=tp,
            line=line,
            symbol=f"{base}.{attr}",
            ref_kind="attr_use",
        )
    return out


def extract_internal_refs(path: Path, text: str, workspace_root: str | Path) -> list[InternalRef]:
    suffix = path.suffix.lower()
    if suffix == ".py":
        return extract_python_internal_refs(path, text, workspace_root)
    if suffix in {".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx"}:
        return extract_js_ts_internal_refs(path, text, workspace_root)
    if suffix == ".java":
        return extract_java_internal_refs(path, text, workspace_root)
    return []


def supports_internal_refs(path: Path) -> bool:
    return path.suffix.lower() in _REF_SUFFIXES
