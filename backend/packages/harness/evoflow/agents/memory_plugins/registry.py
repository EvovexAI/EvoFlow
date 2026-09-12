"""Load external memory provider by config id."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from evoflow.agents.memory_plugins.base import ExternalMemoryProvider

logger = logging.getLogger(__name__)


def load_external_memory_provider(provider_id: str) -> ExternalMemoryProvider | None:
    """Return a provider instance or None if id is empty/unknown."""
    name = (provider_id or "").strip().lower()
    if not name:
        return None
    if name == "echo":
        from evoflow.agents.memory_plugins.providers.echo import EchoMemoryProvider

        p = EchoMemoryProvider()
        if not p.is_available():
            return None
        return p
    logger.warning("Unknown memory.external_provider %r — ignoring", provider_id)
    return None
