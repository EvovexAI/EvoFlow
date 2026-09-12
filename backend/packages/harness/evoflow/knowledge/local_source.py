"""Bind a local directory as a knowledge base source (scan in place, no copy)."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from evoflow.knowledge.folders import ensure_folder_chain, root_folder_id
from evoflow.knowledge.parser import supported_extensions
from evoflow.knowledge.processor import process_file
from evoflow.persistence.db import db_connection_lock, get_db

logger = logging.getLogger(__name__)

_SKIP_DIR_NAMES = {
    ".git",
    ".svn",
    ".hg",
    "__pycache__",
    "node_modules",
    ".venv",
    "venv",
    "dist",
    "build",
    ".evoflow",
}
_SUPPORTED = supported_extensions()


def _get_settings(dataset_id: str) -> dict:
    import json

    with db_connection_lock():
        conn = get_db()
        row = conn.execute(
            "SELECT metadata_json FROM evoflow_kb_dataset WHERE dataset_id = ?",
            (dataset_id,),
        ).fetchone()
    if row is None:
        return {}
    try:
        return json.loads(row["metadata_json"] or "{}")
    except json.JSONDecodeError:
        return {}


def normalize_local_root(path: str | Path) -> Path:
    p = Path(path).expanduser().resolve()
    if not p.exists():
        raise ValueError(f"local path does not exist: {p}")
    if not p.is_dir():
        raise ValueError(f"local path is not a directory: {p}")
    return p


def iter_local_files(root: Path) -> list[tuple[Path, str]]:
    """Walk *root* and yield (absolute path, relative posix path) for supported files."""
    items: list[tuple[Path, str]] = []
    root = root.resolve()
    for p in sorted(root.rglob("*")):
        if not p.is_file():
            continue
        rel = p.relative_to(root).as_posix()
        rel_parts = Path(rel).parts
        if any(part.startswith(".") for part in rel_parts):
            continue
        if any(part in _SKIP_DIR_NAMES for part in rel_parts[:-1]):
            continue
        if p.suffix.lower() not in _SUPPORTED:
            continue
        items.append((p, rel))
    return items


def _folder_id_for_relative(dataset_id: str, rel_path: str) -> str:
    parts = Path(rel_path).parts
    if len(parts) <= 1:
        return root_folder_id(dataset_id)
    return ensure_folder_chain(dataset_id, list(parts[:-1]))


async def sync_local_source(
    dataset_id: str,
    *,
    local_path: str | Path | None = None,
    force: bool = False,
) -> dict[str, Any]:
    """Scan a bound local directory and index supported files in place."""
    settings = _get_settings(dataset_id)
    root_raw = local_path if local_path is not None else settings.get("local_source_path")
    root_str = str(root_raw or "").strip()
    if not root_str:
        raise ValueError("no local_source_path configured for this knowledge base")

    root = normalize_local_root(root_str)
    llm_index = bool(settings.get("llm_index_enabled", True))
    files = iter_local_files(root)

    stats = {"scanned": len(files), "indexed": 0, "skipped": 0, "errors": 0, "removed": 0}

    seen_paths: set[str] = set()
    for abs_path, rel in files:
        seen_paths.add(str(abs_path.resolve()))
        try:
            file_id = await process_file(
                dataset_id,
                abs_path,
                folder_id=_folder_id_for_relative(dataset_id, rel),
                relative_path=rel,
                llm_index=llm_index,
                stable_path_key=str(abs_path.resolve()),
                skip_if_unchanged=not force,
            )
            if file_id is None:
                stats["skipped"] += 1
            else:
                stats["indexed"] += 1
        except Exception as e:
            stats["errors"] += 1
            logger.warning("Local sync failed for %s: %s", rel, e)

    if not force:
        stats["removed"] = _remove_stale_local_files(dataset_id, seen_paths)

    logger.info(
        "Local sync %s complete: scanned=%d indexed=%d skipped=%d errors=%d removed=%d",
        dataset_id,
        stats["scanned"],
        stats["indexed"],
        stats["skipped"],
        stats["errors"],
        stats["removed"],
    )
    return stats


def _remove_stale_local_files(dataset_id: str, seen_paths: set[str]) -> int:
    """Remove DB records for files under local_source_path that no longer exist on disk."""
    settings = _get_settings(dataset_id)
    root_str = str(settings.get("local_source_path") or "").strip()
    if not root_str:
        return 0
    try:
        root = normalize_local_root(root_str)
    except ValueError:
        return 0

    removed = 0
    with db_connection_lock():
        conn = get_db()
        rows = conn.execute(
            "SELECT file_id, path FROM evoflow_kb_source_file WHERE dataset_id = ?",
            (dataset_id,),
        ).fetchall()

    root_prefix = str(root.resolve())
    from evoflow.knowledge.service import delete_file

    for row in rows:
        path = str(row["path"] or "")
        if not path.startswith(root_prefix):
            continue
        if path in seen_paths:
            continue
        try:
            delete_file(dataset_id, str(row["file_id"]))
            removed += 1
        except Exception as e:
            logger.warning("Failed to remove stale file %s: %s", row["file_id"], e)
    return removed
