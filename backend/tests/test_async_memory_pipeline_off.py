"""Background memory work is gated per individual — no global asset switch."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from evoflow.assets.paths import EntityRef
from evoflow.assets.pipeline_config import MemoryAssetsConfig, entity_memory_enabled


@pytest.fixture()
def memory_master_on():
    from evoflow.config.memory_config import MemoryConfig, set_memory_config

    set_memory_config(MemoryConfig(enabled=True, injection_enabled=True))
    yield
    set_memory_config(MemoryConfig())


def test_no_global_enable_fields() -> None:
    """The old global switches are gone — memory on/off is per individual."""
    cfg = MemoryAssetsConfig()
    assert not hasattr(cfg, "generate_memories")
    assert not hasattr(cfg, "phase1_enabled")
    assert not hasattr(cfg, "phase2_enabled")
    assert not hasattr(cfg, "startup_phase2_scan")


def test_employee_switch_follows_role_config(monkeypatch) -> None:
    import evoflow.proactive.repositories as repos

    monkeypatch.setattr(
        repos.ProactiveRepository,
        "get_role",
        staticmethod(lambda code: SimpleNamespace(config={"memory_enabled": False})),
    )
    assert entity_memory_enabled(EntityRef("employee", "emp-a")) is False

    monkeypatch.setattr(
        repos.ProactiveRepository,
        "get_role",
        staticmethod(lambda code: SimpleNamespace(config={"memory_enabled": True})),
    )
    assert entity_memory_enabled(EntityRef("employee", "emp-b")) is True


def test_employee_legacy_inject_flags_map_to_off(monkeypatch) -> None:
    import evoflow.proactive.repositories as repos

    monkeypatch.setattr(
        repos.ProactiveRepository,
        "get_role",
        staticmethod(lambda code: SimpleNamespace(config={"inject_memory": False})),
    )
    assert entity_memory_enabled(EntityRef("employee", "emp-legacy")) is False


def test_missing_role_defaults_on(monkeypatch) -> None:
    import evoflow.proactive.repositories as repos

    monkeypatch.setattr(repos.ProactiveRepository, "get_role", staticmethod(lambda code: None))
    assert entity_memory_enabled(EntityRef("employee", "ghost")) is True


def test_user_bucket_follows_panel_switch(monkeypatch) -> None:
    import evoflow.persistence.panel_settings as panel

    monkeypatch.setattr(panel, "get_panel_settings", lambda pid=None: {"memoryEnabledDefault": False})
    assert entity_memory_enabled(EntityRef("user", "admin")) is False

    monkeypatch.setattr(panel, "get_panel_settings", lambda pid=None: {"memoryEnabledDefault": True})
    assert entity_memory_enabled(EntityRef("user", "admin")) is True


def test_phase1_skips_when_entity_memory_off(monkeypatch, tmp_path, memory_master_on) -> None:
    monkeypatch.setenv("EVOFLOW_HOME", str(tmp_path))
    from evoflow.config.paths import reset_paths_cache

    reset_paths_cache()
    import evoflow.assets.phase1 as phase1

    monkeypatch.setattr(phase1, "min_rollout_chars", lambda: 0)
    monkeypatch.setattr(
        "evoflow.assets.pipeline_config.entity_memory_enabled",
        lambda ent: False,
    )

    result = phase1.run_phase1_extract(
        messages=[],
        thread_id="t-gate",
        entity=EntityRef("user", "gate-test"),
    )
    assert result.get("skipped") == "memory_disabled_by_entity"


def test_phase2_skips_when_entity_memory_off(monkeypatch, tmp_path, memory_master_on) -> None:
    monkeypatch.setenv("EVOFLOW_HOME", str(tmp_path))
    from evoflow.config.paths import reset_paths_cache

    reset_paths_cache()
    import evoflow.assets.phase2 as phase2

    monkeypatch.setattr(
        "evoflow.assets.pipeline_config.entity_memory_enabled",
        lambda ent: False,
    )

    result = phase2.run_phase2_consolidate(entity=EntityRef("user", "gate-test-2"))
    assert result.get("skipped") == "memory_disabled_by_entity"
