"""Per-language symbol extraction (tree-sitter first, LSP, AST/regex fallback)."""

from __future__ import annotations

import ast
import logging
import re
from pathlib import Path
from typing import Any

from evoflow.config.code_index_config import get_code_index_config

logger = logging.getLogger(__name__)

Symbol = dict[str, Any]

_PY_CLASS = re.compile(r"^\s*class\s+(\w+)", re.MULTILINE)
_PY_DEF = re.compile(r"^\s*(?:async\s+)?def\s+(\w+)", re.MULTILINE)
_JS_FN = re.compile(
    r"(?:function\s+(\w+)|(?:export\s+)?(?:async\s+)?function\s+(\w+)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\()",
    re.MULTILINE,
)
_JS_CLASS = re.compile(r"(?:export\s+)?class\s+(\w+)", re.MULTILINE)
_JS_INTERFACE = re.compile(r"(?:export\s+)?interface\s+(\w+)", re.MULTILINE)
_JS_TYPE = re.compile(r"(?:export\s+)?type\s+(\w+)\s*=", re.MULTILINE)
_JAVA_CLASS = re.compile(r"(?:public\s+|private\s+|protected\s+)?(?:abstract\s+)?class\s+(\w+)", re.MULTILINE)
_JAVA_INTERFACE = re.compile(r"(?:public\s+)?interface\s+(\w+)", re.MULTILINE)
_JAVA_METHOD = re.compile(
    r"(?:public|private|protected|static|\s)+[\w<>\[\]]+\s+(\w+)\s*\([^;]*\)\s*(?:throws\s+[\w.,\s]+)?\s*\{",
    re.MULTILINE,
)
_GO_FN = re.compile(r"^func\s+(?:\([^)]*\)\s+)?(\w+)", re.MULTILINE)
_GO_TYPE = re.compile(r"^type\s+(\w+)", re.MULTILINE)

_CURSOR_LANGS = frozenset({".py", ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".java"})


def _append(out: list[Symbol], *, name: str, kind: str, line: int, parser: str) -> None:
    if not name or (name.startswith("_") and name != "__init__"):
        return
    out.append({"name": name, "kind": kind, "line": max(1, int(line or 1)), "parser": parser})


def _line_at(text: str, index: int) -> int:
    return text[:index].count("\n") + 1 if index >= 0 else 0


def _regex_python_symbols(text: str) -> list[Symbol]:
    out: list[Symbol] = []
    for m in _PY_CLASS.finditer(text):
        _append(out, name=m.group(1), kind="class", line=_line_at(text, m.start()), parser="python_regex")
    for m in _PY_DEF.finditer(text):
        name = m.group(1)
        if name.startswith("_") and name != "__init__":
            continue
        _append(out, name=name, kind="function", line=_line_at(text, m.start()), parser="python_regex")
    return out


def _ast_python_symbols(text: str) -> list[Symbol]:
    try:
        tree = ast.parse(text)
    except SyntaxError:
        return _regex_python_symbols(text)

    out: list[Symbol] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef):
            _append(out, name=node.name, kind="class", line=int(node.lineno or 0), parser="python_ast")
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            if node.name.startswith("_") and node.name != "__init__":
                continue
            _append(out, name=node.name, kind="function", line=int(node.lineno or 0), parser="python_ast")
    return out or _regex_python_symbols(text)


def _regex_java_symbols(text: str) -> list[Symbol]:
    out: list[Symbol] = []
    for m in _JAVA_CLASS.finditer(text):
        _append(out, name=m.group(1), kind="class", line=_line_at(text, m.start()), parser="java_regex")
    for m in _JAVA_INTERFACE.finditer(text):
        _append(out, name=m.group(1), kind="interface", line=_line_at(text, m.start()), parser="java_regex")
    for m in _JAVA_METHOD.finditer(text):
        name = m.group(1)
        if name in {"if", "for", "while", "switch", "catch"}:
            continue
        _append(out, name=name, kind="method", line=_line_at(text, m.start()), parser="java_regex")
    return out


