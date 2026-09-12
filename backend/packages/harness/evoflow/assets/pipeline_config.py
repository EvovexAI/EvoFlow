"""runtime-aligned Asset Hub pipeline configuration (single source of truth)."""

from __future__ import annotations

import os

from pydantic import BaseModel, Field


class MemoryAssetsConfig(BaseModel):
    """Mirrors runtime ``MemoriesConfig`` knobs for Phase1/2 + forgetting."""

    generate_memories: bool = Field(
        default=True,
        description="Master switch for Phase1/2 asset memory pipeline.",
    )
    phase1_enabled: bool = Field(default=True, description="Session-idle rollout extract.")
    phase2_enabled: bool = Field(default=True, description="Inbox → standing / MEMORY / craft.")
    startup_phase2_scan: bool = Field(default=True, description="Gateway startup inbox sweep.")
    legacy_updater_enabled: bool = Field(
        default=False,
        description="SQLite MemoryUpdater (mem_*) on debounce; off by default in asset-hub memory mode.",
    )
    max_unused_days: int = Field(default=30, ge=1, le=3650)
    max_inbox_for_consolidation: int = Field(default=256, ge=1, le=2048)
    min_rollout_chars: int = Field(default=80, ge=0, le=10_000)


def get_assets_config() -> MemoryAssetsConfig:
    try:
        from evoflow.config.memory_config import get_memory_config

        assets = getattr(get_memory_config(), "assets", None)
        if isinstance(assets, MemoryAssetsConfig):
            return assets
    except Exception:
        pass
    return MemoryAssetsConfig()


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None or not str(raw).strip():
        return default
    return str(raw).strip().lower() not in {"0", "false", "no", "off"}


def asset_phase1_enabled() -> bool:
    cfg = get_assets_config()
    if not cfg.generate_memories or not cfg.phase1_enabled:
        return False
    return _env_bool("EVOFLOW_ASSET_PHASE1", True)


def asset_phase2_enabled() -> bool:
    cfg = get_assets_config()
    if not cfg.generate_memories or not cfg.phase2_enabled:
        return False
    return _env_bool("EVOFLOW_ASSET_PHASE2", True)


def asset_startup_phase2_enabled() -> bool:
    cfg = get_assets_config()
    if not cfg.generate_memories or not cfg.startup_phase2_scan:
        return False
    return _env_bool("EVOFLOW_ASSET_STARTUP_PHASE2", True)


def max_unused_days() -> int:
    cfg = get_assets_config()
    raw = str(os.getenv("EVOFLOW_ASSET_MAX_UNUSED_DAYS", "") or "").strip()
    if raw:
        try:
            return max(1, int(raw))
        except ValueError:
            pass
    return max(1, int(cfg.max_unused_days))


def max_inbox_for_consolidation() -> int:
    return max(1, int(get_assets_config().max_inbox_for_consolidation))


def min_rollout_chars() -> int:
    return max(0, int(get_assets_config().min_rollout_chars))


def should_run_legacy_memory_updater() -> bool:
    """asset-hub memory mode: only Phase1/2 + ad-hoc notes; skip parallel SQLite MemoryUpdater."""
    try:
        from evoflow.config.memory_config import get_memory_config

        if not get_memory_config().enabled:
            return False
    except Exception:
        return False
    from evoflow.assets.memory_injection import asset_hub_memory_injection

    cfg = get_assets_config()
    if asset_hub_memory_injection():
        return bool(cfg.legacy_updater_enabled)
    return True
