"""Per-KB storage layout: one knowledge base = one directory with its own index.

Layout (mirrors ``evoflow.code_index`` which keeps ``<workspace>/.evoflow/code_index/``):

    <kb_root>/<kb-folder>/
    ├── <content files>              # link mode: user's originals live here
    └── .evoflow/kb/
        ├── index.db                 # documents/chunks/embeddings/FTS/wiki
        ├── index.db-wal
        ├── blobs/{doc_id}/          # copy mode only (uploaded temp files)
        ├── assets/{doc_id}/         # images extracted from documents
        └── kb.json                  # KB metadata (id/name/embedding/schema version)

Central ``owned.sqlite`` keeps only what is NOT owned by a single KB:
the ``kb_bases`` registry, the job queue, the activity log, and agent memory.

Resolution order for a KB directory:

1. ``kb_bases.storage_dir`` (explicit, set at create/migrate time)
2. ``{EVOFLOW_KB_ROOT}/<kb_id>``   (when a root is configured)
3. ``{knowledge_root}/kbs/<kb_id>`` (fallback, always writable)
"""

from __future__ import annotations

import json
import logging
import os
import re
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

# Relative sub-path inside a KB directory that holds all derived data.
KB_META_REL_DIR = Path(".evoflow") / "kb"
INDEX_DB_NAME = "index.db"
META_NAME = "kb.json"

# KB ids are generated as ``kb_<hex>``; keep the folder name filesystem-safe.
_SAFE_ID_RE = re.compile(r"[^A-Za-z0-9_\-]")


def safe_kb_dirname(kb_id: str) -> str:
    """Return a filesystem-safe folder name for a KB id."""
    kid = str(kb_id or "").strip()
    if not kid:
        raise ValueError("kb_id is required")
    safe = _SAFE_ID_RE.sub("_", kid)
    if safe in {"", ".", ".."}:
        raise ValueError(f"unsafe kb_id: {kb_id!r}")
    return safe


def kb_root() -> Path | None:
    """Configured root that holds all KB directories, or ``None``.

    ``EVOFLOW_KB_ROOT`` wins; otherwise ``config.yaml`` ``paths.kb_root``.
    """
    override = (os.getenv("EVOFLOW_KB_ROOT") or "").strip()
    if override:
        return Path(override).expanduser().resolve()

    try:
        from evoflow.config.app_config import get_app_config

        cfg = get_app_config()
        extra = getattr(cfg, "model_extra", None) or {}
        paths_cfg = extra.get("paths") if isinstance(extra, dict) else None
        if isinstance(paths_cfg, dict):
            raw = paths_cfg.get("kb_root") or paths_cfg.get("kbRoot")
            if isinstance(raw, str) and raw.strip():
                return Path(raw.strip()).expanduser().resolve()
    except Exception:
        logger.debug("kb_root config lookup skipped", exc_info=True)
    return None


def default_kb_dir(kb_id: str) -> Path:
    """Directory for a KB when no explicit ``storage_dir`` is set.

    Uses ``{EVOFLOW_KB_ROOT}/<kb_id>`` when configured, else the app data dir
    (``{knowledge_root}/kbs/<kb_id>``) which is always writable.
    """
    root = kb_root()
    if root is not None:
        return root / safe_kb_dirname(kb_id)
    from evoflow.knowledge.owned.paths import knowledge_root

    return knowledge_root() / "kbs" / safe_kb_dirname(kb_id)


def index_dir(kb_dir: str | Path) -> Path:
    """``<kb_dir>/.evoflow/kb`` — the derived-data directory."""
    return Path(kb_dir).expanduser() / KB_META_REL_DIR


def index_db_path(kb_dir: str | Path) -> Path:
    return index_dir(kb_dir) / INDEX_DB_NAME


def blobs_dir(kb_dir: str | Path) -> Path:
    return index_dir(kb_dir) / "blobs"


def assets_dir(kb_dir: str | Path) -> Path:
    return index_dir(kb_dir) / "assets"


def meta_path(kb_dir: str | Path) -> Path:
    return index_dir(kb_dir) / META_NAME


def is_dir_writable(path: str | Path) -> bool:
    """Best-effort writability probe (creates the dir when missing)."""
    p = Path(path).expanduser()
    try:
        p.mkdir(parents=True, exist_ok=True)
        probe = p / ".evoflow_write_probe"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink()
        return True
    except OSError:
        return False


def ensure_kb_layout(kb_dir: str | Path) -> Path:
    """Create ``<kb_dir>/.evoflow/kb/{blobs,assets}`` and return the index dir."""
    d = Path(kb_dir).expanduser()
    idx = index_dir(d)
    for sub in (idx, blobs_dir(d), assets_dir(d)):
        sub.mkdir(parents=True, exist_ok=True)
    return idx


def write_kb_meta(kb_dir: str | Path, payload: dict[str, Any]) -> None:
    """Write ``kb.json`` atomically (tmp + replace)."""
    idx = ensure_kb_layout(kb_dir)
    dest = idx / META_NAME
    tmp = idx / f".{META_NAME}.tmp"
    tmp.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    tmp.replace(dest)


def read_kb_meta(kb_dir: str | Path) -> dict[str, Any] | None:
    p = meta_path(kb_dir)
    if not p.is_file():
        return None
    try:
        data = json.loads(p.read_text(encoding="utf-8") or "{}")
    except Exception:
        logger.debug("kb.json unreadable at %s", p, exc_info=True)
        return None
    return data if isinstance(data, dict) else None


def resolve_kb_dir(kb_id: str, *, storage_dir: str | None = None) -> Path:
    """Resolve the directory for a KB.

    ``storage_dir`` (from ``kb_bases``) wins; otherwise the configured/default
    location is used. Never creates anything — call :func:`ensure_kb_layout`.
    """
    raw = str(storage_dir or "").strip()
    if raw:
        return Path(raw).expanduser().resolve()
    return default_kb_dir(kb_id)
