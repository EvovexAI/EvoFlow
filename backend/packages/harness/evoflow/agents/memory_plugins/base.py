"""Abstract base for external memory providers (Hermes-style plugin contract, EvoFlow port).

Plugins can mirror conversation turns to a remote or local backend and inject
retrieved context at the start of each model step. Only one provider is active
at a time (see ``ExternalMemoryPluginManager``).
"""

from __future__ import annotations

import logging
from abc import ABC, abstractmethod

logger = logging.getLogger(__name__)


class ExternalMemoryProvider(ABC):
    """Single external memory backend. Implement prefetch + sync_turn for full behavior."""

    @property
    @abstractmethod
    def name(self) -> str:
        """Short id, e.g. ``echo``."""

    def is_available(self) -> bool:
        """Return False to disable the provider without removing config."""
        return True

    def initialize(self, **kwargs) -> None:
        """Optional session/process init. kwargs may include thread_id, agent_name."""

    def system_prompt_block(self) -> str:
        """Static system text appended next to built-in ``<memory>`` injection."""
        return ""

    def prefetch(self, query: str, *, thread_id: str = "") -> str:
        """Return text to inject before the model sees the next turn (query = last user text)."""
        return ""

    def queue_prefetch(self, query: str, *, thread_id: str = "") -> None:
        """Optional: warm cache after a turn; default no-op."""

    def sync_turn(self, user_content: str, assistant_content: str, *, thread_id: str = "") -> None:
        """Persist a completed user/assistant pair (no tool traces)."""

    def shutdown(self) -> None:
        """Optional cleanup."""
