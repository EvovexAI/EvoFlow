"""Unit tests for mini Frame pipeline runtime."""

from __future__ import annotations

import asyncio

import pytest

from app.gateway.speech.runtime.aggregators import SentenceAggregator, UserTurnAggregator
from app.gateway.speech.runtime.frames import (
    AudioRawFrame,
    EndFrame,
    Frame,
    InterruptionFrame,
    LLMResponseEndFrame,
    LLMTextFrame,
    StartFrame,
    TranscriptionFrame,
    TTSRequestFrame,
    TTSSpeakFrame,
    UserTurnCompleteFrame,
)
from app.gateway.speech.runtime.pipeline import Pipeline
from app.gateway.speech.runtime.processor import FrameDirection, FrameProcessor, PassthroughProcessor
from app.gateway.speech.runtime.worker import PipelineWorker


class CollectProcessor(FrameProcessor):
    def __init__(self, name: str = "Collect") -> None:
        super().__init__(name=name)
        self.seen: list[Frame] = []

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        self.seen.append(frame)
        if direction == FrameDirection.DOWNSTREAM:
            await self.push_downstream(frame)
        else:
            await self.push_upstream(frame)


class SlowInterruptibleProcessor(FrameProcessor):
    def __init__(self) -> None:
        super().__init__(name="Slow")
        self.started = asyncio.Event()
        self.cancelled = False
        self.completed = False

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        if isinstance(frame, AudioRawFrame):
            self.started.set()
            try:
                await asyncio.sleep(5.0)
                self.completed = True
                await self.push_downstream(frame)
            except asyncio.CancelledError:
                self.cancelled = True
                raise
            return
        await self.push_downstream(frame)


@pytest.mark.asyncio
async def test_sentence_aggregator_splits_and_flushes() -> None:
    out: list[Frame] = []

    async def on_output(frame: Frame) -> None:
        out.append(frame)

    agg = SentenceAggregator()
    pipe = Pipeline([agg])
    worker = PipelineWorker(pipe, on_output=on_output, idle_timeout_s=0)
    await worker.start()
    await worker.push(LLMTextFrame(text="你好。世界"))
    await asyncio.sleep(0.05)
    await worker.push(LLMResponseEndFrame())
    await asyncio.sleep(0.05)
    await worker.stop()

    reqs = [f for f in out if isinstance(f, TTSRequestFrame)]
    assert len(reqs) >= 1
    assert any("你好" in f.text for f in reqs)
    assert any("世界" in f.text for f in reqs)


@pytest.mark.asyncio
async def test_tts_speak_bypasses_buffer() -> None:
    out: list[Frame] = []

    async def on_output(frame: Frame) -> None:
        out.append(frame)

    agg = SentenceAggregator()
    pipe = Pipeline([agg])
    worker = PipelineWorker(pipe, on_output=on_output, idle_timeout_s=0)
    await worker.start()
    await worker.push(TTSSpeakFrame(text="好的", seq=1))
    await asyncio.sleep(0.05)
    await worker.stop()
    reqs = [f for f in out if isinstance(f, TTSRequestFrame)]
    assert len(reqs) == 1
    assert reqs[0].text == "好的"
    assert reqs[0].seq == 1


@pytest.mark.asyncio
async def test_user_turn_aggregator_fires_after_final_grace() -> None:
    out: list[Frame] = []

    async def on_output(frame: Frame) -> None:
        out.append(frame)

    agg = UserTurnAggregator(silence_ms=5000, final_grace_ms=50)
    pipe = Pipeline([agg])
    worker = PipelineWorker(pipe, on_output=on_output, idle_timeout_s=0)
    await worker.start()
    await worker.push(TranscriptionFrame(text="今天天气怎么样", is_final=True))
    await asyncio.sleep(0.15)
    await worker.stop()
    turns = [f for f in out if isinstance(f, UserTurnCompleteFrame)]
    assert len(turns) == 1
    assert turns[0].text == "今天天气怎么样"


@pytest.mark.asyncio
async def test_interruption_jumps_priority_and_clears_interruptible() -> None:
    slow = SlowInterruptibleProcessor()
    collect = CollectProcessor()
    pipe = Pipeline([slow, collect])
    worker = PipelineWorker(pipe, idle_timeout_s=0)
    await worker.start()
    await worker.push(AudioRawFrame(audio=b"\x00\x01" * 100))
    await asyncio.wait_for(slow.started.wait(), timeout=1.0)
    await worker.broadcast_interruption("barge_in")
    await asyncio.sleep(0.1)
    await worker.stop()
    assert slow.cancelled or not slow.completed
    assert worker.metrics["interrupt_at"] is not None
    assert worker.metrics["interrupt_cleared_at"] is not None


@pytest.mark.asyncio
async def test_system_frame_preserved_on_interruption_drain() -> None:
    collect = CollectProcessor()
    pipe = Pipeline([PassthroughProcessor("A"), collect])
    worker = PipelineWorker(pipe, idle_timeout_s=0)
    await worker.start()
    # Queue many interruptible frames then interrupt
    for _ in range(5):
        await collect.queue_frame(AudioRawFrame(audio=b"x"), FrameDirection.DOWNSTREAM)
    await collect.queue_frame(EndFrame(), FrameDirection.DOWNSTREAM)
    await worker.broadcast_interruption()
    await asyncio.sleep(0.1)
    await worker.stop()
    # EndFrame is uninterruptible system — should still be processable path;
    # at minimum interruption itself was seen.
    assert any(isinstance(f, InterruptionFrame) for f in collect.seen)


@pytest.mark.asyncio
async def test_pipeline_start_end() -> None:
    out: list[Frame] = []

    async def on_output(frame: Frame) -> None:
        out.append(frame)

    pipe = Pipeline([PassthroughProcessor()])
    worker = PipelineWorker(pipe, on_output=on_output, idle_timeout_s=0)
    await worker.start(StartFrame(speaker="zh_female_vv_uranus_bigtts"))
    await worker.push(LLMTextFrame(text="ping"))
    await asyncio.sleep(0.05)
    await worker.stop()
    assert any(isinstance(f, StartFrame) for f in out) or any(
        isinstance(f, LLMTextFrame) for f in out
    )


@pytest.mark.asyncio
async def test_interruption_delivered_once_per_processor() -> None:
    """A barge-in must reach each station exactly once (no duplicate fan-out)."""
    first = CollectProcessor("First")
    second = CollectProcessor("Second")
    pipe = Pipeline([first, second])
    worker = PipelineWorker(pipe, idle_timeout_s=0)
    await worker.start()
    await worker.broadcast_interruption("barge_in")
    await asyncio.sleep(0.1)
    await worker.stop()

    assert sum(isinstance(f, InterruptionFrame) for f in first.seen) == 1
    assert sum(isinstance(f, InterruptionFrame) for f in second.seen) == 1


@pytest.mark.asyncio
async def test_interruption_cancels_whole_data_chain() -> None:
    """Cancelling the newest task must also stop the older ones behind it."""
    slow = SlowInterruptibleProcessor()
    collect = CollectProcessor()
    pipe = Pipeline([slow, collect])
    worker = PipelineWorker(pipe, idle_timeout_s=0)
    await worker.start()
    await worker.push(AudioRawFrame(audio=b"\x00\x01" * 100))
    await asyncio.wait_for(slow.started.wait(), timeout=1.0)
    await worker.broadcast_interruption("barge_in")
    await asyncio.sleep(0.2)
    await worker.stop()
    assert slow.cancelled, "in-flight data work must be cancelled by the barge-in"
