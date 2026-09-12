"""Format ``search_index`` payloads for tool output (shared by search tools)."""

from __future__ import annotations

from typing import Any


def format_search_index_body(
    data: dict[str, Any],
    *,
    label: str,
    limit: int,
    rebuild_in_progress: bool = False,
    verbose: bool = False,
) -> str:
    """Format search_index payloads. When verbose=False (default), low-signal sections
    (imports, type hierarchy, etc.) with >3 entries are collapsed to count + 2-line preview."""
    hits = data.get("hits") or []
    symbols = data.get("symbols") or []
    # Boost exact-name and partial-name matches to the top of the Symbols list.
    # Within each name-match tier, definitions (function/class/method) rank above
    # usage references so the model sees *where* a symbol is defined before seeing
    # *where* it is merely referenced.
    _DEFINITION_KINDS = frozenset({
        "function", "class", "method", "def", "class_definition",
        "function_definition", "method_definition", "constructor",
        "async_function", "async_function_definition",
    })
    if symbols and label:
        _label_terms = [t.strip().lower() for t in str(label).lower().split("|") if t.strip()]
        if _label_terms:
            def _symbol_rank(s):
                sname = str(s.get("name") or "").lower()
                skind = str(s.get("kind") or "").lower().strip()
                is_def = 0 if skind in _DEFINITION_KINDS else 1
                for t in _label_terms:
                    if sname == t:
                        return (0, is_def)
                for t in _label_terms:
                    if t and t in sname:
                        return (1, is_def)
                return (2, is_def)
            symbols = sorted(symbols, key=_symbol_rank)
    related = data.get("related_files") or []
    imported_by = data.get("imported_by") or []
    imports = data.get("imports") or []
    ref_users = data.get("internal_ref_users") or []
    type_supers = data.get("type_supertypes") or []
    type_subs = data.get("type_subtypes") or []

    lines: list[str] = []
    if rebuild_in_progress:
        lines.append("[index] rebuild in progress — results may be stale")
        lines.append("")
    path_prefix = str(data.get("path_prefix") or "").strip()
    if path_prefix:
        lines.append(f"[path scope] {path_prefix}")
        if data.get("path_scope_relaxed"):
            lines.append("[hint] no hits under path scope — showing best matches elsewhere in the repo")
        elif data.get("path_scope_empty_hint"):
            lines.append(f"[hint] {data.get('path_scope_empty_hint')}")
        lines.append("")
    lines.extend([f"Code index results for '{label}':", ""])
    if symbols:
        lines.append("Symbols:")
        for s in symbols[:limit]:
            lines.append(f"  - {s['kind']} {s['name']} @ {s['path']}:{s['line']}")
        lines.append("")
    if hits:
        lines.append("Content:")
        for h in hits[:limit]:
            snip = str(h.get("snippet") or "").replace("\n", " ")
            lines.append(f"  - {h['path']}: {snip[:200]}")
        lines.append("")

    _COLLAPSE_THRESHOLD = 3

    def _emit_section(title: str, entries: list, formatter) -> None:
        if not entries:
            return
        shown = entries[:limit]
        if not verbose and len(entries) > _COLLAPSE_THRESHOLD:
            preview = entries[:2]
            lines.append(f"{title} ({len(entries)} entries — showing first 2; pass verbose=True to expand):")
            for r in preview:
                lines.append(f"  - {formatter(r)}")
        else:
            lines.append(f"{title}:")
            for r in shown:
                lines.append(f"  - {formatter(r)}")
        lines.append("")

    _emit_section(
        "Imports (internal)", imports,
        lambda r: f"{r.get('from_path')} -> {r.get('to_path')} ({r.get('spec', '')[:60]})",
    )
    _emit_section(
        "Imported by (internal)", imported_by,
        lambda r: f"{r.get('from_path')} imports {r.get('to_path')}",
    )
    _emit_section(
        "Related (import graph neighbors)", related,
        lambda r: f"{r.get('path')}",
    )
    _emit_section(
        "Internal symbol uses", ref_users,
        lambda r: f"{r.get('from_path')}:{r.get('line')} uses {r.get('symbol') or '?'} from {r.get('to_path')}",
    )
    _emit_section(
        "Type hierarchy (supertypes / parents)", type_supers,
        lambda r: f"{r.get('from_type')} @ {r.get('from_path')} {r.get('rel_kind')} {r.get('to_type')} ({r.get('to_path') or '?'})",
    )
    _emit_section(
        "Type hierarchy (subtypes / implementers)", type_subs,
        lambda r: f"{r.get('from_type')} @ {r.get('from_path')} {r.get('rel_kind')} {r.get('to_type')} ({r.get('to_path') or '?'})",
    )
    return "\n".join(lines).rstrip()
