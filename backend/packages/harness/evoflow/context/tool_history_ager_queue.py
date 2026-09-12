"""Background LLM refinement for aged tool summaries (debounced per thread)."""

from __future__ import annotations

import asyncio
import logging
import threading
from dataclasses import dataclass, field
from datetime import UTC, datetime

from evoflow.config.tool_results_config import get_tool_results_config
from evoflow.context.shaped_tool_cache import remember_shaped
from evoflow.context.tool_result_summarizer import (
    summarize_tool_history_batch_async,
    summarize_tool_result_async,
)
from evoflow.context.tool_tokens import count_tool_tokens

logger = logging.getLogger(__name__)


@dataclass
class ToolSummaryJob:
    thread_id: str
    tool_call_id: str
    tool_name: str
    content: str
    enqueued_at: datetime = field(default_factory=lambda: datetime.now(UTC))


class ToolHistorySummaryQueue:
    """Debounced background tool-summary jobs; results land in shaped_tool_cache only."""

    def __init__(self) -> None:
        self._pending: dict[str, dict[str, ToolSummaryJob]] = {}
        self._lock = threading.Lock()
        self._timer: threading.Timer | None = None
        self._processing = False

    def enqueue(self, jobs: list[ToolSummaryJob]) -> None:
        cfg = get_tool_results_config()
        if not cfg.enabled or not cfg.history_summarize_enabled or not cfg.history_background_llm:
            return
        if not jobs:
            return
        with self._lock:
            for job in jobs:
                tid = job.thread_id
                self._pending.setdefault(tid, {})[job.tool_call_id] = job
            self._reset_timer()
        logger.debug("Tool history LLM queue: +%d jobs", len(jobs))

    def _reset_timer(self) -> None:
        cfg = get_tool_results_config()
        if self._timer is not None:
            self._timer.cancel()
        self._timer = threading.Timer(
            cfg.history_background_debounce_seconds,
            self._run_processing,
        )
        self._timer.daemon = True
        self._timer.start()

    def _run_processing(self) -> None:
        with self._lock:
            if self._processing:
                self._reset_timer()
                return
            batch = {tid: dict(jobs) for tid, jobs in self._pending.items()}
            self._pending.clear()
            self._processing = True

        if not batch:
            with self._lock:
                self._processing = False
            return

        try:
            asyncio.run(self._process_batch_async(batch))
        except Exception:
            logger.exception("Tool history background summary batch failed")
            # 异常时把失败的 jobs 重新入队，避免静默丢失（与 context_compaction_queue 一致）
            with self._lock:
                for tid, jobs in batch.items():
                    if tid not in self._pending:
                        self._pending[tid] = jobs
                    else:
                        # 合并：保留已有同 call_id 的最新 job
                        for call_id, job in jobs.items():
                            self._pending[tid].setdefault(call_id, job)
        finally:
            # 一个临界区内完成 "释放 processing + 检查 pending + 重启 timer"，
            # 防止处理期间新入队的 job 永远等不到下一轮 timer。
            with self._lock:
                self._processing = False
                if self._pending:
                    self._reset_timer()

    async def _process_batch_async(self, batch: dict[str, dict[str, ToolSummaryJob]]) -> None:
        for thread_id, jobs in batch.items():
            for job in jobs.values():
                # Per-job try/except: prevent one tool's LLM failure from
                # aborting the whole batch (which would cause already-summarized
                # tools to be re-summarized via outer requeue → token waste).
                try:
                    if count_tool_tokens(job.content) <= get_tool_results_config().tier_small_tokens:
                        continue
                    if job.tool_call_id == "__history_batch__":
                        summary = await summarize_tool_history_batch_async(job.content)
                    else:
                        summary = await summarize_tool_result_async(job.content, job.tool_name)
                    if summary:
                        remember_shaped(thread_id, job.tool_call_id, summary)
                        logger.info(
                            "Tool history background summary thread=%s tool_call_id=%s",
                            thread_id[:12],
                            job.tool_call_id[:12],
                        )
                except Exception:
                    logger.exception(
                        "Tool history background summary job failed thread=%s tool_call_id=%s",
                        thread_id[:12],
                        job.tool_call_id[:12],
                    )
                    continue


_queue: ToolHistorySummaryQueue | None = None
_queue_factory_lock = threading.Lock()


def get_tool_history_summary_queue() -> ToolHistorySummaryQueue:
    global _queue
    if _queue is None:
        with _queue_factory_lock:
            if _queue is None:
                _queue = ToolHistorySummaryQueue()
    return _queue
