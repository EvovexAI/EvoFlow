"""Asset Hub migration helpers (experience → craft, memory → files)."""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)


def migrate_experiences(*, dry_run: bool = False) -> dict[str, Any]:
    from evoflow.admin.experience import migrate_sqlite_experiences_to_craft

    return migrate_sqlite_experiences_to_craft(dry_run=dry_run)


def migrate_memory_namespaces(*, dry_run: bool = False) -> dict[str, Any]:
    """Mirror all mem_* namespaces into Asset Hub markdown files."""
    from evoflow.assets.memory_mirror import mirror_memory_document, namespace_to_entity, schedule_asset_vault_reindex_delayed
    from evoflow.memory.document_codec import atoms_to_document
    from evoflow.memory.namespaces_api import _ns_rows

    namespaces = [str(r.get("id") or "") for r in _ns_rows() if str(r.get("id") or "")]
    mirrored = 0
    skipped = 0
    errors: list[str] = []
    for ns in namespaces:
        if namespace_to_entity(ns) is None:
            skipped += 1
            continue
        if dry_run:
            mirrored += 1
            continue
        try:
            doc = atoms_to_document(ns)
            n = mirror_memory_document(ns, doc)
            if n:
                mirrored += 1
            else:
                skipped += 1
        except Exception as exc:
            errors.append(f"{ns}: {exc}")
    if mirrored and not dry_run:
        schedule_asset_vault_reindex_delayed(delay_s=5.0)
    return {
        "ok": not errors,
        "dry_run": dry_run,
        "namespaces": len(namespaces),
        "mirrored": mirrored,
        "skipped": skipped,
        "errors": errors,
    }


def migrate_all(*, dry_run: bool = False) -> dict[str, Any]:
    from evoflow.assets.hub import ensure_assets_tree

    ensure_assets_tree()
    exp = migrate_experiences(dry_run=dry_run)
    mem = migrate_memory_namespaces(dry_run=dry_run)
    return {"ok": exp.get("ok") and mem.get("ok"), "experiences": exp, "memory": mem}


def migrate_slim_atoms(*, dry_run: bool = False) -> dict[str, Any]:
    """After file mirror: truncate mem_atoms content to index preview + source_path."""
    from evoflow.assets.slim_atoms import slim_all_mirrored_namespaces

    return slim_all_mirrored_namespaces(dry_run=dry_run)
