"""PipelineWorker — starts processors, injects frames, broadcasts interruptions."""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable
from typing import Any

from app.gateway.speech.runtime.frames import (
    EndFrame,
    Frame,
    InterruptionFrame,
    StartFrame,
)
from app.gateway.speech.runtime.pipeline import Pipeline
from app.gateway.speech.runtime.processor import FrameDirection

logger = logging.getLogger("evoflow.speech.runtime.worker")

OutputHandler = Callable[[Frame], Awaitable[None]]


class PipelineWorker:
    def __init__(
        self,
        pipeline: Pipeline,
        *,
        on_output: OutputHandler | None = None,
        on_upstream: OutputHandler | None = None,
        idle_timeout_s: float = 300.0,
    ) -> None:
        self.pipeline = pipeline
        self._on_output = on_output
        self._on_upstream = on_upstream
        self._idle_timeout_s = idle_timeout_s
        self._started = False
        self._closed = False
        self._last_activity = time.monotonic()
        self._idle_task: asyncio.Task[None] | None = None
        self.metrics: dict[str, Any] = {
            "user_stopped_at": None,
            "bot_first_audio_at": None,
            "interrupt_at": None,
            "interrupt_cleared_at": None,
        }
        pipeline.set_worker(self)

    @property
    def started(self) -> bool:
        return self._started and not self._closed

    async def start(self, start: StartFrame | None = None) -> None:
        if self._started:
            return
        self._started = True
        self._closed = False
        await self.pipeline.start()
        await self.push(start or StartFrame())
        self._last_activity = time.monotonic()
        if self._idle_timeout_s > 0:
            self._idle_task = asyncio.create_task(self._idle_watch(), name="pipeline-idle")

    async def stop(self) -> None:
        if self._closed:
            return
        self._closed = True
        if self._idle_task:
            self._idle_task.cancel()
            try:
                await self._idle_task
            except asyncio.CancelledError:
                pass
            self._idle_task = None
        try:
            await self.pipeline.queue_frame(EndFrame(), FrameDirection.DOWNSTREAM)
        except Exception:
            pass
        await self.pipeline.stop()
        self._started = False

    async def push(self, frame: Frame) -> None:
        if self._closed:
            return
        self._last_activity = time.monotonic()
        await self.pipeline.queue_frame(frame, FrameDirection.DOWNSTREAM)

    async def broadcast_interruption(self, reason: str = "barge_in") -> None:
        self.metrics["interrupt_at"] = time.monotonic()
        frame = InterruptionFrame(reason=reason)
        # Fan-out to every processor so each can cancel local work immediately
        for proc in self.pipeline.processors:
            await proc.queue_frame(frame, FrameDirection.DOWNSTREAM)
        self.metrics["interrupt_cleared_at"] = time.monotonic()
        logger.info(
            "interruption broadcast reason=%s cleared_ms=%.1f",
            reason,
            (self.metrics["interrupt_cleared_at"] - self.metrics["interrupt_at"]) * 1000,
        )

    async def on_pipeline_output(self, frame: Frame) -> None:
        self._last_activity = time.monotonic()
        if self._on_output:
            await self._on_output(frame)

    async def on_pipeline_upstream(self, frame: Frame) -> None:
        self._last_activity = time.monotonic()
        if self._on_upstream:
            await self._on_upstream(frame)

    async def _idle_watch(self) -> None:
        try:
            while not self._closed:
                await asyncio.sleep(5.0)
                if time.monotonic() - self._last_activity >= self._idle_timeout_s:
                    logger.info("pipeline idle timeout (%.0fs) — stopping", self._idle_timeout_s)
                    await self.stop()
                    return
        except asyncio.CancelledError:
            return
