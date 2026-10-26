"""Tests for the Pipecat TTS bridge: interruption cancels work but does not mute the session."""

from __future__ import annotations

import asyncio

import pytest

from app.gateway.speech.runtime.frames import (
    Frame,
    InterruptionFrame,
    StartFrame,
    TTSAudioRawFrame,
    TTSRequestFrame,
)
from app.gateway.speech.runtime.processor import FrameDirection, FrameProcessor
from app.gateway.speech.runtime.processors.pipecat_tts_bridge import PipecatTtsBridge


class CollectProcessor(FrameProcessor):
    def __init__(self) -> None:
        super().__init__(name="Collect")
        self.seen: list[Frame] = []

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        self.seen.append(frame)
        await self.push_downstream(frame)

    def spoken_texts(self) -> list[str]:
        out: list[str] = []
        for f in self.seen:
            if isinstance(f, TTSAudioRawFrame):
                out.append(bytes(f.audio).decode("utf-8", "ignore").strip("\x00 ").strip())
        return out


def _fake_synth(text: str, *, provider: str | None = None, speaker: str | None = None):
    async def gen():
        # Even-length payload so AudioContextManager alignment never pads.
        payload = text.encode("utf-8")
        if len(payload) % 2:
            payload = payload + b" "
        yield payload

    return gen()


async def _make_tts(monkeypatch: pytest.MonkeyPatch):
    import app.gateway.speech.tts_registry as registry

    monkeypatch.setattr(registry, "synthesize_tts_stream", _fake_synth)

    collect = CollectProcessor()
    tts = PipecatTtsBridge(provider="volcengine")
    tts._next = collect  # type: ignore[attr-defined]
    await collect.start()
    await tts.start()
    await tts.queue_frame(StartFrame(), FrameDirection.DOWNSTREAM)
    # Pipecat mini-pipeline boots inside start/_ensure_pipecat
    await asyncio.sleep(0.3)
    return tts, collect


@pytest.mark.asyncio
async def test_interruption_cancels_running_synthesis(monkeypatch: pytest.MonkeyPatch) -> None:
    import app.gateway.speech.tts_registry as registry

    started = asyncio.Event()

    async def slow_synth(text: str, *, provider: str | None = None, speaker: str | None = None):
        started.set()
        try:
            while True:
                await asyncio.sleep(0.05)
                yield b"\x00\x01" * 32
        except asyncio.CancelledError:
            raise

    monkeypatch.setattr(registry, "synthesize_tts_stream", slow_synth)

    collect = CollectProcessor()
    tts = PipecatTtsBridge(provider="volcengine")
    tts._next = collect  # type: ignore[attr-defined]
    await collect.start()
    await tts.start()
    await tts.queue_frame(StartFrame(), FrameDirection.DOWNSTREAM)
    await asyncio.sleep(0.3)
    await tts.queue_frame(TTSRequestFrame(text="第一句", seq=1, turn=1), FrameDirection.DOWNSTREAM)
    await asyncio.wait_for(started.wait(), timeout=5.0)

    await tts.queue_frame(InterruptionFrame(reason="barge_in"), FrameDirection.DOWNSTREAM)
    await asyncio.sleep(0.2)
    await tts.stop()

    assert tts._min_turn >= 1


@pytest.mark.asyncio
async def test_session_speaks_again_after_interruption(monkeypatch: pytest.MonkeyPatch) -> None:
    """A barge-in must not silence the whole session (regression)."""
    tts, collect = await _make_tts(monkeypatch)
    await tts.queue_frame(InterruptionFrame(reason="barge_in"), FrameDirection.DOWNSTREAM)
    await asyncio.sleep(0.1)
    await tts.queue_frame(TTSRequestFrame(text="新的回复", seq=2, turn=2), FrameDirection.DOWNSTREAM)
    await asyncio.sleep(1.0)
    await tts.stop()

    assert "新的回复" in collect.spoken_texts(), (
        "the session must be able to speak again after a barge-in"
    )


@pytest.mark.asyncio
async def test_sentences_are_spoken_in_request_order(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Two sentences must not overlap: the second waits for the first to finish."""
    import app.gateway.speech.tts_registry as registry

    async def synth(text: str, *, provider: str | None = None, speaker: str | None = None):
        delay = 0.2 if text == "第一句" else 0.0
        await asyncio.sleep(delay)
        payload = text.encode("utf-8")
        if len(payload) % 2:
            payload = payload + b" "
        yield payload

    monkeypatch.setattr(registry, "synthesize_tts_stream", synth)

    collect = CollectProcessor()
    tts = PipecatTtsBridge(provider="volcengine")
    tts._next = collect  # type: ignore[attr-defined]
    await collect.start()
    await tts.start()
    await tts.queue_frame(StartFrame(), FrameDirection.DOWNSTREAM)
    await asyncio.sleep(0.3)
    await tts.queue_frame(TTSRequestFrame(text="第一句", seq=1, turn=1), FrameDirection.DOWNSTREAM)
    await tts.queue_frame(TTSRequestFrame(text="第二句", seq=2, turn=1), FrameDirection.DOWNSTREAM)
    await asyncio.sleep(1.5)
    await tts.stop()

    assert collect.spoken_texts() == ["第一句", "第二句"]


@pytest.mark.asyncio
async def test_stale_turn_sentence_is_dropped_after_interruption(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Text queued before the barge-in must never be spoken afterwards."""
    tts, collect = await _make_tts(monkeypatch)
    await tts.queue_frame(TTSRequestFrame(text="第一轮的话", seq=1, turn=1), FrameDirection.DOWNSTREAM)
    await asyncio.sleep(0.5)
    await tts.queue_frame(InterruptionFrame(reason="barge_in"), FrameDirection.DOWNSTREAM)
    await asyncio.sleep(0.1)
    await tts.queue_frame(TTSRequestFrame(text="迟到的旧句", seq=3, turn=1), FrameDirection.DOWNSTREAM)
    await asyncio.sleep(0.5)
    await tts.stop()

    spoken = collect.spoken_texts()
    assert "迟到的旧句" not in spoken, "stale pre-interruption text must not be spoken"
    assert "第一轮的话" in spoken


@pytest.mark.asyncio
async def test_turn0_speak_dropped_after_barge_in(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Legacy speak uses turn=0; barge-in must still raise min_turn so retries die."""
    tts, collect = await _make_tts(monkeypatch)
    await tts.queue_frame(TTSRequestFrame(text="旧句", seq=1, turn=0), FrameDirection.DOWNSTREAM)
    await asyncio.sleep(0.4)
    await tts.queue_frame(InterruptionFrame(reason="client_barge_in"), FrameDirection.DOWNSTREAM)
    await asyncio.sleep(0.1)
    await tts.queue_frame(TTSRequestFrame(text="旧句重试", seq=2, turn=0), FrameDirection.DOWNSTREAM)
    await tts.queue_frame(TTSRequestFrame(text="新句", seq=3, turn=1), FrameDirection.DOWNSTREAM)
    await asyncio.sleep(0.8)
    await tts.stop()

    spoken = collect.spoken_texts()
    assert "旧句重试" not in spoken
    assert "新句" in spoken
    assert tts._min_turn >= 1
