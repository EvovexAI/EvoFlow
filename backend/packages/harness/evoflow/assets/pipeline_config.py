"""Asset Hub memory pipeline tuning + the per-individual memory gate.

There is deliberately **no global on/off** for memory: every individual owns
their switch (``entity_memory_enabled``). These knobs only tune how much work
the pipeline does once an individual's memory is on.
"""

from __future__ import annotations

import os

from pydantic import BaseModel, Field

from evoflow.assets.paths import EntityRef


class MemoryAssetsConfig(BaseModel):
    """Tuning knobs for background memory work (Phase1/2 extract/consolidate).

    Enable/disable lives per individual — employee roles carry
    ``config_json.memory_enabled``; the user/main bucket follows the panel 记忆
    switch (``memoryEnabledDefault``). See ``entity_memory_enabled``.
    """

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


def entity_memory_enabled(entity: EntityRef) -> bool:
    """Per-individual memory switch — the only gate for background memory work.

    - employee → role ``config_json.memory_enabled`` (default True; legacy
      ``inject_memory``/``inject_assets`` false migrated to off)
    - user/main bucket → panel 记忆 switch ``memoryEnabledDefault`` (default True)
    - agent/workspace shells → True (data shells)

    Callers still honor the ``config.memory.enabled`` platform master.
    """
    try:
        e = entity.normalized()
    except Exception:
        return True
    if e.entity_type == "employee":
        try:
            from evoflow.agents.memory.runtime_overrides import role_memory_enabled_from_config
            from evoflow.proactive.repositories import ProactiveRepository

            role = ProactiveRepository.get_role(e.entity_id)
            if role is None:
                return True
            return role_memory_enabled_from_config(getattr(role, "config", None))
        except Exception:
            return True
    if e.entity_type == "user":
        try:
            from evoflow.persistence.panel_settings import get_panel_settings

            return bool(get_panel_settings(e.entity_id).get("memoryEnabledDefault", True))
        except Exception:
            return True
    return True


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
