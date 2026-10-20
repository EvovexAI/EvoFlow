"""assets tool mounts with memory on and hides when memory is off."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from evoflow.agents.memory.runtime_overrides import (
    ASSETS_TOOL_NAME,
    effective_assets_tool_enabled,
    strip_memory_xml_blocks,
)
from evoflow.agents.middlewares.memory_runtime_control_middleware import MemoryRuntimeControlMiddleware
from evoflow.config.memory_config import MemoryConfig, set_memory_config


@pytest.fixture()
def memory_on(monkeypatch: pytest.MonkeyPatch):
    set_memory_config(MemoryConfig(enabled=True, injection_enabled=True))
    yield
    set_memory_config(MemoryConfig())


def _rt(*, memory_enabled: bool | None = None):
    ctx: dict = {}
    if memory_enabled is not None:
        ctx["memory_enabled"] = memory_enabled
    return SimpleNamespace(context=ctx)


def test_effective_assets_follows_memory_switch(memory_on):
    assert effective_assets_tool_enabled(_rt(memory_enabled=True)) is True
    assert effective_assets_tool_enabled(_rt()) is True  # default on
    assert effective_assets_tool_enabled(_rt(memory_enabled=False)) is False


def test_effective_assets_off_when_master_disabled(monkeypatch: pytest.MonkeyPatch):
    set_memory_config(MemoryConfig(enabled=False, injection_enabled=True))
    try:
        assert effective_assets_tool_enabled(_rt(memory_enabled=True)) is False
    finally:
        set_memory_config(MemoryConfig())


def test_strip_includes_memory_policy_and_entity_assets():
    text = (
        "<platform>x</platform>\n"
        "<memory_assets>unified policy and recall</memory_assets>\n"
        "<memory_policy>secret</memory_policy>\n"
        "<entity_assets>paths</entity_assets>\n"
        "<memory>user mem</memory>\n"
        "<person_memory>bio</person_memory>\n"
        "<person_craft>craft</person_craft>\n"
    )
    cleaned = strip_memory_xml_blocks(text)
    assert "unified policy" not in cleaned
    assert "secret" not in cleaned
    assert "paths" not in cleaned
    assert "user mem" not in cleaned
    assert "bio" not in cleaned
    assert "craft" not in cleaned
    assert "<platform>x</platform>" in cleaned


def test_middleware_hides_and_force_mounts_assets(memory_on):
    mw = MemoryRuntimeControlMiddleware()
    asset = MagicMock()
    asset.name = ASSETS_TOOL_NAME
    other = MagicMock()
    other.name = "bash"

    # Off → hide
    req_off = MagicMock()
    req_off.runtime = _rt(memory_enabled=False)
    req_off.tools = [other, asset]
    req_off.system_message = None
    req_off.override = lambda **kw: SimpleNamespace(tools=kw.get("tools", req_off.tools), system_message=kw.get("system_message"), runtime=req_off.runtime)
    patched_off = mw._patch_tools(req_off)
    names_off = {t.name for t in patched_off.tools}
    assert ASSETS_TOOL_NAME not in names_off
    assert "bash" in names_off

    # On + missing → force mount
    req_on = MagicMock()
    req_on.runtime = _rt(memory_enabled=True)
    req_on.tools = [other]
    req_on.system_message = None
    captured: dict = {}

    def _override(**kw):
        captured.update(kw)
        return SimpleNamespace(tools=kw.get("tools", req_on.tools), system_message=None, runtime=req_on.runtime)

    req_on.override = _override
    patched_on = mw._patch_tools(req_on)
    names_on = {getattr(t, "name", "") for t in patched_on.tools}
    assert ASSETS_TOOL_NAME in names_on


def test_assets_in_core_tool_names():
    from evoflow.agents.lead_agent.intent_tool_profile import CORE_TOOL_NAMES

    assert ASSETS_TOOL_NAME in CORE_TOOL_NAMES
