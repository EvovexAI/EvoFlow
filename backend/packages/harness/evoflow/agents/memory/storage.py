"""Memory storage providers — backed by unified mem_* on Owned KB."""

from __future__ import annotations

import logging
import threading
from typing import Any

from evoflow.memory.storage import (  # noqa: F401 — re-export
    FileMemoryStorage,
    MemoryStorage,
    OwnedMemoryStorage,
    SqliteMemoryStorage,
    create_empty_memory,
    reset_memory_storage_for_tests,
)
from evoflow.memory.storage import get_memory_storage as _owned_get_memory_storage

logger = logging.getLogger(__name__)

_storage_instance: MemoryStorage | None = None
_storage_lock = threading.Lock()


def get_memory_storage() -> MemoryStorage:
    """Return singleton OwnedMemoryStorage (mem_*). Ignores legacy storage_class."""
    global _storage_instance
    with _storage_lock:
        if _storage_instance is None:
            _storage_instance = _owned_get_memory_storage()
            logger.info("Memory storage → OwnedMemoryStorage (legacy evoflow_memory retired)")
        return _storage_instance


# Keep test helper name used by older tests
def reset_storage_for_tests() -> None:
    global _storage_instance
    with _storage_lock:
        _storage_instance = None
    reset_memory_storage_for_tests()
