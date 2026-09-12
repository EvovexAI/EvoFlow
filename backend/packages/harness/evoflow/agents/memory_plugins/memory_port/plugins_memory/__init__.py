"""External memory provider discovery under EvoFlow (``memory_port.plugins_memory``)."""

from __future__ import annotations

import importlib.util
import logging
import sys
from pathlib import Path
from typing import TYPE_CHECKING

from evoflow.agents.memory_plugins.memory_port.shims import install_memory_port_shims

if TYPE_CHECKING:
    from evoflow.agents.memory_plugins.memory_port.memory_provider import MemoryProvider

logger = logging.getLogger(__name__)

_PLUGINS_ROOT = Path(__file__).resolve().parent
_PKG = __name__


def discover_memory_providers() -> list[tuple[str, str, bool]]:
    """Return ``(name, description, is_available)`` for each plugin subdirectory."""
    install_memory_port_shims()
    results: list[tuple[str, str, bool]] = []
    if not _PLUGINS_ROOT.is_dir():
        return results

    for child in sorted(_PLUGINS_ROOT.iterdir()):
        if not child.is_dir() or child.name.startswith(("_", ".")):
            continue
        if not (child / "__init__.py").exists():
            continue

        desc = ""
        yaml_file = child / "plugin.yaml"
        if yaml_file.exists():
            try:
                import yaml

                with open(yaml_file, encoding="utf-8") as f:
                    meta = yaml.safe_load(f) or {}
                desc = meta.get("description", "")
            except Exception:
                pass

        available = True
        try:
            provider = _load_provider_from_dir(child)
            if provider:
                available = provider.is_available()
            else:
                available = False
        except Exception:
            available = False

        results.append((child.name, desc, available))

    return results


def load_memory_provider(name: str) -> MemoryProvider | None:
    """Load a ``MemoryProvider`` by plugin id (e.g. ``mem0``, ``honcho``)."""
    install_memory_port_shims()
    provider_dir = _PLUGINS_ROOT / name
    if not provider_dir.is_dir():
        logger.debug("Memory provider %r not found under %s", name, _PLUGINS_ROOT)
        return None
    try:
        provider = _load_provider_from_dir(provider_dir)
        if provider:
            return provider
        logger.warning("Memory provider %r loaded but no instance returned", name)
        return None
    except Exception as e:
        logger.warning("Failed to load memory provider %r: %s", name, e)
        return None


def _ensure_parent_package() -> None:
    """Guarantee ``_PKG`` is a package with ``__path__`` for dynamic submodules."""
    if _PKG not in sys.modules:
        import types

        root = types.ModuleType(_PKG)
        root.__path__ = [str(_PLUGINS_ROOT)]
        sys.modules[_PKG] = root
    else:
        mod = sys.modules[_PKG]
        if not getattr(mod, "__path__", None):
            mod.__path__ = [str(_PLUGINS_ROOT)]


def _load_provider_from_dir(provider_dir: Path) -> MemoryProvider | None:
    _ensure_parent_package()
    name = provider_dir.name
    module_name = f"{_PKG}.{name}"
    init_file = provider_dir / "__init__.py"
    if not init_file.exists():
        return None

    if module_name in sys.modules:
        mod = sys.modules[module_name]
    else:
        # Load only ``__init__.py`` so sibling modules (e.g. ``holographic.py`` as ``.holographic``)
        # resolve after the package exists; eager preloading breaks ``from . import holographic``.
        spec = importlib.util.spec_from_file_location(
            module_name,
            str(init_file),
            submodule_search_locations=[str(provider_dir)],
        )
        if not spec or not spec.loader:
            return None
        mod = importlib.util.module_from_spec(spec)
        sys.modules[module_name] = mod
        try:
            spec.loader.exec_module(mod)
        except Exception as e:
            logger.debug("exec_module failed for %s: %s", module_name, e)
            sys.modules.pop(module_name, None)
            return None

    if hasattr(mod, "register"):
        collector = _ProviderCollector()
        try:
            mod.register(collector)
            if collector.provider:
                return collector.provider
        except Exception as e:
            logger.debug("register() failed for %s: %s", name, e)

    from evoflow.agents.memory_plugins.memory_port.memory_provider import MemoryProvider as MP

    for attr_name in dir(mod):
        attr = getattr(mod, attr_name, None)
        if isinstance(attr, type) and issubclass(attr, MP) and attr is not MP:
            try:
                return attr()
            except Exception:
                pass

    return None


class _ProviderCollector:
    def __init__(self) -> None:
        self.provider: object | None = None

    def register_memory_provider(self, provider: object) -> None:
        self.provider = provider

    def register_tool(self, *args: object, **kwargs: object) -> None:
        pass

    def register_hook(self, *args: object, **kwargs: object) -> None:
        pass

    def register_cli_command(self, *args: object, **kwargs: object) -> None:
        pass


def discover_plugin_cli_commands() -> list[dict]:
    """EvoFlow has no Hermes CLI; reserved for future use."""
    return []
