"""Map local import binding names -> workspace file paths."""

from __future__ import annotations

import ast
import re
from pathlib import Path

from evoflow.code_index.deps import (
    _resolve_java_spec,
    _resolve_js_spec,
    _resolve_py_module,
    resolve_py_import_from,
)

_JS_DEFAULT_IMPORT = re.compile(
    r"""import\s+(\w+)\s+from\s+['"]([^'"]+)['"]""",
    re.MULTILINE,
)
_JS_NAMED_IMPORT = re.compile(
    r"""import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]""",
    re.MULTILINE,
)
_JS_NAMESPACE = re.compile(
    r"""import\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"]""",
    re.MULTILINE,
)
_JS_TYPE_NAMED = re.compile(
    r"""import\s+type\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]""",
    re.MULTILINE,
)
_JS_TYPE_DEFAULT = re.compile(
    r"""import\s+type\s+(\w+)\s+from\s+['"]([^'"]+)['"]""",
    re.MULTILINE,
)
_JS_REQUIRE_DEFAULT = re.compile(
    r"""(?:const|let|var)\s+(\w+)\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)""",
    re.MULTILINE,
)
_JAVA_IMPORT = re.compile(r"^\s*import\s+(?:static\s+)?([a-zA-Z0-9_.]+)(?:\.\*)?\s*;", re.MULTILINE)


def python_import_aliases(tree: ast.Module, from_rel: str, root: Path) -> dict[str, str]:
    aliases: dict[str, str] = {}
    for node in tree.body:
        if isinstance(node, ast.Import):
            for alias in node.names:
                local = alias.asname or alias.name.split(".")[0]
                tp = _resolve_py_module(root, from_rel, alias.name)
                if tp:
                    aliases[local] = tp
        elif isinstance(node, ast.ImportFrom):
            level = int(node.level or 0)
            mod = node.module or ""
            for alias in node.names:
                if alias.name == "*":
                    tp = _resolve_py_module(root, from_rel, mod, level=level)
                    if tp:
                        aliases["*"] = tp
                    continue
                local = alias.asname or alias.name
                tp = resolve_py_import_from(root, from_rel, mod, alias.name, level=level)
                if tp:
                    aliases[local] = tp
    return aliases


def _parse_js_named_bindings(chunk: str) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    for part in chunk.split(","):
        piece = part.strip()
        if not piece:
            continue
        if piece.startswith("type "):
            piece = piece[5:].strip()
        if " as " in piece:
            ext, local = piece.split(" as ", 1)
            out.append((local.strip(), ext.strip()))
        else:
            out.append((piece, piece))
    return out


def js_ts_import_aliases(path: Path, text: str, root: Path) -> dict[str, str]:
    root = root.resolve()
    try:
        from_rel = path.resolve().relative_to(root).as_posix()
    except ValueError:
        return {}
    aliases: dict[str, str] = {}
    for rx in (_JS_DEFAULT_IMPORT, _JS_NAMESPACE, _JS_TYPE_DEFAULT):
        for m in rx.finditer(text):
            local, spec = m.group(1).strip(), m.group(2).strip()
            tp = _resolve_js_spec(root, from_rel, spec)
            if tp:
                aliases[local] = tp
    for rx in (_JS_NAMED_IMPORT, _JS_TYPE_NAMED):
        for m in rx.finditer(text):
            spec = m.group(2).strip()
            tp = _resolve_js_spec(root, from_rel, spec)
            if not tp:
                continue
            for local, _ext in _parse_js_named_bindings(m.group(1)):
                aliases[local] = tp
    for m in _JS_REQUIRE_DEFAULT.finditer(text):
        local, spec = m.group(1).strip(), m.group(2).strip()
        tp = _resolve_js_spec(root, from_rel, spec)
        if tp and spec.startswith("."):
            aliases[local] = tp
    return aliases


def java_import_aliases(path: Path, text: str, root: Path) -> dict[str, str]:
    aliases: dict[str, str] = {}
    for m in _JAVA_IMPORT.finditer(text):
        spec = m.group(1).strip()
        if spec.startswith("java.") or spec.startswith("javax."):
            continue
        tp = _resolve_java_spec(root, spec)
        if not tp:
            continue
        simple = spec.split(".")[-1]
        aliases[simple] = tp
    return aliases


def import_aliases_for_file(path: Path, text: str, root: Path) -> dict[str, str]:
    suffix = path.suffix.lower()
    if suffix == ".py":
        try:
            tree = ast.parse(text)
        except SyntaxError:
            return {}
        root = root.resolve()
        try:
            from_rel = path.resolve().relative_to(root).as_posix()
        except ValueError:
            return {}
        return python_import_aliases(tree, from_rel, root)
    if suffix in {".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx"}:
        return js_ts_import_aliases(path, text, root)
    if suffix == ".java":
        return java_import_aliases(path, text, root)
    return {}
