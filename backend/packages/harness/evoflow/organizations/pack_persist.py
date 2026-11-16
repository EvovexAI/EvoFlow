"""Persist ephemeral org-pack extracts into a durable home directory.

Zip / zip_url / market installs unpack under ``%TEMP%`` and used to register
``link: true`` paths against that temp tree — then ``LoadedPack.cleanup()``
deleted it. Colleagues saw "installed" apps that could not open.

Durable root: ``<config_dir>/org-packs/<pack_id>/``.
"""

from __future__ import annotations

import logging
import shutil
from pathlib import Path
from typing import Any

from evoflow.organizations.manifest import LoadedPack, load_pack_manifest
from evoflow.organizations.pack_zip_ignore import DEFAULT_SKIP_DIR_NAMES

logger = logging.getLogger(__name__)

_PORTABLE_SOURCE_TYPES = frozenset({"zip_url", "zip_path", "market_path"})


def org_packs_root() -> Path:
    from evoflow.admin.ui_extensions_registry import config_dir

    root = config_dir() / "org-packs"
    root.mkdir(parents=True, exist_ok=True)
    return root


def source_requires_portable(source: dict[str, Any] | None, options: dict[str, Any] | None = None) -> bool:
    """True when install must copy (not folder-link) into durable roots."""
    opts = options or {}
    if bool(opts.get("force_portable")):
        return True
    src = source or {}
    st = str(src.get("type") or "").strip().lower()
    if st in _PORTABLE_SOURCE_TYPES:
        return True
    if str(src.get("url") or "").strip():
        return True
    return False


def pack_needs_persist(pack: LoadedPack) -> bool:
    if pack.cleanup_dirs:
        return True
    try:
        root = pack.root.resolve()
    except OSError:
        return True
    # Already under org-packs → durable
    try:
        root.relative_to(org_packs_root().resolve())
        return False
    except ValueError:
        pass
    # Common temp extract prefixes
    name = root.name.lower()
    if name.startswith("evoflow_org_") or name.startswith("evoflow_org_zip"):
        return True
    import tempfile

    try:
        tmp_root = Path(tempfile.gettempdir()).resolve()
        root.relative_to(tmp_root)
        return True
    except ValueError:
        return False


def _ignore_bloat(dirpath: str, names: list[str]) -> list[str]:
    return [n for n in names if n in DEFAULT_SKIP_DIR_NAMES]


def persist_pack_tree(pack: LoadedPack) -> LoadedPack:
    """Copy pack tree to ``org-packs/<id>/``, cleanup temps, return durable LoadedPack."""
    pid = pack.pack_id
    if not pid:
        raise ValueError("pack id required to persist")
    dest = org_packs_root() / pid
    if dest.exists():
        shutil.rmtree(dest, ignore_errors=True)
    logger.info("persisting org pack %s → %s", pid, dest)
    shutil.copytree(pack.root, dest, ignore=_ignore_bloat)
    # Drop temp extract dirs; do not touch dest
    pack.cleanup()
    return load_pack_manifest(dest)


def clear_extension_service_link(ext_dir: Path) -> None:
    """After copy install, ensure manifest does not claim folder-link."""
    import json

    man = ext_dir / "evoflow.extension.json"
    if not man.is_file():
        return
    try:
        data = json.loads(man.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError):
        return
    if not isinstance(data, dict):
        return
    svc = data.get("service")
    if not isinstance(svc, dict):
        return
    if not svc.get("link"):
        return
    svc["link"] = False
    data["service"] = svc
    man.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


__all__ = [
    "org_packs_root",
    "source_requires_portable",
    "pack_needs_persist",
    "persist_pack_tree",
    "clear_extension_service_link",
]
