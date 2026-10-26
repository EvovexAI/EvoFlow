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
            if isinstance(frame, SystemFrame) or not frame.interruptible:
                # Wait for any prior interruptible work so ordering stays sane
                await self._await_process_task()
                await self._dispatch_inline(frame, direction)
                continue
            # Interruptible data runs in a side task so InterruptionFrame can be
            # dequeued (priority) while synthesis/ASR work is in flight.
            await self._await_process_task()
            self._current_interruptible = True
            self._process_task = asyncio.create_task(
                self._dispatch_inline(frame, direction),
                name=f"fp-work-{self.name}",
            )

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
        if self._process_task and not self._process_task.done() and self._current_interruptible:
            self._process_task.cancel()
            try:
                await self._process_task
            except (asyncio.CancelledError, Exception):
                pass
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
