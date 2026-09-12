"""Memory update queue with debounce mechanism."""

import logging
import threading
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from evoflow.config.memory_config import get_memory_config

logger = logging.getLogger(__name__)


@dataclass
class ConversationContext:
    """Context for a conversation to be processed for memory update."""

    thread_id: str
    messages: list[Any]
    timestamp: datetime = field(default_factory=lambda: datetime.now(UTC))
    agent_name: str | None = None
    workspace_path: str | None = None
    model_name: str | None = None
    principal_id: str | None = None


class MemoryUpdateQueue:
    """Queue for memory updates with debounce mechanism.

    This queue collects conversation contexts and processes them after
    a configurable debounce period. Multiple conversations received within
    the debounce window are batched together.
    """

    def __init__(self):
        """Initialize the memory update queue."""
        self._queue: list[ConversationContext] = []
        self._lock = threading.Lock()
        self._timer: threading.Timer | None = None
        self._processing = False

    def add(
        self,
        thread_id: str,
        messages: list[Any],
        agent_name: str | None = None,
        *,
        workspace_path: str | None = None,
        model_name: str | None = None,
        principal_id: str | None = None,
    ) -> None:
        """Add a conversation to the update queue.

        Args:
            thread_id: The thread ID.
            messages: The conversation messages.
            agent_name: If provided, memory is stored per-agent. If None, uses global memory.
            workspace_path: If provided, also queue workspace-scoped project memory update.
            principal_id: If provided, Phase1/Phase2 write to this user's personal
                asset bucket (``assets/users/<pid>/``) so the Asset Center sees them.
        """
        config = get_memory_config()
        if not config.enabled:
            return

        context = ConversationContext(
            thread_id=thread_id,
            messages=messages,
            agent_name=agent_name,
            workspace_path=workspace_path,
            model_name=model_name,
            principal_id=principal_id,
        )

        with self._lock:
            # Check if this thread already has a pending update
            # If so, replace it with the newer one
            self._queue = [c for c in self._queue if c.thread_id != thread_id]
            self._queue.append(context)

            # Reset or start the debounce timer
            self._reset_timer()
            queue_size = len(self._queue)

        agent_scope = agent_name if agent_name else "全局"
        ws_note = f"工作区={workspace_path}" if workspace_path else "工作区=未绑定"
        logger.info(
            "[记忆] 已入队 thread=%s agent=%s %s；队列长度=%d；%ss 防抖结束后由后台 LLM 整理写入",
            thread_id,
            agent_scope,
            ws_note,
            queue_size,
            config.debounce_seconds,
        )

    def _reset_timer(self) -> None:
        """Reset the debounce timer."""
        config = get_memory_config()

        # Cancel existing timer if any
        if self._timer is not None:
            self._timer.cancel()

        # Start new timer
        self._timer = threading.Timer(
            config.debounce_seconds,
            self._process_queue,
        )
        self._timer.daemon = True
        self._timer.start()

        logger.info("[记忆] 防抖计时器已重置：%ss 后执行队列", config.debounce_seconds)

    def _process_queue(self) -> None:
        """Process all queued conversation contexts."""
        # Import here to avoid circular dependency
        from evoflow.agents.memory.updater import MemoryUpdater

        with self._lock:
            if self._processing:
                # Already processing, reschedule
                logger.info("[记忆] 队列正在处理中，延后重试")
                self._reset_timer()
                return

            if not self._queue:
                logger.info("[记忆] 防抖触发但队列为空，跳过")
                return

            self._processing = True
            contexts_to_process = self._queue.copy()
            self._queue.clear()
            self._timer = None

        logger.info("[记忆] 防抖结束，开始异步整理：本批 %d 条", len(contexts_to_process))

        try:
            _first_ctx = contexts_to_process[0]
            updater = MemoryUpdater(model_name=_first_ctx.model_name)

            from evoflow.assets.pipeline_config import should_run_legacy_memory_updater

            run_legacy_updater = should_run_legacy_memory_updater()
            if not run_legacy_updater:
                logger.info(
                    "[记忆] 资产库记忆模式：跳过 SQLite MemoryUpdater，本批仅 Phase1/2 + ad-hoc notes"
                )

            for context in contexts_to_process:
                agent_scope = context.agent_name if context.agent_name else "全局"
                if run_legacy_updater:
                    try:
                        logger.info("[记忆] 开始整理用户记忆 thread=%s agent=%s", context.thread_id, agent_scope)
                        success = updater.update_memory(
                            messages=context.messages,
                            thread_id=context.thread_id,
                            agent_name=context.agent_name,
                        )
                        if success:
                            logger.info("[记忆] 用户记忆写入成功 thread=%s agent=%s", context.thread_id, agent_scope)
                        else:
                            logger.warning(
                                "[记忆] 用户记忆未写入 thread=%s agent=%s（LLM 无有效更新或解析失败，见 updater 日志）",
                                context.thread_id,
                                agent_scope,
                            )
                    except Exception as e:
                        logger.error("[记忆] 用户记忆写入异常 thread=%s: %s", context.thread_id, e)

                # Record <evo-asset-citation> paths → cite_count (no LLM)
                try:
                    from evoflow.assets.citation import record_citations_from_messages

                    cite = record_citations_from_messages(
                        context.messages,
                        agent_name=context.agent_name,
                    )
                    if cite.get("recorded"):
                        logger.info(
                            "[资产Citation] 记录 thread=%s paths=%s",
                            context.thread_id,
                            cite.get("paths"),
                        )
                except Exception as e:
                    logger.debug("[资产Citation] 异常 thread=%s: %s", context.thread_id, e)

                # runtime-aligned Asset Hub Phase1: extract → _inbox + episodic
                try:
                    from evoflow.assets.guidance import resolve_session_entity
                    from evoflow.assets.phase1 import run_phase1_extract

                    pid1 = str(context.principal_id or "").strip() or None
                    p1_entity = resolve_session_entity(
                        agent_name=context.agent_name,
                        principal_id=pid1 or "",
                    )
                    p1 = run_phase1_extract(
                        messages=context.messages,
                        thread_id=context.thread_id,
                        agent_name=context.agent_name,
                        workspace_path=context.workspace_path,
                        model_name=context.model_name,
                        entity=p1_entity,
                    )
                    if p1.get("ok") and not p1.get("skipped"):
                        logger.info(
                            "[资产Phase1] 完成 thread=%s paths=%s",
                            context.thread_id,
                            p1.get("paths"),
                        )
                    elif p1.get("skipped"):
                        logger.info(
                            "[资产Phase1] 跳过 thread=%s reason=%s",
                            context.thread_id,
                            p1.get("skipped"),
                        )
                except Exception as e:
                    logger.error("[资产Phase1] 异常 thread=%s: %s", context.thread_id, e)

                # Phase2: merge pending inbox → standing / MEMORY / craft (entity lock)
                try:
                    from evoflow.assets.guidance import resolve_session_entity
                    from evoflow.assets.phase2 import run_phase2_consolidate

                    pid = str(context.principal_id or "").strip() or None
                    p2_entity = resolve_session_entity(
                        agent_name=context.agent_name,
                        principal_id=pid or "",
                    )
                    p2 = run_phase2_consolidate(
                        agent_name=context.agent_name,
                        model_name=context.model_name,
                        entity=p2_entity,
                    )
                    if p2.get("ok") and not p2.get("skipped"):
                        logger.info(
                            "[资产Phase2] 完成 thread=%s paths=%s",
                            context.thread_id,
                            p2.get("paths"),
                        )
                    elif p2.get("skipped"):
                        logger.info(
                            "[资产Phase2] 跳过 thread=%s reason=%s",
                            context.thread_id,
                            p2.get("skipped"),
                        )
                except Exception as e:
                    logger.error("[资产Phase2] 异常 thread=%s: %s", context.thread_id, e)

                # Workspace-scoped project memory (structured facts only)
                if context.workspace_path:
                    try:
                        from evoflow.agents.memory.workspace_memory import update_workspace_memory_from_conversation

                        ws_ok = update_workspace_memory_from_conversation(
                            messages=context.messages,
                            workspace_path=context.workspace_path,
                            thread_id=context.thread_id,
                        )
                        if ws_ok:
                            logger.info(
                                "[记忆] 工作区记忆写入 thread=%s path=%s",
                                context.thread_id,
                                context.workspace_path,
                            )
                    except Exception as e:
                        logger.error("[记忆] 工作区记忆异常 thread=%s: %s", context.thread_id, e)

                # Small delay between updates to avoid rate limiting
                if len(contexts_to_process) > 1:
                    time.sleep(0.5)

            logger.info("[记忆] 本批异步整理结束")

        finally:
            with self._lock:
                self._processing = False

    def flush(self) -> None:
        """Force immediate processing of the queue.

        This is useful for testing or graceful shutdown.
        """
        with self._lock:
            if self._timer is not None:
                self._timer.cancel()
                self._timer = None

        self._process_queue()

    def clear(self) -> None:
        """Clear the queue without processing.

        This is useful for testing.
        """
        with self._lock:
            if self._timer is not None:
                self._timer.cancel()
                self._timer = None
            self._queue.clear()
            self._processing = False

    @property
    def pending_count(self) -> int:
        """Get the number of pending updates."""
        with self._lock:
            return len(self._queue)

    @property
    def is_processing(self) -> bool:
        """Check if the queue is currently being processed."""
        with self._lock:
            return self._processing


# Global singleton instance
_memory_queue: MemoryUpdateQueue | None = None
_queue_lock = threading.Lock()


def get_memory_queue() -> MemoryUpdateQueue:
    """Get the global memory update queue singleton.

    Returns:
        The memory update queue instance.
    """
    global _memory_queue
    with _queue_lock:
        if _memory_queue is None:
            _memory_queue = MemoryUpdateQueue()
        return _memory_queue


def reset_memory_queue() -> None:
    """Reset the global memory queue.

    This is useful for testing.
    """
    global _memory_queue
    with _queue_lock:
        if _memory_queue is not None:
            _memory_queue.clear()
        _memory_queue = None
