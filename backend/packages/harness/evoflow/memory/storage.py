"""Memory storage providers — backed by unified mem_* on Owned KB."""

import abc
import logging
import threading
from typing import Any

from evoflow.config.agents_config import AGENT_NAME_PATTERN
from evoflow.config.memory_config import get_memory_config
from evoflow.timeutil import utc_now_iso_z

logger = logging.getLogger(__name__)


def create_empty_memory() -> dict[str, Any]:
    """Create an empty memory structure."""
    return {
        "version": "1.0",
        "lastUpdated": utc_now_iso_z(),
        "user": {
            "workContext": {"summary": "", "updatedAt": ""},
            "personalContext": {"summary": "", "updatedAt": ""},
            "topOfMind": {"summary": "", "updatedAt": ""},
        },
        "history": {
            "recentMonths": {"summary": "", "updatedAt": ""},
            "earlierContext": {"summary": "", "updatedAt": ""},
            "longTermBackground": {"summary": "", "updatedAt": ""},
        },
        "facts": [],
    }


class MemoryStorage(abc.ABC):
    """Abstract base class for memory storage providers."""

    @abc.abstractmethod
    def load(self, agent_name: str | None = None) -> dict[str, Any]:
        """Load memory data for the given agent."""

    @abc.abstractmethod
    def reload(self, agent_name: str | None = None) -> dict[str, Any]:
        """Force reload memory data for the given agent."""

    @abc.abstractmethod
    def save(self, memory_data: dict[str, Any], agent_name: str | None = None) -> bool:
        """Save memory data for the given agent."""


class OwnedMemoryStorage(MemoryStorage):
    """Unified memory on owned.sqlite ``mem_*`` (legacy document shape for UI/updater)."""

    def __init__(self) -> None:
        self._memory_cache: dict[str | None, dict[str, Any]] = {}
        self._migrate_once()

    def _migrate_once(self) -> None:
        try:
            from evoflow.memory.migrate_legacy import ensure_legacy_migrated

            ensure_legacy_migrated()
        except Exception:
            logger.debug("memory migrate on init skipped", exc_info=True)

    def _validate_agent_name(self, agent_name: str) -> None:
        if not agent_name:
            raise ValueError("Agent name must be a non-empty string.")
        if not AGENT_NAME_PATTERN.match(agent_name):
            raise ValueError(
                f"Invalid agent name {agent_name!r}: names must match {AGENT_NAME_PATTERN.pattern}"
            )

    def _namespace(self, agent_name: str | None) -> str:
        from evoflow.memory.document_codec import namespace_for_agent_key

        return namespace_for_agent_key(agent_name)

    def load(self, agent_name: str | None = None) -> dict[str, Any]:
        from evoflow.memory.document_codec import atoms_to_document

        if agent_name is not None:
            self._validate_agent_name(agent_name)
        cached = self._memory_cache.get(agent_name)
        if cached is not None:
            return cached
        ns = self._namespace(agent_name)
        memory_data = atoms_to_document(ns)
        if not any(
            (memory_data.get("user") or {}).get(k, {}).get("summary")
            for k in ("workContext", "personalContext", "topOfMind")
        ) and not memory_data.get("facts"):
            # Keep empty structure stable
            memory_data = create_empty_memory()
        self._memory_cache[agent_name] = memory_data
        return memory_data

    def reload(self, agent_name: str | None = None) -> dict[str, Any]:
        self._memory_cache.pop(agent_name, None)
        return self.load(agent_name)

    def save(self, memory_data: dict[str, Any], agent_name: str | None = None) -> bool:
        from evoflow.memory.document_codec import save_document

        if agent_name is not None:
            self._validate_agent_name(agent_name)
        try:
            memory_data["lastUpdated"] = utc_now_iso_z()
            ns = self._namespace(agent_name)
            ok = save_document(memory_data, namespace=ns)
            if ok:
                self._memory_cache[agent_name] = memory_data
                logger.info("Memory saved (owned mem_*) agent=%s", agent_name or "global")
            return ok
        except Exception as e:
            logger.error("Failed to save memory: %s", e)
            return False


# Prefer new storage; keep aliases for config strings that still mention Sqlite/File.
SqliteMemoryStorage = OwnedMemoryStorage
FileMemoryStorage = OwnedMemoryStorage


_storage_instance: MemoryStorage | None = None
_storage_lock = threading.Lock()


def get_memory_storage() -> MemoryStorage:
    """Return singleton memory storage (Owned KB mem_*)."""
    global _storage_instance
    with _storage_lock:
        if _storage_instance is None:
            cfg = get_memory_config()
            # Always use owned mem_* regardless of legacy storage_class string.
            _ = cfg.storage_class
            _storage_instance = OwnedMemoryStorage()
            logger.info("Memory storage: OwnedMemoryStorage (mem_* on owned.sqlite)")
        return _storage_instance


def reset_memory_storage_for_tests() -> None:
    global _storage_instance
    with _storage_lock:
        _storage_instance = None
