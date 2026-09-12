"""Paths for the owned knowledge base (local blob + sqlite)."""

from __future__ import annotations

import os
from pathlib import Path


def knowledge_root() -> Path:
    """``{EVOFLOW_KNOWLEDGE_ROOT}`` or ``{EVOFLOW_HOME|paths}/knowledge``."""
    override = (os.getenv("EVOFLOW_KNOWLEDGE_ROOT") or "").strip()
    if override:
        root = Path(override).expanduser().resolve()
    else:
        from evoflow.config.paths import get_paths

        root = (get_paths().base_dir / "knowledge").resolve()
    root.mkdir(parents=True, exist_ok=True)
    (root / "files").mkdir(parents=True, exist_ok=True)
    return root


def owned_db_path() -> Path:
    return knowledge_root() / "owned.sqlite"


def files_dir() -> Path:
    return knowledge_root() / "files"
