"""Slim mem_atoms content after file mirror — keep index rows, truncate body."""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)

_INDEX_PREVIEW_CHARS = 280


def slim_mem_atoms_for_namespace(namespace: str, *, dry_run: bool = False) -> dict[str, Any]:
    """Replace long atom content with summary/preview for mirrored namespaces."""
    from evoflow.assets.memory_mirror import namespace_to_entity
    from evoflow.memory import store as mem_store

    ns = str(namespace or "").strip()
    if not ns or namespace_to_entity(ns) is None:
        return {"namespace": ns, "slimmed": 0, "skipped": True}

    slimmed = 0
    try:
        atoms = mem_store.list_namespace_atoms(ns, limit=5000)
    except Exception as exc:
        return {"namespace": ns, "slimmed": 0, "error": str(exc)}

    for atom in atoms:
        content = str(atom.get("content") or "")
        if len(content) <= _INDEX_PREVIEW_CHARS:
            continue
        summary = str(atom.get("summary") or "").strip()
        preview = summary if summary else content[:240].rstrip() + "…"
        preview = preview[:_INDEX_PREVIEW_CHARS]
        if dry_run:
            slimmed += 1
            continue
        aid = str(atom.get("id") or "")
        if not aid:
            continue
        try:
            rel = f"assets/{ns.replace(':', '/')}/memory/"
            mem_store.update_atom_fields(
                aid,
                content=preview,
                source_path=rel,
            )
            slimmed += 1
        except Exception:
            logger.debug("slim atom %s failed", aid, exc_info=True)

    return {"namespace": ns, "slimmed": slimmed}


def slim_all_mirrored_namespaces(*, dry_run: bool = False) -> dict[str, Any]:
    from evoflow.memory.namespaces_api import _ns_rows

    total = 0
    details: list[dict[str, Any]] = []
    for row in _ns_rows():
        ns = str(row.get("id") or "")
        r = slim_mem_atoms_for_namespace(ns, dry_run=dry_run)
        total += int(r.get("slimmed") or 0)
        if r.get("slimmed"):
            details.append(r)
    return {"ok": True, "dry_run": dry_run, "slimmed": total, "namespaces": details}
