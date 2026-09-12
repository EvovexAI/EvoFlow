"""EvoFlow stand-in for Hermes ``HERMES_HOME`` / ``get_hermes_home()``."""

from __future__ import annotations

from pathlib import Path


def get_hermes_home() -> Path:
    """Profile data root for ported memory plugins (config JSON, local DBs).

    Uses ``{EvoFlow base_dir}/memory-providers`` (``base_dir`` is already the EvoFlow
    data root, e.g. ``~/.evoflow``).
    """
    from evoflow.config.paths import get_paths

    p = get_paths().base_dir / "memory-providers"
    p.mkdir(parents=True, exist_ok=True)
    return p


def display_hermes_home() -> str:
    return str(get_hermes_home())
