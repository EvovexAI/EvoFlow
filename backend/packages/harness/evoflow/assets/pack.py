"""`.evoflow-pack` export / import for Entity Asset Hub subtrees."""

from __future__ import annotations

import json
import logging
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from evoflow.assets.paths import EntityRef, entity_relative_dir, entity_root

logger = logging.getLogger(__name__)

PACK_KIND = "evoflow-asset-pack"
PACK_VERSION = 1
ConflictPolicy = Literal["skip", "rename", "overwrite"]

_INCLUDE_DIRS = ("profile", "memory", "craft")


def _exports_dir() -> Path:
    from evoflow.config.paths import get_paths

    d = get_paths().base_dir / "exports"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _manifest(entity: EntityRef) -> dict[str, Any]:
    e = entity.normalized()
    return {
        "kind": PACK_KIND,
        "version": PACK_VERSION,
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "entity": {"type": e.entity_type, "id": e.entity_id},
        "includes": list(_INCLUDE_DIRS),
        "relative_root": entity_relative_dir(e),
    }


def export_entity_pack(
    entity: EntityRef,
    *,
    output_path: Path | None = None,
) -> dict[str, Any]:
    """Zip entity profile/memory/craft into ``*.evoflow-pack`` (zip archive)."""
    from evoflow.assets.hub import ensure_entity_tree

    e = entity.normalized()
    ensure_entity_tree(e)
    root = entity_root(e)
    if not root.is_dir():
        raise FileNotFoundError(str(root))

    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    fname = f"{e.entity_type}-{e.entity_id}-{stamp}.evoflow-pack"
    out = output_path or (_exports_dir() / fname)
    out.parent.mkdir(parents=True, exist_ok=True)

    manifest = _manifest(e)
    rel_root = entity_relative_dir(e)
    file_count = 0

    with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
        for sub in _INCLUDE_DIRS:
            src_dir = root / sub
            if not src_dir.is_dir():
                continue
            for fp in src_dir.rglob("*"):
                if not fp.is_file() or fp.name.startswith("."):
                    continue
                arc = f"{rel_root}/{fp.relative_to(root).as_posix()}"
                zf.write(fp, arcname=arc)
                file_count += 1

    return {
        "ok": True,
        "path": str(out.resolve()),
        "filename": out.name,
        "sizeBytes": out.stat().st_size,
        "fileCount": file_count,
        "entity": manifest["entity"],
    }


def import_entity_pack(
    pack_path: Path | str,
    target: EntityRef,
    *,
    conflict: ConflictPolicy = "skip",
) -> dict[str, Any]:
    """Import pack zip into target entity assets tree."""
    from evoflow.assets.hub import ensure_entity_tree

    src = Path(pack_path).expanduser().resolve()
    if not src.is_file():
        raise FileNotFoundError(str(src))

    e = target.normalized()
    ensure_entity_tree(e)
    dest_root = entity_root(e)

    copied = 0
    skipped = 0
    renamed = 0

    with zipfile.ZipFile(src, "r") as zf:
        manifest_raw = zf.read("manifest.json").decode("utf-8")
        manifest = json.loads(manifest_raw)
        if str(manifest.get("kind") or "") != PACK_KIND:
            raise ValueError("not an evoflow-asset-pack")

        rel_root = str(manifest.get("relative_root") or "").strip().replace("\\", "/")
        prefix = f"{rel_root}/" if rel_root else ""

        for info in zf.infolist():
            if info.is_dir() or info.filename == "manifest.json":
                continue
            arc = info.filename.replace("\\", "/")
            if prefix and arc.startswith(prefix):
                rel = arc[len(prefix) :]
            elif "/" in arc:
                # Accept packs that store paths relative to entity root only
                parts = arc.split("/", 1)
                rel = parts[1] if len(parts) == 2 and parts[0] in ("user", "agents", "employees") else arc
            else:
                rel = arc
            if not rel or rel.startswith(".."):
                continue
            top = rel.split("/", 1)[0]
            if top not in _INCLUDE_DIRS:
                continue
            target_path = dest_root / rel
            target_path.parent.mkdir(parents=True, exist_ok=True)
            if target_path.exists() and conflict == "skip":
                skipped += 1
                continue
            if target_path.exists() and conflict == "rename":
                stem = target_path.stem
                suffix = target_path.suffix
                n = 1
                while target_path.exists():
                    target_path = target_path.with_name(f"{stem}-import{n}{suffix}")
                    n += 1
                renamed += 1
            data = zf.read(info.filename)
            target_path.write_bytes(data)
            copied += 1

    try:
        from evoflow.assets.memory_mirror import schedule_asset_vault_reindex_delayed

        schedule_asset_vault_reindex_delayed(delay_s=5.0)
    except Exception:
        logger.debug("pack import reindex schedule skipped", exc_info=True)

    return {
        "ok": True,
        "copied": copied,
        "skipped": skipped,
        "renamed": renamed,
        "target": {"entityType": e.entity_type, "entityId": e.entity_id},
        "destRoot": str(dest_root.resolve()),
    }


def export_user_pack(**kwargs: Any) -> dict[str, Any]:
    return export_entity_pack(EntityRef("user", "user"), **kwargs)
