"""Session ``memory_enabled`` must override global memory.injection_enabled."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from evoflow.agents.lead_agent.runtime_context import LeadAgentRuntimeContext
from evoflow.agents.memory.runtime_overrides import (
    effective_memory_injection_enabled,
    effective_memory_updates_enabled,
)
from evoflow.config.memory_config import MemoryConfig, set_memory_config


@pytest.fixture(autouse=True)
def _memory_on() -> None:
    set_memory_config(MemoryConfig(enabled=True, injection_enabled=True))
    yield
    set_memory_config(MemoryConfig())


def test_session_memory_disabled_overrides_global_when_context_is_dataclass() -> None:
    rt = SimpleNamespace(context=LeadAgentRuntimeContext(memory_enabled=False))
    assert effective_memory_injection_enabled(rt) is False
    assert effective_memory_updates_enabled(rt) is False


def test_session_memory_enabled_uses_global_injection_default() -> None:
    rt = SimpleNamespace(context=LeadAgentRuntimeContext(memory_enabled=True))
    assert effective_memory_injection_enabled(rt) is True


def test_session_memory_disabled_when_context_is_dict() -> None:
    rt = SimpleNamespace(context={"memory_enabled": False})
    assert effective_memory_injection_enabled(rt) is False


def test_missing_session_flag_falls_back_to_global_injection() -> None:
    rt = SimpleNamespace(context=LeadAgentRuntimeContext(thread_id="t1"))
    assert effective_memory_injection_enabled(rt) is True
