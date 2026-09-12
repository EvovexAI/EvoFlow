"""Asset-hub vs legacy memory injection mode (Tier 0)."""

from __future__ import annotations

import os

# Canonical mode ids
MODE_ASSET = "asset"
MODE_LEGACY = "legacy"

_ASSET_ALIASES = frozenset(
    {
        MODE_ASSET,
        "asset-hub",
        "assethub",
        "native",
        "runtime",
        # legacy product name (accepted for config compatibility)
        "codex",
    }
)
_LEGACY_ALIASES = frozenset({"legacy", "old", "sqlite", "dual", "both"})


def resolve_memory_injection_mode() -> str:
    """``asset`` (default): read_path + standing only. ``legacy``: SQLite ``<memory>`` + catalog."""
    try:
        from evoflow.config.memory_config import get_memory_config

        cfg = get_memory_config()
        configured = str(getattr(cfg, "injection_mode", "") or "").strip().lower()
    except Exception:
        configured = ""
    raw = str(configured or os.getenv("EVOFLOW_MEMORY_INJECTION") or MODE_ASSET).strip().lower()
    if raw in _LEGACY_ALIASES:
        return MODE_LEGACY
    if raw in _ASSET_ALIASES or not raw:
        return MODE_ASSET
    return MODE_ASSET


def asset_hub_memory_injection() -> bool:
    return resolve_memory_injection_mode() == MODE_ASSET
