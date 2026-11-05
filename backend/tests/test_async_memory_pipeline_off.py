"""Async Phase1/2 memory pipeline is off by default."""

from __future__ import annotations

from evoflow.assets.pipeline_config import (
    MemoryAssetsConfig,
    asset_async_memory_pipeline_enabled,
    asset_phase1_enabled,
    asset_phase2_enabled,
    asset_startup_phase2_enabled,
)


def test_defaults_disable_async_pipeline() -> None:
    cfg = MemoryAssetsConfig()
    assert cfg.generate_memories is False
    assert cfg.phase1_enabled is False
    assert cfg.phase2_enabled is False
    assert cfg.startup_phase2_scan is False


def test_helpers_report_off_without_env(monkeypatch) -> None:
    monkeypatch.delenv("EVOFLOW_ASSET_PHASE1", raising=False)
    monkeypatch.delenv("EVOFLOW_ASSET_PHASE2", raising=False)
    monkeypatch.delenv("EVOFLOW_ASSET_STARTUP_PHASE2", raising=False)
    monkeypatch.setattr(
        "evoflow.assets.pipeline_config.get_assets_config",
        lambda: MemoryAssetsConfig(),
    )
    assert asset_phase1_enabled() is False
    assert asset_phase2_enabled() is False
    assert asset_startup_phase2_enabled() is False
    assert asset_async_memory_pipeline_enabled() is False
