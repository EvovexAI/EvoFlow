"""Unified memory gate: resolve_memory_enabled + role legacy compat."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from evoflow.agents.memory.runtime_overrides import (
    resolve_memory_enabled,
    role_memory_enabled_from_config,
)
from evoflow.config.memory_config import MemoryConfig, set_memory_config
from evoflow.proactive.models import ProactiveRoleConfig


@pytest.fixture()
def memory_on():
    set_memory_config(MemoryConfig(enabled=True, injection_enabled=True))
    yield
    set_memory_config(MemoryConfig())


def test_role_memory_default_true():
    assert role_memory_enabled_from_config(None) is True
    assert role_memory_enabled_from_config({}) is True
    assert role_memory_enabled_from_config(ProactiveRoleConfig()) is True


def test_role_memory_explicit_and_legacy():
    assert role_memory_enabled_from_config({"memory_enabled": False}) is False
    assert role_memory_enabled_from_config({"memory_enabled": True}) is True
    assert role_memory_enabled_from_config({"inject_memory": False}) is False
    assert role_memory_enabled_from_config({"inject_assets": False}) is False
    assert role_memory_enabled_from_config({"inject_memory": True}) is True
    cfg = ProactiveRoleConfig(memory_enabled=False)
    assert role_memory_enabled_from_config(cfg) is False
    legacy = ProactiveRoleConfig.from_json({"inject_memory": False})
    assert legacy.memory_enabled is False
    assert role_memory_enabled_from_config(legacy) is False


def test_role_from_json_migrates_legacy_inject():
    cfg = ProactiveRoleConfig.from_json({"inject_memory": False})
    assert cfg.memory_enabled is False
    cfg2 = ProactiveRoleConfig.from_json({"memory_enabled": True, "inject_memory": False})
    assert cfg2.memory_enabled is True  # explicit wins


def test_resolve_global_off(memory_on):
    set_memory_config(MemoryConfig(enabled=False, injection_enabled=True))
    try:
        assert resolve_memory_enabled(runtime_ctx={"memory_enabled": True}) is False
    finally:
        set_memory_config(MemoryConfig(enabled=True, injection_enabled=True))


def test_resolve_runtime_pin(memory_on):
    assert resolve_memory_enabled(runtime_ctx={"memory_enabled": False}) is False
    assert resolve_memory_enabled(runtime_ctx={"memory_enabled": True}) is True
    rt = SimpleNamespace(context={"memory_enabled": False})
    assert resolve_memory_enabled(runtime=rt) is False


def test_resolve_session_override(memory_on, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(
        "evoflow.persistence.session_repositories.get_session_row_for_ui",
        lambda sk: {"memoryEnabled": False} if sk == "proactive:demo:chat:1" else {},
    )
    assert resolve_memory_enabled(session_key="proactive:demo:chat:1") is False
    monkeypatch.setattr(
        "evoflow.persistence.session_repositories.get_session_row_for_ui",
        lambda sk: {"memoryEnabled": True},
    )
    assert resolve_memory_enabled(session_key="proactive:demo:chat:1") is True


def test_resolve_inherits_role_when_session_null(memory_on, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(
        "evoflow.persistence.session_repositories.get_session_row_for_ui",
        lambda sk: {"memoryEnabled": None, "context": {}},
    )
    role = MagicMock()
    role.config = ProactiveRoleConfig(memory_enabled=False)
    monkeypatch.setattr(
        "evoflow.proactive.repositories.ProactiveRepository.get_role",
        lambda code: role if code == "demo" else None,
    )
    assert resolve_memory_enabled(session_key="proactive:demo:chat:x") is False

    role.config = ProactiveRoleConfig(memory_enabled=True)
    assert resolve_memory_enabled(session_key="proactive:demo:chat:x") is True


def test_resolve_default_true_for_main(memory_on, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(
        "evoflow.persistence.session_repositories.get_session_row_for_ui",
        lambda sk: {},
    )
    assert resolve_memory_enabled(session_key="agent:main:abc") is True
    assert resolve_memory_enabled() is True
