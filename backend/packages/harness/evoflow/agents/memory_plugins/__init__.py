"""External memory plugins (Hermes-style): optional backend + prefetch fence.

Configure with ``memory.external_provider`` in config.yaml (e.g. ``echo`` for the
in-process demo). Built-in ``memory.json`` / LLM summarization is unchanged; this
layer adds sync + injectable recall alongside it.

See ``docs/external-memory-plugins.md`` in the EvoFlow repo root.
"""

from evoflow.agents.memory_plugins.base import ExternalMemoryProvider
from evoflow.agents.memory_plugins.manager import (
    ExternalMemoryPluginManager,
    build_memory_context_fence,
    get_external_memory_plugin_manager,
    reset_external_memory_plugin_manager_for_tests,
    sanitize_memory_context_fence,
)
from evoflow.agents.memory_plugins.registry import load_external_memory_provider

__all__ = [
    "ExternalMemoryProvider",
    "ExternalMemoryPluginManager",
    "build_memory_context_fence",
    "get_external_memory_plugin_manager",
    "load_external_memory_provider",
    "reset_external_memory_plugin_manager_for_tests",
    "sanitize_memory_context_fence",
]
