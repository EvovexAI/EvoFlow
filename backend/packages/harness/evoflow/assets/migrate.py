"""Asset Hub migration helpers (experience → craft, memory → files)."""

from __future__ import annotations

import json
import logging
from typing import Any

logger = logging.getLogger(__name__)


def _experience_row_to_dict(row) -> dict[str, Any]:
    """Map legacy ``evoflow_experience_entries`` row → craft payload fields."""
    return {
        "id": row[0],
        "title": row[1],
        "category": row[2],
        "tags": json.loads(row[3]) if row[3] else [],
        "context": json.loads(row[4]) if row[4] else {},
        "steps": json.loads(row[5]) if row[5] else [],
        "source_sessions": json.loads(row[6]) if row[6] else [],
        "related_ids": json.loads(row[7]) if row[7] else [],
        "confidence": row[8],
        "use_count": row[9],
        "superseded_by": row[10],
        "deprecated": bool(row[11]),
        "created_at": row[12],
        "updated_at": row[13],
        "last_used_at": row[14],
        "storage": "sqlite",
    }


def migrate_sqlite_experiences_to_craft(*, dry_run: bool = False) -> dict[str, Any]:
    """Copy legacy SQLite experience rows into ``craft/*.md``."""
    from evoflow.assets.craft import get_craft_experience, save_craft_from_experience
    from evoflow.persistence import get_db
    from evoflow.persistence.schema import ensure_app_schema

    db = get_db()
    ensure_app_schema(db)
    rows = db.execute(
        "SELECT * FROM evoflow_experience_entries WHERE deprecated = 0 ORDER BY created_at"
    ).fetchall()
    migrated = 0
    skipped = 0
    errors: list[str] = []
    for row in rows:
        data = _experience_row_to_dict(row)
        eid = str(data.get("id") or "")
        if not eid:
            continue
        if get_craft_experience(eid) is not None:
            skipped += 1
            continue
        if dry_run:
            migrated += 1
            continue
        try:
            payload = {
                **data,
                "origin": "migrated_experience",
                "problem": (data.get("context") or {}).get("problem"),
                "solution": (data.get("context") or {}).get("solution"),
                "outcome": (data.get("context") or {}).get("outcome"),
                "applicable_to": (data.get("context") or {}).get("applicable_to"),
            }
            save_craft_from_experience(payload)
            migrated += 1
        except Exception as exc:
            errors.append(f"{eid}: {exc}")
    return {
        "ok": not errors,
        "dry_run": dry_run,
        "total": len(rows),
        "migrated": migrated,
        "skipped": skipped,
        "errors": errors,
    }


def migrate_experiences(*, dry_run: bool = False) -> dict[str, Any]:
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
