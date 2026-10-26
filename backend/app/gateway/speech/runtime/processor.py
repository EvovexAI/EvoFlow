"""FrameProcessor — one station on the pipeline."""

from __future__ import annotations

import asyncio
import logging
from abc import ABC, abstractmethod
from enum import Enum
from typing import TYPE_CHECKING, Any

from app.gateway.speech.runtime.frames import (
    CancelFrame,
    EndFrame,
    Frame,
    FramePriority,
    InterruptionFrame,
    StartFrame,
    SystemFrame,
)

if TYPE_CHECKING:
    from app.gateway.speech.runtime.worker import PipelineWorker

logger = logging.getLogger("evoflow.speech.runtime.processor")


class FrameDirection(Enum):
    DOWNSTREAM = 1
    UPSTREAM = 2


class FrameProcessor(ABC):
    """Independent asyncio station with a priority inbox."""

    def __init__(self, name: str | None = None) -> None:
        self.name = name or self.__class__.__name__
        self._queue: asyncio.PriorityQueue[tuple[int, int, Frame, FrameDirection]] = (
            asyncio.PriorityQueue()
        )
        self._seq = 0
        self._task: asyncio.Task[None] | None = None
        self._next: FrameProcessor | None = None
        self._prev: FrameProcessor | None = None
        self._worker: PipelineWorker | None = None
        self._running = False
        self._process_task: asyncio.Task[None] | None = None
        self._chain: list[asyncio.Task[None]] = []
        self._current_interruptible = True

    # ── wiring ──

    def link(self, nxt: FrameProcessor) -> FrameProcessor:
        self._next = nxt
        nxt._prev = self
        return nxt

    def set_worker(self, worker: PipelineWorker) -> None:
        self._worker = worker

    @property
    def worker(self) -> PipelineWorker | None:
        return self._worker

    # ── lifecycle ──

    async def start(self) -> None:
        if self._running:
            return
        self._running = True
        self._task = asyncio.create_task(self._run_loop(), name=f"fp-{self.name}")

    async def stop(self) -> None:
        self._running = False
        await self.queue_frame(CancelFrame(), FrameDirection.DOWNSTREAM)
        if self._task:
            try:
                await asyncio.wait_for(self._task, timeout=2.0)
            except (TimeoutError, asyncio.TimeoutError, asyncio.CancelledError):
                self._task.cancel()
            self._task = None
        if self._process_task and not self._process_task.done():
            self._process_task.cancel()
            try:
                await self._process_task
            except (asyncio.CancelledError, Exception):
                pass
            self._process_task = None
        for task in self._chain:
            if not task.done():
                task.cancel()
        self._chain.clear()

    async def queue_frame(
        self,
        frame: Frame,
        direction: FrameDirection = FrameDirection.DOWNSTREAM,
    ) -> None:
        self._seq += 1
        # Lower number = higher priority in PriorityQueue
        prio = -int(frame.priority)
        await self._queue.put((prio, self._seq, frame, direction))

    async def push_downstream(self, frame: Frame) -> None:
        if self._next:
            await self._next.queue_frame(frame, FrameDirection.DOWNSTREAM)
        elif self._worker:
            await self._worker.on_pipeline_output(frame)

    async def push_upstream(self, frame: Frame) -> None:
        if self._prev:
            await self._prev.queue_frame(frame, FrameDirection.UPSTREAM)
        elif self._worker:
            await self._worker.on_pipeline_upstream(frame)

    async def broadcast_interruption(self, reason: str = "barge_in") -> None:
        if self._worker:
            await self._worker.broadcast_interruption(reason)

    # ── internal loop ──

    async def _run_loop(self) -> None:
        while self._running:
            try:
                _prio, _seq, frame, direction = await self._queue.get()
            except asyncio.CancelledError:
                break
            if isinstance(frame, CancelFrame):
                await self._handle_interruption(frame)
                break
            if isinstance(frame, InterruptionFrame):
                await self._handle_interruption(frame)
                # Process interruption inline (fast); must not block the inbox
                await self._dispatch_inline(frame, direction)
                continue
            if isinstance(frame, EndFrame):
                # EndFrame terminates the pipeline — it must not overtake data
                # frames that are still queued (unlike system frames).
                await self._await_process_task()
                await self._dispatch_inline(frame, direction)
                continue
            if isinstance(frame, SystemFrame) or not frame.interruptible:
                # System / uninterruptible frames are handled right away and never
                # wait behind in-flight data work (Pipecat runs system frames on
                # a dedicated input task). Ordering with StartFrame is kept by
                # the priority queue: START > SYSTEM > DATA.
                await self._dispatch_inline(frame, direction)
                continue
            # Interruptible data runs in a side task so InterruptionFrame can be
            # dequeued (priority) while synthesis/ASR work is in flight.
            # Ordering of data frames is preserved by chaining each new task
            # behind the previous one — but the inbox itself stays free, so a
            # barge-in jumps ahead of queued audio/text.
            prev = self._process_task

            async def _run(
                frame: Frame = frame,
                direction: FrameDirection = direction,
                prev: asyncio.Task[None] | None = prev,
            ) -> None:
                if prev and not prev.done():
                    # NOTE: awaiting a task does NOT hand cancellation down, so
                    # the whole chain is cancelled explicitly on interruption.
                    await prev
                await self._dispatch_inline(frame, direction)

            self._process_task = asyncio.create_task(_run(), name=f"fp-work-{self.name}")
            self._chain.append(self._process_task)
            # Keep the chain list bounded: drop tasks that already finished.
            if len(self._chain) > 64:
                self._chain = [t for t in self._chain if not t.done()]

    async def _await_process_task(self) -> None:
        if self._process_task and not self._process_task.done():
            try:
                await self._process_task
            except (asyncio.CancelledError, Exception):
                pass
        self._process_task = None

    async def _dispatch_inline(self, frame: Frame, direction: FrameDirection) -> None:
        self._current_interruptible = bool(frame.interruptible)
        try:
            await self.process_frame(frame, direction)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("[%s] process_frame failed for %s", self.name, type(frame).__name__)

    async def _handle_interruption(self, frame: Frame) -> None:
        # Drain interruptible queued frames; keep system / uninterruptible.
        kept: list[tuple[int, int, Frame, FrameDirection]] = []
        while True:
            try:
                item = self._queue.get_nowait()
            except asyncio.QueueEmpty:
                break
            _p, _s, f, d = item
            if isinstance(f, SystemFrame) or not f.interruptible:
                kept.append(item)
        for item in kept:
            await self._queue.put(item)
        # Cancel the whole data chain. Cancelling only the newest task is not
        # enough: awaiting a predecessor does not propagate cancellation, so the
        # older tasks would keep running (Pipecat resets the process task).
        if self._current_interruptible:
            for task in self._chain:
                if not task.done():
                    task.cancel()
            for task in self._chain:
                try:
                    await task
                except (asyncio.CancelledError, Exception):
                    pass
        self._chain.clear()
        self._process_task = None
        await self.on_interruption(frame)

    async def on_interruption(self, frame: Frame) -> None:
        """Subclass hook — cancel provider work, reset aggregators, etc."""

    @abstractmethod
    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        """Handle one frame. Default subclasses usually push_downstream."""


class PassthroughProcessor(FrameProcessor):
    """Forwards every frame downstream (or upstream)."""

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        if direction == FrameDirection.DOWNSTREAM:
            await self.push_downstream(frame)
        else:
            await self.push_upstream(frame)
