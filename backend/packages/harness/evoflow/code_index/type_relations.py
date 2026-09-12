"""Class extends / implements (workspace-internal, best-effort)."""

from __future__ import annotations

import ast
import re
import sqlite3
from pathlib import Path
from typing import Any

from evoflow.code_index.deps import _resolve_java_spec, _resolve_py_module
from evoflow.code_index.import_bindings import import_aliases_for_file, python_import_aliases

TypeRelation = dict[str, Any]

_TYPE_SYMBOL_KINDS = ("interface", "class", "type", "enum")

_JAVA_EXTENDS = re.compile(r"(?:public\s+|private\s+|protected\s+)?(?:abstract\s+)?class\s+(\w+)\s+extends\s+([\w.]+)")
_JAVA_IMPLEMENTS = re.compile(r"(?:public\s+|private\s+|protected\s+)?(?:abstract\s+)?class\s+(\w+)\s+implements\s+([\w\s,]+)")
_TS_CLASS_HEAD = re.compile(
    r"(?:export\s+)?(?:abstract\s+)?class\s+(\w+)(.*?)\{",
    re.MULTILINE,
)
_TS_EXTENDS = re.compile(r"\bextends\s+([\w.]+(?:<[^>]+>)?)")
_TS_IMPLEMENTS = re.compile(r"\bimplements\s+(.+)$")
_TS_LOCAL_TYPE = re.compile(
    r"(?:export\s+)?(?:declare\s+)?(?:abstract\s+)?(?:interface|class|type)\s+(\w+)",
    re.MULTILINE,
)

