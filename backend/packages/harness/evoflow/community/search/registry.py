"""Search engine registry — register and discover available backends."""

from __future__ import annotations

import logging
from collections.abc import Callable

from .base import SearchEngine

logger = logging.getLogger(__name__)

# Registry: name -> factory function (returns SearchEngine or None)
_engine_factories: dict[str, Callable[[], SearchEngine | None]] = {}


def register(name: str, factory: Callable[[], SearchEngine | None]) -> None:
    """Register a search engine backend.

    Args:
        name: Unique engine identifier (e.g., 'baidu', 'ddg').
        factory: Callable that returns an instance, or None if unavailable.
    """
    _engine_factories[name] = factory
    logger.debug("Registered search engine: %s", name)


def get_available_engines() -> dict[str, SearchEngine]:
    """Instantiate and return all registered engines that are currently available.

    Engines whose factories return None are skipped.
    """
    available: dict[str, SearchEngine] = {}
    for name, factory in _engine_factories.items():
        try:
            engine = factory()
            if engine is not None:
                available[name] = engine
        except Exception as e:
            logger.warning("Failed to instantiate search engine '%s': %s", name, e)
    return available


def get_engine_names() -> list[str]:
    """Return all registered engine names."""
    return list(_engine_factories.keys())
