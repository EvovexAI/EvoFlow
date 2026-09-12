"""Background LLM for conversation compaction (debounced per thread)."""

from __future__ import annotations

import asyncio
import logging
import threading
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Literal

from langchain_core.messages import messages_from_dict

from evoflow.config.summarization_config import get_summarization_config

logger = logging.getLogger(__name__)


@dataclass
class CompactionJob:
    thread_id: str
    middle_payload: list[dict[str, Any]]
    context_length: int
    previous_summary: str | None
    aggressive: bool
    language: Literal["zh", "en"]
    session_key: str = ""
    model_name: str | None = None
    enqueued_at: datetime = field(default_factory=lambda: datetime.now(UTC))


class ContextCompactionQueue:
    """Debounced background compress summaries; results persist to ``evoflow_chat_messages``."""

    def __init__(self) -> None:
        self._pending: dict[str, CompactionJob] = {}
        self._lock = threading.Lock()
        self._timer: threading.Timer | None = None
        self._processing = False

    def has_pending_job(self, thread_id: str) -> bool:
        tid = str(thread_id or "").strip()
        if not tid:
            return False
        with self._lock:
            return tid in self._pending

    def enqueue(self, job: CompactionJob) -> None:
        cfg = get_summarization_config()
        if not cfg.enabled or not cfg.compaction_background_llm:
            return
        tid = str(job.thread_id or "").strip()
        if not tid or not job.middle_payload:
            return
        with self._lock:
            existing = self._pending.get(tid)
            if existing is not None and existing.middle_payload:
                # Merge middle payloads instead of overwriting: prevents Pass 1
                # middle segment from being silently lost when Pass 2 enqueues
                # a new job for the same thread before the batch processes.
                try:
                    from langchain_core.messages import messages_from_dict, messages_to_dict

                    old_msgs = messages_from_dict(existing.middle_payload)
                    new_msgs = messages_from_dict(job.middle_payload)
                    merged = old_msgs + [m for m in new_msgs if m not in old_msgs]
                    if merged:
                        job = CompactionJob(
                            thread_id=job.thread_id,
                            middle_payload=messages_to_dict(merged),
                            context_length=job.context_length,
                            previous_summary=job.previous_summary or existing.previous_summary,
                            aggressive=job.aggressive or existing.aggressive,
                            language=job.language,
                            session_key=job.session_key or existing.session_key,
                        )
                except Exception:
                    pass  # merge failed; fall back to overwrite
            self._pending[tid] = job
            self._reset_timer()
        logger.debug("Context compaction queue: job thread=%s middle_msgs=%d", tid[:12], len(job.middle_payload))
        try:
            from evoflow.observability.compaction_file_log import log_compaction_trace

            log_compaction_trace(
                "后台压缩入队",
                thread_id=tid,
                session_key=job.session_key,
                context_length=job.context_length,
                model_context=f"{job.context_length // 1000}k",
                job_middle_msgs=len(job.middle_payload),
                background_llm=True,
            )
        except Exception:
            pass

    def _reset_timer(self) -> None:
        cfg = get_summarization_config()
        if self._timer is not None:
            self._timer.cancel()
        self._timer = threading.Timer(
            cfg.compaction_background_debounce_seconds,
            self._run_processing,
        )
        self._timer.daemon = True
        self._timer.start()

    def _run_processing(self) -> None:
        with self._lock:
            if self._processing:
                # 已有处理中的批次，保留新入队的 job 等待下次处理
                self._reset_timer()
                return
            batch = dict(self._pending)
            self._pending.clear()
            self._processing = True

        if not batch:
            with self._lock:
                self._processing = False
            return

        try:
            asyncio.run(self._process_batch_async(batch))
        except Exception:
            logger.exception("Background context compaction batch failed")
            # 异常时重新入队失败的 job，避免静默丢失
            with self._lock:
                for thread_id, job in batch.items():
                    if thread_id not in self._pending:
                        self._pending[thread_id] = job
        finally:
            # 一个临界区内完成 "释放 processing + 检查 pending + 重启 timer"，
            # 避免中间窗口让其他线程再次进入 _run_processing。
            with self._lock:
                self._processing = False
                if self._pending:
                    self._reset_timer()

    async def _process_batch_async(self, batch: dict[str, CompactionJob]) -> None:
        from evoflow.agents.context_compaction_core import get_context_compaction_engine

        engine = get_context_compaction_engine()
        for thread_id, job in batch.items():
            # Per-job try/except: a single thread's LLM failure must not abort
            # the whole batch and cause already-summarized threads to be
            # re-enqueued and re-summarized (token waste / duplicate work).
            try:
                try:
                    middle = messages_from_dict(job.middle_payload)
                except Exception:
                    logger.warning("Compaction job deserialize failed thread=%s", thread_id[:12])
                    continue
                if not middle:
                    continue
                summary = await engine.generate_summary_for_turns(
                    middle,
                    thread_id=thread_id,
                    context_length=job.context_length,
                    previous_summary=job.previous_summary,
                    aggressive=job.aggressive,
                    language=job.language,
                    session_key=job.session_key or None,
                    model_name=job.model_name,
                )
                if not summary:
                    continue
                logger.info("Background context compaction ready thread=%s", thread_id[:12])
                try:
                    from evoflow.observability.compaction_file_log import log_compaction_trace

                    log_compaction_trace(
                        "后台压缩完成",
                        thread_id=thread_id,
                        session_key=job.session_key,
                        context_length=job.context_length,
                        model_context=f"{job.context_length // 1000}k",
                        job_middle_msgs=len(job.middle_payload),
                        note="pending_summary_ready",
                    )
                except Exception:
                    pass
            except Exception:
                logger.exception(
                    "Background context compaction job failed thread=%s",
                    thread_id[:12],
                )
                try:
                    from evoflow.observability.compaction_file_log import log_compaction_trace

                    log_compaction_trace(
                        "后台压缩失败",
                        thread_id=thread_id,
                        session_key=job.session_key,
                        level=logging.ERROR,
                        error="background job failed",
                    )
                except Exception:
                    pass
                continue


_queue: ContextCompactionQueue | None = None
_queue_factory_lock = threading.Lock()


def get_context_compaction_queue() -> ContextCompactionQueue:
    global _queue
    if _queue is None:
        with _queue_factory_lock:
            if _queue is None:
                _queue = ContextCompactionQueue()
    return _queue
