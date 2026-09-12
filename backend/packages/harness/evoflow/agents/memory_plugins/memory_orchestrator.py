"""Bridge Hermes ``MemoryManager`` to EvoFlow's external-memory orchestrator API."""

from __future__ import annotations

import logging

from evoflow.agents.memory_plugins.memory_port.memory_manager import MemoryManager
from evoflow.agents.memory_plugins.plugin_memory_audit import pm_event

logger = logging.getLogger(__name__)


class MemoryOrchestrator:
    """Same surface as ``ExternalMemoryPluginManager`` for middleware / updater / prompt."""

    def __init__(self, memory_manager: MemoryManager) -> None:
        self._mm = memory_manager
        self._thread_id: str | None = None

    @property
    def memory_manager(self) -> MemoryManager:
        return self._mm

    def ensure_thread(self, thread_id: str) -> None:
        """Call before tool handlers when ``thread_id`` is known (e.g. from LangGraph config)."""
        self._ensure(thread_id)

    def _ensure(self, thread_id: str) -> None:
        tid = thread_id or ""
        if self._thread_id == tid:
            return
        pm_event("hermes_memory_session_init", thread_id=tid, previous_thread=self._thread_id)
        try:
            self._mm.initialize_all(
                session_id=tid,
                platform="evoflow",
                user_id=tid,
            )
        except Exception as e:
            logger.warning("Hermes memory initialize_all failed: %s", e)
        self._thread_id = tid

    def system_addon(self) -> str:
        try:
            block = self._mm.build_system_prompt()
            return block.strip()
        except Exception as e:
            logger.warning("Hermes memory system prompt failed: %s", e)
            return ""

    def prefetch_fenced(self, query: str, *, thread_id: str = "") -> str:
        from evoflow.agents.memory_plugins.manager import build_memory_context_fence

        self._ensure(thread_id)
        try:
            raw = self._mm.prefetch_all(query, session_id=thread_id)
            fenced = build_memory_context_fence(raw)
            pm_event(
                "hermes_memory_prefetch",
                thread_id=thread_id,
                query_preview=query or "",
                raw_chars=len(raw or ""),
                fenced_chars=len(fenced or ""),
            )
            return fenced
        except Exception as e:
            logger.warning("Hermes memory prefetch failed: %s", e)
            return ""

    def queue_prefetch(self, query: str, *, thread_id: str = "") -> None:
        self._ensure(thread_id)
        pm_event("hermes_memory_queue_prefetch", thread_id=thread_id, query_preview=query or "")
        try:
            self._mm.queue_prefetch_all(query, session_id=thread_id)
        except Exception as e:
            logger.debug("Hermes memory queue_prefetch failed: %s", e)

    def sync_turn(self, user_content: str, assistant_content: str, *, thread_id: str = "") -> None:
        self._ensure(thread_id)
        pm_event(
            "hermes_memory_sync_turn",
            thread_id=thread_id,
            user_chars=len(user_content or ""),
            assistant_chars=len(assistant_content or ""),
            user_preview=user_content or "",
        )
        try:
            self._mm.sync_all(user_content, assistant_content, session_id=thread_id)
        except Exception as e:
            logger.warning("Hermes memory sync_turn failed: %s", e)

    def shutdown(self) -> None:
        pm_event("hermes_memory_shutdown", last_thread=self._thread_id)
        try:
            self._mm.shutdown_all()
        except Exception as e:
            logger.debug("Hermes memory shutdown failed: %s", e)
        self._thread_id = None