_TYPE_SUFFIXES = frozenset({".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".java"})


def _line_at(text: str, index: int) -> int:
    return text[:index].count("\n") + 1 if index >= 0 else 0


def _strip_generics(name: str) -> str:
    """``Foo<T>`` -> ``Foo``; ``A.B<C>`` -> ``A.B``."""
    s = str(name or "").strip()
    if "<" in s:
        s = s.split("<", 1)[0].strip()
    return s


def _split_type_parts(name: str) -> list[str]:
    return [p for p in _strip_generics(name).split(".") if p]


def lookup_type_symbol_path(
    conn: sqlite3.Connection,
    type_name: str,
    *,
    exclude_path: str | None = None,
) -> str | None:
    """Find workspace file defining a class/interface/type by symbol name."""
    bare = _split_type_parts(type_name)[-1] if type_name else ""
    if not bare:
        return None
    kinds = _TYPE_SYMBOL_KINDS
    sql = f"""
        SELECT path FROM symbols
        WHERE name = ? AND kind IN ({",".join("?" * len(kinds))})
    """
    params: list[Any] = [bare, *kinds]
    if exclude_path:
        sql += " AND path != ?"
        params.append(exclude_path)
    sql += """
        ORDER BY
            CASE kind
                WHEN 'interface' THEN 0
                WHEN 'class' THEN 1
                WHEN 'type' THEN 2
                ELSE 3
            END,
            path
        LIMIT 1
    """
    row = conn.execute(sql, params).fetchone()
    return str(row[0]) if row else None


def enrich_type_relations(
    conn: sqlite3.Connection,
    rows: list[TypeRelation],
    *,
    from_rel: str,
) -> list[TypeRelation]:
    """Fill missing ``to_path`` via indexed symbol names (cross-file)."""
    for row in rows:
        if row.get("to_path"):
            continue
        to_type = str(row.get("to_type") or "")
        tp = lookup_type_symbol_path(conn, to_type, exclude_path=from_rel)
        if tp:
            row["to_path"] = tp
    return rows


def _ts_local_types(text: str) -> set[str]:
    return {m.group(1) for m in _TS_LOCAL_TYPE.finditer(text)}


def _resolve_type_ref(
    name: str,
    *,
    from_rel: str,
    root: Path,
    aliases: dict[str, str],
    local_types: set[str],
    conn: sqlite3.Connection | None = None,
) -> tuple[str | None, str]:
    raw = _strip_generics(name)
    parts = _split_type_parts(raw)
    bare = parts[-1] if parts else ""
    if not bare:
        return None, raw

    if len(parts) > 1:
        prefix = parts[0]
        if prefix in aliases:
            return aliases[prefix], bare
        qual = ".".join(parts)
        tp = _resolve_py_module(root, from_rel, qual)
        if tp:
            return tp, bare

    if bare in aliases:
        return aliases[bare], bare
    if bare in local_types:
        return from_rel, bare

    tp = _resolve_py_module(root, from_rel, raw)
    if tp:
        return tp, bare
    if raw.count(".") >= 2:
        tp = _resolve_java_spec(root, raw)
        if tp:
            return tp, bare

    if conn is not None:
        tp = lookup_type_symbol_path(conn, bare, exclude_path=from_rel)
        if tp:
            return tp, bare

    return None, bare


def extract_python_type_relations(path: Path, text: str, workspace_root: str | Path) -> list[TypeRelation]:
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
    local_types = {n.name for n in tree.body if isinstance(n, (ast.ClassDef, ast.FunctionDef))}
    out: list[TypeRelation] = []

    for node in tree.body:
        if not isinstance(node, ast.ClassDef):
            continue
        for base in node.bases:
            if isinstance(base, ast.Name):
                bname = base.id
            elif isinstance(base, ast.Attribute):
                bname = base.attr
            else:
                continue
            to_path, to_type = _resolve_type_ref(bname, from_rel=from_rel, root=root, aliases=aliases, local_types=local_types)
            out.append(
                {
                    "from_path": from_rel,
                    "from_type": node.name,
                    "to_path": to_path,
                    "to_type": to_type,
                    "rel_kind": "extends",
                    "line": int(node.lineno or 0),
                }
            )
    return out


def _append_ts_relation(
    out: list[TypeRelation],
    seen: set[tuple[str, str, str, str]],
    *,
    from_rel: str,
    from_type: str,
    type_name: str,
    rel_kind: str,
    line: int,
    root: Path,
    aliases: dict[str, str],
    local_types: set[str],
    conn: sqlite3.Connection | None,
) -> None:
    clean = _strip_generics(type_name).strip()
    if not clean:
        return
    to_path, to_type = _resolve_type_ref(
        clean,
        from_rel=from_rel,
        root=root,
        aliases=aliases,
        local_types=local_types,
        conn=conn,
    )
    key = (from_rel, from_type, to_type, rel_kind)
    if key in seen:
        return
    seen.add(key)
    out.append(
        {
            "from_path": from_rel,
            "from_type": from_type,
            "to_path": to_path,
            "to_type": to_type,
            "rel_kind": rel_kind,
            "line": line,
        }
    )


def _parse_implements_list(raw: str) -> list[str]:
    names: list[str] = []
    depth = 0
    buf: list[str] = []
    for ch in raw:
        if ch == "<":
            depth += 1
        elif ch == ">":
            depth = max(0, depth - 1)
        elif ch == "," and depth == 0:
            piece = "".join(buf).strip()
            if piece:
                names.append(piece)
            buf = []
            continue
        buf.append(ch)
    tail = "".join(buf).strip()
    if tail:
        names.append(tail)
    return names


def _extract_ts_type_relations(
    path: Path,
    text: str,
    workspace_root: str | Path,
    *,
    conn: sqlite3.Connection | None = None,
) -> list[TypeRelation]:
    root = Path(workspace_root).resolve()
    try:
        from_rel = path.resolve().relative_to(root).as_posix()
    except ValueError:
        return []

    aliases = import_aliases_for_file(path, text, root)
    local_types = _ts_local_types(text)
    out: list[TypeRelation] = []
    seen: set[tuple[str, str, str, str]] = set()

    for m in _TS_CLASS_HEAD.finditer(text):
        from_type = m.group(1)
        header = m.group(2) or ""
        line = _line_at(text, m.start())
        extends_m = _TS_EXTENDS.search(header)
        if extends_m:
            _append_ts_relation(
                out,
                seen,
                from_rel=from_rel,
                from_type=from_type,
                type_name=extends_m.group(1),
                rel_kind="extends",
                line=line,
                root=root,
                aliases=aliases,
                local_types=local_types,
                conn=conn,
            )
        implements_m = _TS_IMPLEMENTS.search(header)
        implements = implements_m.group(1).strip() if implements_m else ""
        for iname in _parse_implements_list(implements):
            _append_ts_relation(
                out,
                seen,
                from_rel=from_rel,
                from_type=from_type,
                type_name=iname,
                rel_kind="implements",
                line=line,
                root=root,
                aliases=aliases,
                local_types=local_types,
                conn=conn,
            )

    if not out:
        ts_out = extract_type_relations_tree_sitter(path, text) or []
        for row in ts_out:
            _append_ts_relation(
                out,
                seen,
                from_rel=from_rel,
                from_type=str(row.get("from_type") or ""),
                type_name=str(row.get("to_type") or ""),
                rel_kind=str(row.get("rel_kind") or "extends"),
                line=int(row.get("line") or 0),
                root=root,
                aliases=aliases,
                local_types=local_types,
                conn=conn,
            )

    return out


def extract_java_type_relations(path: Path, text: str, workspace_root: str | Path) -> list[TypeRelation]:
    root = Path(workspace_root).resolve()
    try:
        from_rel = path.resolve().relative_to(root).as_posix()
    except ValueError:
        return []
    aliases = import_aliases_for_file(path, text, root)
    out: list[TypeRelation] = []
    for m in _JAVA_EXTENDS.finditer(text):
        from_type, parent = m.group(1), m.group(2)
        to_path, to_type = _resolve_type_ref(parent, from_rel=from_rel, root=root, aliases=aliases, local_types=set())
        out.append(
            {
                "from_path": from_rel,
                "from_type": from_type,
                "to_path": to_path,
                "to_type": to_type,
                "rel_kind": "extends",
                "line": _line_at(text, m.start()),
            }
        )
    for m in _JAVA_IMPLEMENTS.finditer(text):
        from_type = m.group(1)
        for part in m.group(2).split(","):
            iname = part.strip()
            if not iname:
                continue
            to_path, to_type = _resolve_type_ref(iname, from_rel=from_rel, root=root, aliases=aliases, local_types=set())
            out.append(
                {
                    "from_path": from_rel,
                    "from_type": from_type,
                    "to_path": to_path,
                    "to_type": to_type,
                    "rel_kind": "implements",
                    "line": _line_at(text, m.start()),
                }
            )
    return out


def extract_type_relations_tree_sitter(path: Path, text: str) -> list[TypeRelation] | None:
    from evoflow.code_index.tree_sitter_core import language_for_path, parse_tree

    lang = language_for_path(path)
    if lang not in {"typescript", "javascript", "java"}:
        return None
    parsed = parse_tree(path, text)
    if not parsed:
        return None
    root_node, source, lang_key = parsed
    out: list[TypeRelation] = []
    _walk_ts_heritage(root_node, source, lang_key, out)
    return out if out else None


def _walk_ts_heritage(node: Any, source: bytes, lang_key: str, out: list[TypeRelation]) -> None:
    if node.type == "class_declaration":
        name = _ts_node_name(node, source)
        if name:
            for child in node.children:
                if child.type == "extends_clause":
                    base = _heritage_type_name(child, source)
                    if base:
                        out.append(
                            {
                                "from_path": "",
                                "from_type": name,
                                "to_path": None,
                                "to_type": base,
                                "rel_kind": "extends",
                                "line": node.start_point[0] + 1,
                            }
                        )
                elif child.type == "implements_clause":
                    for iface in _implements_names(child, source):
                        out.append(
                            {
                                "from_path": "",
                                "from_type": name,
                                "to_path": None,
                                "to_type": iface,
                                "rel_kind": "implements",
                                "line": node.start_point[0] + 1,
                            }
                        )
    for child in node.children:
        _walk_ts_heritage(child, source, lang_key, out)


def _ts_node_name(node: Any, source: bytes) -> str | None:
    nn = node.child_by_field_name("name")
    if nn is None:
        return None
    return source[nn.start_byte : nn.end_byte].decode("utf-8", errors="replace")


def _heritage_type_name(node: Any, source: bytes) -> str | None:
    for child in node.children:
        if child.type in {"identifier", "type_identifier", "nested_type_identifier"}:
            return source[child.start_byte : child.end_byte].decode("utf-8", errors="replace")
    return None


def _implements_names(node: Any, source: bytes) -> list[str]:
    names: list[str] = []
    for child in node.children:
        if child.type in {"identifier", "type_identifier", "nested_type_identifier"}:
            names.append(source[child.start_byte : child.end_byte].decode("utf-8", errors="replace"))
        elif child.type == "type_list":
            names.extend(_implements_names(child, source))
    return names


def extract_type_relations(
    path: Path,
    text: str,
    workspace_root: str | Path,
    *,
    conn: sqlite3.Connection | None = None,
) -> list[TypeRelation]:
    suffix = path.suffix.lower()

    if suffix == ".py":
        return extract_python_type_relations(path, text, workspace_root)

    if suffix in {".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"}:
        return _extract_ts_type_relations(path, text, workspace_root, conn=conn)

    if suffix == ".java":
        rows = extract_java_type_relations(path, text, workspace_root)
        if conn is not None:
            try:
                from_rel = path.resolve().relative_to(Path(workspace_root).resolve()).as_posix()
            except ValueError:
                from_rel = ""
            enrich_type_relations(conn, rows, from_rel=from_rel)
        return rows

    return []


def list_type_relations_for_search(
    conn: sqlite3.Connection,
    *,
    seed_paths: list[str],
    type_names: list[str],
    limit: int,
) -> tuple[list[dict], list[dict]]:
    """Return (supertypes, subtypes) from path seeds and/or symbol names."""
    supertypes: list[dict] = []
    subtypes: list[dict] = []
    seen_s: set[tuple[str, str, str, str]] = set()
    seen_t: set[tuple[str, str, str, str]] = set()

    def _row_to_dict(r: sqlite3.Row, kind: str) -> dict:
        return {
            "from_path": str(r[0]),
            "from_type": str(r[1]),
            "to_path": str(r[2] or "") or None,
            "to_type": str(r[3]),
            "rel_kind": str(r[4]),
            "line": int(r[5] or 0),
            "kind": kind,
        }

    def _add(rows: list[sqlite3.Row], bucket: list[dict], seen: set[tuple[str, str, str, str]], kind: str) -> None:
        for r in rows:
            d = _row_to_dict(r, kind)
            key = (d["from_path"], d["from_type"], d["to_type"], d["rel_kind"])
            if key in seen:
                continue
            seen.add(key)
            bucket.append(d)
            if len(bucket) >= limit:
                return

    cols = "from_path, from_type, to_path, to_type, rel_kind, line"

    if seed_paths:
        ph = ",".join("?" for _ in seed_paths)
        _add(
            conn.execute(
                f"SELECT {cols} FROM type_relations WHERE from_path IN ({ph}) LIMIT ?",
                (*seed_paths, limit),
            ).fetchall(),
            supertypes,
            seen_s,
            "type_supertype",
        )
        _add(
            conn.execute(
                f"SELECT {cols} FROM type_relations WHERE to_path IN ({ph}) LIMIT ?",
                (*seed_paths, limit),
            ).fetchall(),
            subtypes,
            seen_t,
            "type_subtype",
        )

    names = [n for n in {str(x).strip() for x in type_names} if n]
    if names:
        ph = ",".join("?" for _ in names)
        _add(
            conn.execute(
                f"SELECT {cols} FROM type_relations WHERE from_type IN ({ph}) LIMIT ?",
                (*names, limit),
            ).fetchall(),
            supertypes,
            seen_s,
            "type_supertype",
        )
        _add(
            conn.execute(
                f"SELECT {cols} FROM type_relations WHERE to_type IN ({ph}) LIMIT ?",
                (*names, limit),
            ).fetchall(),
            subtypes,
            seen_t,
            "type_subtype",
        )

    return supertypes[:limit], subtypes[:limit]


def supports_type_relations(path: Path) -> bool:
    return path.suffix.lower() in _TYPE_SUFFIXES
