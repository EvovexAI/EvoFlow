"""Unified tree-sitter symbol extraction (Python / JS / TS / Java)."""

from __future__ import annotations

import logging
import re
import warnings
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

Symbol = dict[str, Any]

_LANG_PROFILES: dict[str, dict[str, Any]] = {
    "python": {
        "parser": "python",
        "classes": frozenset({"class_definition"}),
        "interfaces": frozenset(),
        "types": frozenset(),
        "functions": frozenset({"function_definition"}),
    },
    "javascript": {
        "parser": "javascript",
        "classes": frozenset({"class_declaration", "class_definition"}),
        "interfaces": frozenset(),
        "types": frozenset(),
        "functions": frozenset(
            {
                "function_declaration",
                "generator_function_declaration",
                "method_definition",
            }
        ),
    },
    "typescript": {
        "parser": "typescript",
        "classes": frozenset({"class_declaration", "class_definition"}),
        "interfaces": frozenset({"interface_declaration"}),
        "types": frozenset({"type_alias_declaration"}),
        "functions": frozenset(
            {
                "function_declaration",
                "generator_function_declaration",
                "method_definition",
            }
        ),
    },
    "java": {
        "parser": "java",
        "classes": frozenset({"class_declaration"}),
        "interfaces": frozenset({"interface_declaration"}),
        "types": frozenset({"enum_declaration"}),
        "functions": frozenset({"method_declaration", "constructor_declaration"}),
    },
}

_SUFFIX_TO_LANG = {
    ".py": "python",
    ".js": "javascript",
    ".jsx": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".ts": "typescript",
    ".tsx": "typescript",
    ".java": "java",
}

_IDENTIFIER_NODES = frozenset(
    {
        "identifier",
        "type_identifier",
        "property_identifier",
        "shorthand_property_identifier",
    }
)


def language_for_path(path: Path) -> str | None:
    return _SUFFIX_TO_LANG.get(path.suffix.lower())


def tree_sitter_available() -> bool:
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", FutureWarning)
            from tree_sitter_languages import get_parser  # noqa: F401

        return True
    except ImportError:
        return False


def parse_tree(path: Path, text: str) -> tuple[Any, bytes, str] | None:
    """Return (root_node, source_bytes, lang_key) or None."""
    lang_key = language_for_path(path)
    if not lang_key:
        return None
    profile = _LANG_PROFILES.get(lang_key)
    if not profile:
        return None
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", FutureWarning)
            from tree_sitter_languages import get_parser

            parser = get_parser(profile["parser"])
    except ImportError:
        return None
    except Exception as e:
        logger.debug("tree_sitter get_parser(%s) failed: %s", profile["parser"], e)
        return None
    source = text.encode("utf-8", errors="replace")
    try:
        tree = parser.parse(source)
    except Exception:
        return None
    return tree.root_node, source, lang_key


def _append(out: list[Symbol], *, name: str, kind: str, line: int, parser: str) -> None:
    if not name or (name.startswith("_") and name != "__init__"):
        return
    out.append({"name": name, "kind": kind, "line": max(1, int(line or 1)), "parser": parser})


def _node_name(node: Any, source: bytes) -> str | None:
    name_node = node.child_by_field_name("name")
    if name_node is None:
        return None
    return source[name_node.start_byte : name_node.end_byte].decode("utf-8", errors="replace")


def _walk_symbols(node: Any, source: bytes, out: list[Symbol], profile: dict[str, Any], *, lang_key: str) -> None:
    ntype = node.type
    parser_tag = f"tree_sitter_{lang_key}"

    if ntype in profile["classes"]:
        name = _node_name(node, source)
        if name:
            _append(out, name=name, kind="class", line=node.start_point[0] + 1, parser=parser_tag)
    elif ntype in profile.get("interfaces") or ():
        name = _node_name(node, source)
        if name:
            _append(out, name=name, kind="interface", line=node.start_point[0] + 1, parser=parser_tag)
    elif ntype in profile.get("types") or ():
        name = _node_name(node, source)
        if name:
            kind = "enum" if ntype == "enum_declaration" else "type"
            _append(out, name=name, kind=kind, line=node.start_point[0] + 1, parser=parser_tag)
    elif ntype in profile["functions"]:
        name = _node_name(node, source)
        if name:
            kind = "method" if ntype in {"method_definition", "method_declaration", "constructor_declaration"} else "function"
            if lang_key == "python" and node.parent and node.parent.type == "class_definition":
                kind = "method"
            _append(out, name=name, kind=kind, line=node.start_point[0] + 1, parser=parser_tag)

    for child in node.children:
        _walk_symbols(child, source, out, profile, lang_key=lang_key)


def extract_symbols_tree_sitter(path: Path, text: str) -> list[Symbol] | None:
    parsed = parse_tree(path, text)
    if not parsed:
        return None
    root_node, source, lang_key = parsed
    profile = _LANG_PROFILES.get(lang_key)
    if not profile:
        return None
    out: list[Symbol] = []
    _walk_symbols(root_node, source, out, profile, lang_key=lang_key)
    return out if out else None


def walk_identifier_uses(
    path: Path,
    text: str,
    aliases: dict[str, str],
) -> list[tuple[str, int]]:
    """Yield (local_name, line) for identifier nodes matching import aliases."""
    parsed = parse_tree(path, text)
    if parsed:
        root_node, source, _ = parsed
        found: list[tuple[str, int]] = []
        _walk_id_nodes(root_node, source, aliases, found)
        if found:
            return found
    return _regex_identifier_uses(text, aliases)


def _walk_id_nodes(node: Any, source: bytes, aliases: dict[str, str], out: list[tuple[str, int]]) -> None:
    if node.type in _IDENTIFIER_NODES:
        name = source[node.start_byte : node.end_byte].decode("utf-8", errors="replace")
        if name in aliases:
            out.append((name, node.start_point[0] + 1))
    for child in node.children:
        _walk_id_nodes(child, source, aliases, out)


def _regex_identifier_uses(text: str, aliases: dict[str, str]) -> list[tuple[str, int]]:
    out: list[tuple[str, int]] = []
    seen: set[tuple[str, int]] = set()
    for name in aliases:
        if name == "*":
            continue
        for m in re.finditer(rf"\b{re.escape(name)}\b", text):
            line = text[: m.start()].count("\n") + 1
            key = (name, line)
            if key in seen:
                continue
            seen.add(key)
            out.append(key)
    return out