def _javalang_symbols(text: str) -> list[Symbol]:
    try:
        import javalang
    except ImportError:
        return _regex_java_symbols(text)

    try:
        tree = javalang.parse.parse(text)
    except Exception:
        return _regex_java_symbols(text)

    out: list[Symbol] = []
    for _, node in tree.filter(javalang.tree.ClassDeclaration):
        line = int(node.position.line) if getattr(node, "position", None) else 0
        _append(out, name=node.name, kind="class", line=line, parser="java_ast")
    for _, node in tree.filter(javalang.tree.InterfaceDeclaration):
        line = int(node.position.line) if getattr(node, "position", None) else 0
        _append(out, name=node.name, kind="interface", line=line, parser="java_ast")
    for _, node in tree.filter(javalang.tree.EnumDeclaration):
        line = int(node.position.line) if getattr(node, "position", None) else 0
        _append(out, name=node.name, kind="enum", line=line, parser="java_ast")
    for _, node in tree.filter(javalang.tree.MethodDeclaration):
        line = int(node.position.line) if getattr(node, "position", None) else 0
        _append(out, name=node.name, kind="method", line=line, parser="java_ast")
    for _, node in tree.filter(javalang.tree.ConstructorDeclaration):
        line = int(node.position.line) if getattr(node, "position", None) else 0
        _append(out, name=node.name, kind="constructor", line=line, parser="java_ast")
    return out or _regex_java_symbols(text)


def _regex_js_symbols(text: str, *, typescript: bool) -> list[Symbol]:
    out: list[Symbol] = []
    parser = "typescript_regex" if typescript else "javascript_regex"
    for m in _JS_CLASS.finditer(text):
        _append(out, name=m.group(1), kind="class", line=_line_at(text, m.start()), parser=parser)
    if typescript:
        for m in _JS_INTERFACE.finditer(text):
            _append(out, name=m.group(1), kind="interface", line=_line_at(text, m.start()), parser=parser)
        for m in _JS_TYPE.finditer(text):
            _append(out, name=m.group(1), kind="type", line=_line_at(text, m.start()), parser=parser)
    for m in _JS_FN.finditer(text):
        name = m.group(1) or m.group(2) or m.group(3)
        if not name:
            continue
        _append(out, name=name, kind="function", line=_line_at(text, m.start()), parser=parser)
    return out


def _fallback_symbols(path: Path, text: str) -> list[Symbol]:
    suffix = path.suffix.lower()
    if suffix == ".py":
        return _ast_python_symbols(text)
    if suffix in {".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx"}:
        return _regex_js_symbols(text, typescript=suffix in {".ts", ".tsx"})
    if suffix == ".java":
        return _javalang_symbols(text)
    if suffix == ".go":
        out: list[Symbol] = []
        for m in _GO_TYPE.finditer(text):
            _append(out, name=m.group(1), kind="type", line=_line_at(text, m.start()), parser="go_regex")
        for m in _GO_FN.finditer(text):
            _append(out, name=m.group(1), kind="function", line=_line_at(text, m.start()), parser="go_regex")
        return out
    return []


def extract_symbols(
    path: Path,
    text: str,
    *,
    workspace_root: str | Path | None = None,
    for_full_build: bool = False,
) -> list[Symbol]:
    """Return up to 200 symbols; prefer tree-sitter → LSP → AST/regex."""
    cfg = get_code_index_config()
    suffix = path.suffix.lower()
    mode = str(cfg.index_parser_mode or "tree_sitter_first").strip().lower()

    def _try_tree_sitter() -> list[Symbol] | None:
        if suffix not in _CURSOR_LANGS:
            return None
        from evoflow.code_index.tree_sitter_core import extract_symbols_tree_sitter

        return extract_symbols_tree_sitter(path, text)

    def _try_lsp() -> list[Symbol] | None:
        if workspace_root is None or not cfg.lsp_enabled:
            return None
        from evoflow.code_index.lsp_pool import try_lsp_symbols

        out = try_lsp_symbols(
            str(workspace_root),
            path,
            text,
            for_full_build=for_full_build,
        )
        return out if out else None

    out: list[Symbol] = []
    if mode == "lsp_first":
        lsp_out = _try_lsp()
        if lsp_out:
            return lsp_out[:200]
        ts_out = _try_tree_sitter()
        if ts_out:
            return ts_out[:200]
        return _fallback_symbols(path, text)[:200]

    ts_out = _try_tree_sitter()
    if ts_out:
        out = ts_out
    if not out and cfg.lsp_enabled:
        lsp_out = _try_lsp()
        if lsp_out:
            out = lsp_out
    if not out:
        out = _fallback_symbols(path, text)
    return out[:200]
