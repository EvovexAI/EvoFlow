"""Department avatar presets (built-in cutouts for org departments).

Stored under ``assets/dept_avatars/{id}.png`` with ``manifest.json``.
Departments reference them via the plain preset id stored in
``evoflow_departments.avatar`` (no per-department file copy), e.g. ``"studio"``.

Structurally mirrors :mod:`evoflow.config.avatar_presets` (agent gallery) so the
two galleries behave identically: manifest cached with ``lru_cache(maxsize=1)``,
same id regex, same ``list/path/pick-random/content-type/clear-cache`` surface.

Cache note: the manifest is read once per process. After dropping in a new
preset PNG and adding its row to ``manifest.json``, call
:func:`clear_preset_cache` (or restart the Gateway) for it to appear.
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

_PRESETS_DIR = Path(__file__).resolve().parent.parent / "assets" / "dept_avatars"
_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,62}$")


def presets_dir() -> Path:
    return _PRESETS_DIR


def normalize_preset_id(raw: str) -> str | None:
    """Lowercase + validate a department preset id (same rule as agent presets)."""
    code = str(raw or "").strip().lower()
    if not code or not _ID_RE.match(code):
        return None
    return code


def parse_dept_avatar(raw: str | None) -> str | None:
    """Return a known preset id when *raw* resolves to a shipped dept cutout.

    Accepts both the bare id (``"studio"``, what we store in the DB) and the
    ``preset:<id>`` form for symmetry with agent avatars.
    """
    text = str(raw or "").strip()
    if not text:
        return None
    if text.lower().startswith("preset:"):
        text = text.split(":", 1)[1]
    pid = normalize_preset_id(text)
    if not pid or preset_path(pid) is None:
        return None
    return pid


def is_valid_preset_id(raw: str | None) -> bool:
    """True when *raw* is a resolvable department preset id."""
    return parse_dept_avatar(raw) is not None


@lru_cache(maxsize=1)
def _load_manifest() -> list[dict[str, Any]]:
    path = _PRESETS_DIR / "manifest.json"
    if not path.is_file():
        return _discover_from_files()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        logger.warning("failed to read dept avatar manifest %s", path, exc_info=True)
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


def pick_random_preset_id() -> str | None:
    """Random preset id (not ``preset:``-prefixed) or None when the gallery is empty.

    Used when creating a department without an explicit avatar.
    """
    rows = list_presets()
    if not rows:
        return None
    pid = str(random.choice(rows).get("id") or "").strip()
    if not pid or preset_path(pid) is None:
        return None
    return pid


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
    """Drop the cached manifest (call after adding presets without a restart)."""
    _load_manifest.cache_clear()
