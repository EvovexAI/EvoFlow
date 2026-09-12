"""Install ``sys.modules`` aliases so Hermes-ported memory plugins import unchanged."""

from __future__ import annotations

import sys
import types


def install_memory_port_shims() -> None:
    from evoflow.agents.memory_plugins.memory_port.memory_provider import MemoryProvider
    from evoflow.agents.memory_plugins.memory_port.runtime import display_hermes_home, get_hermes_home
    from evoflow.agents.memory_plugins.memory_port.tool_error import tool_error as tool_error_fn

    hc = types.ModuleType("hermes_constants")
    hc.get_hermes_home = get_hermes_home
    hc.display_hermes_home = display_hermes_home
    sys.modules["hermes_constants"] = hc

    tools_pkg = types.ModuleType("tools")
    tools_pkg.__path__ = []
    tools_registry = types.ModuleType("tools.registry")
    tools_registry.tool_error = tool_error_fn
    tools_pkg.registry = tools_registry
    sys.modules["tools"] = tools_pkg
    sys.modules["tools.registry"] = tools_registry

    agent_pkg = types.ModuleType("agent")
    agent_pkg.__path__ = []
    agent_mp = types.ModuleType("agent.memory_provider")
    agent_mp.MemoryProvider = MemoryProvider
    agent_pkg.memory_provider = agent_mp
    sys.modules["agent"] = agent_pkg
    sys.modules["agent.memory_provider"] = agent_mp

    _install_hermes_cli_shim()


def _install_hermes_cli_shim() -> None:
    """Minimal ``hermes_cli`` API for ported plugins (Honcho, Hindsight) — no Hermes install."""
    cfg_mod = types.ModuleType("hermes_cli.config")

    def load_config() -> dict:
        return {}

    def save_config(*_a: object, **_k: object) -> None:
        return None

    cfg_mod.load_config = load_config
    cfg_mod.save_config = save_config

    prof_mod = types.ModuleType("hermes_cli.profiles")

    def get_active_profile_name() -> None:
        return None

    def list_profiles() -> list:
        return []

    prof_mod.get_active_profile_name = get_active_profile_name
    prof_mod.list_profiles = list_profiles

    ms_mod = types.ModuleType("hermes_cli.memory_setup")

    def cmd_setup_provider(*_a: object, **_k: object) -> None:
        return None

    def _curses_select(*_a: object, **_k: object) -> None:
        return None

    ms_mod.cmd_setup_provider = cmd_setup_provider
    ms_mod._curses_select = _curses_select

    root = types.ModuleType("hermes_cli")
    root.config = cfg_mod
    root.profiles = prof_mod
    root.memory_setup = ms_mod

    sys.modules["hermes_cli"] = root
    sys.modules["hermes_cli.config"] = cfg_mod
    sys.modules["hermes_cli.profiles"] = prof_mod
    sys.modules["hermes_cli.memory_setup"] = ms_mod
