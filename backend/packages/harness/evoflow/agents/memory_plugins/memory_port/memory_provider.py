"""Pluggable memory provider ABC (vendored from Hermes Agent)."""

from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from typing import Any

logger = logging.getLogger(__name__)


class MemoryProvider(ABC):
    """Abstract base class for memory providers."""

    @property
    @abstractmethod
    def name(self) -> str:
        """Short identifier (e.g. 'honcho', 'mem0')."""

    @abstractmethod
    def is_available(self) -> bool:
        """True if configured and ready (no blocking network I/O)."""

    @abstractmethod
    def initialize(self, session_id: str, **kwargs) -> None:
        """Session start; kwargs include hermes_home, platform, user_id, etc."""

    def system_prompt_block(self) -> str:
        return ""

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        return ""

    def queue_prefetch(self, query: str, *, session_id: str = "") -> None:
        pass

    def sync_turn(self, user_content: str, assistant_content: str, *, session_id: str = "") -> None:
        pass

    @abstractmethod
    def get_tool_schemas(self) -> list[dict[str, Any]]:
        """OpenAI-style function schemas."""

    def handle_tool_call(self, tool_name: str, args: dict[str, Any], **kwargs) -> str:
        raise NotImplementedError(f"Provider {self.name} does not handle tool {tool_name}")

    def shutdown(self) -> None:
        pass

    def on_turn_start(self, turn_number: int, message: str, **kwargs) -> None:
        pass

    def on_session_end(self, messages: list[dict[str, Any]]) -> None:
        pass

    def on_pre_compress(self, messages: list[dict[str, Any]]) -> str:
        return ""

    def on_delegation(self, task: str, result: str, *, child_session_id: str = "", **kwargs) -> None:
        pass

    def get_config_schema(self) -> list[dict[str, Any]]:
        return []

    def save_config(self, values: dict[str, Any], hermes_home: str) -> None:
        pass

    def on_memory_write(self, action: str, target: str, content: str) -> None:
        pass
