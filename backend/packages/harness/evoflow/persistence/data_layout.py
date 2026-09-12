"""Migrate legacy flat SQLite files into ``{base_dir}/data/{app,observability,checkpoints}/``."""

from __future__ import annotations

import logging
import shutil
from dataclasses import dataclass, field
from pathlib import Path

from evoflow.config.data_paths import (
    LEGACY_APP_DB,
    LEGACY_CHECKPOINTS_DB,
    LEGACY_OBS_DB,
    app_db_dir,
    app_db_path,
    checkpoints_db_dir,
    checkpoints_db_path,
    data_root,
    logs_dir,
    observability_db_dir,
    observability_db_path,
)

logger = logging.getLogger(__name__)

_SQLITE_SIDE_SUFFIXES = ("-wal", "-shm", "-journal")


@dataclass
class DataLayoutMigrationResult:
    moved: list[str] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)


def _relocate_file(src: Path, dest: Path) -> bool:
    """Move or copy ``src`` to ``dest``; return True when ``dest`` is populated."""
    if dest.exists():
        return False
    dest.parent.mkdir(parents=True, exist_ok=True)
    try:
        shutil.move(str(src), str(dest))
        return True
    except OSError as exc:
        logger.warning("data layout: move failed (%s); copying instead: %s -> %s", exc, src, dest)
        shutil.copy2(str(src), str(dest))
        return True


def _remove_if_unused(path: Path, *, counterpart: Path) -> None:
    if not path.is_file() or not counterpart.is_file():
        return
    try:
        if path.stat().st_size == counterpart.stat().st_size:
            path.unlink()
    except OSError:
        logger.debug("data layout: could not remove legacy file %s", path, exc_info=True)


def _move_sqlite_bundle(src: Path, dest: Path) -> bool:
    """Relocate main db file and WAL/SHM sidecars; skip if dest already exists."""
    if not src.is_file():
        return False
    if dest.exists():
        logger.debug("data layout: destination exists, skip move %s -> %s", src, dest)
        return False
    if not _relocate_file(src, dest):
        return False
    for suffix in _SQLITE_SIDE_SUFFIXES:
        side = Path(str(src) + suffix)
        dest_side = Path(str(dest) + suffix)
        if side.is_file():
            try:
                if dest_side.exists():
                    continue
                shutil.move(str(side), str(dest_side))
            except OSError:
                shutil.copy2(str(side), str(dest_side))
    _remove_if_unused(src, counterpart=dest)
    return True


def ensure_data_layout(base_dir: Path) -> DataLayoutMigrationResult:
    """Create ``data/`` subdirs and move legacy root-level ``*.db`` files once."""
    result = DataLayoutMigrationResult()
    base = base_dir.resolve()
    root = data_root(base)
    for d in (app_db_dir(base), observability_db_dir(base), checkpoints_db_dir(base), logs_dir(base)):
        d.mkdir(parents=True, exist_ok=True)

    moves: list[tuple[Path, Path, str]] = [
        (base / LEGACY_APP_DB, app_db_path(base), LEGACY_APP_DB),
        (base / LEGACY_OBS_DB, observability_db_path(base), LEGACY_OBS_DB),
        (base / LEGACY_CHECKPOINTS_DB, checkpoints_db_path(base), LEGACY_CHECKPOINTS_DB),
    ]
    for src, dest, label in moves:
        if _move_sqlite_bundle(src, dest):
            result.moved.append(label)
            logger.info("data layout: moved %s -> %s", src, dest)
        elif src.is_file() and dest.is_file():
            _remove_if_unused(src, counterpart=dest)
            result.skipped.append(f"{label}:both_exist")
        elif dest.is_file():
            _remove_if_unused(src, counterpart=dest)
            result.skipped.append(f"{label}:already_canonical")

    if not root.exists():
        root.mkdir(parents=True, exist_ok=True)
    return result
