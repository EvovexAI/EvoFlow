"""System default avatar presets (shared cutouts for new/custom agents).

Stored under ``assets/avatar_presets/{id}.png`` with ``manifest.json``.
Agents reference them via ``avatar: "preset:<id>"`` (no per-agent copy).
"""

from __future__ import annotations

import json
import logging
import random
import re
from functools import lru_cache
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

_PRESETS_DIR = Path(__file__).resolve().parent.parent / "assets" / "avatar_presets"
_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,62}$")
_LEGACY_IGNORED = frozenset({"mochi", "ink", "bolt"})


def presets_dir() -> Path:
    return _PRESETS_DIR


def normalize_preset_id(raw: str) -> str | None:
    code = str(raw or "").strip().lower()
    if not code or not _ID_RE.match(code):
        return None
    if code in _LEGACY_IGNORED:
        return None
    return code


def parse_preset_avatar(avatar: str | None) -> str | None:
    """Return preset id when ``avatar`` is ``preset:<id>`` and known; else None.

    Legacy ``preset:mochi|ink|bolt`` returns None (treated as unset by UI).
    """
    raw = str(avatar or "").strip()
    if not raw.lower().startswith("preset:"):
        return None
    pid = normalize_preset_id(raw.split(":", 1)[1])
    if not pid:
        return None
    if preset_path(pid) is None:
        return None
    return pid


def is_valid_preset_avatar(avatar: str | None) -> bool:
    """True when avatar is a resolvable ``preset:<id>`` (not legacy placeholders)."""
    return parse_preset_avatar(avatar) is not None


@lru_cache(maxsize=1)
def _load_manifest() -> list[dict[str, Any]]:
    path = _PRESETS_DIR / "manifest.json"
    if not path.is_file():
        return _discover_from_files()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        logger.warning("failed to read avatar preset manifest %s", path, exc_info=True)
        return _discover_from_files()
    if not isinstance(data, list):
        return _discover_from_files()
    out: list[dict[str, Any]] = []
    for row in data:
        if not isinstance(row, dict):
            continue
        pid = normalize_preset_id(str(row.get("id") or ""))
        if not pid or preset_path(pid) is None:
            continue
        label = str(row.get("label") or pid).strip() or pid
        sort = row.get("sort", 0)
        try:
            sort_n = int(sort)
        except (TypeError, ValueError):
            sort_n = 0
        out.append({"id": pid, "label": label, "sort": sort_n})
    out.sort(key=lambda r: (r["sort"], r["id"]))
    return out


def _discover_from_files() -> list[dict[str, Any]]:
    if not _PRESETS_DIR.is_dir():
        return []
    rows: list[dict[str, Any]] = []
    for p in sorted(_PRESETS_DIR.iterdir()):
        if not p.is_file() or p.suffix.lower() not in {".png", ".webp"}:
            continue
        pid = normalize_preset_id(p.stem)
        if not pid:
            continue
        rows.append({"id": pid, "label": pid, "sort": 0})
    return rows


def list_presets() -> list[dict[str, Any]]:
    """Return sorted preset metadata (id, label, sort)."""
    return list(_load_manifest())


def pick_random_preset_avatar() -> str | None:
    """Return a random ``preset:<id>`` from the gallery, or None if empty.

    Used when creating a custom agent without an explicit avatar so new agents
    get a cutout instead of a letter initial.
    """
    rows = list_presets()
    if not rows:
        return None
    pid = str(random.choice(rows).get("id") or "").strip()
    if not pid or preset_path(pid) is None:
        return None
    return f"preset:{pid}"


def preset_path(preset_id: str) -> Path | None:
    pid = normalize_preset_id(preset_id)
    if not pid:
        return None
    for ext in (".png", ".webp"):
        p = _PRESETS_DIR / f"{pid}{ext}"
        if p.is_file():
            return p
    return None


def content_type_for_preset(path: Path) -> str:
    if path.suffix.lower() == ".webp":
        return "image/webp"
    return "image/png"


def clear_preset_cache() -> None:
    _load_manifest.cache_clear()
