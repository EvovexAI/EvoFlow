"""TTS processor — TTSRequestFrame → streamed TTSAudioRawFrame."""

from __future__ import annotations

import asyncio
import logging
import time

from app.gateway.speech.runtime.frames import (
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    EndFrame,
    Frame,
    InterruptionFrame,
    StartFrame,
    TTSAudioRawFrame,
    TTSRequestFrame,
)
from app.gateway.speech.runtime.processor import FrameDirection, FrameProcessor

logger = logging.getLogger("evoflow.speech.tts_proc")


class TtsProcessor(FrameProcessor):
    def __init__(
        self,
        *,
        provider: str | None = "volcengine",
        speaker: str | None = None,
        max_concurrent: int = 3,
    ) -> None:
        super().__init__(name="TtsProcessor")
        self._provider = (provider or "volcengine").strip().lower()
        self._speaker = speaker
        self._max_concurrent = max_concurrent
        self._tasks: dict[int, asyncio.Task[None]] = {}
        self._cancel_all = False

    async def on_interruption(self, frame: Frame) -> None:
        self._cancel_all = True
        for task in list(self._tasks.values()):
            if not task.done():
                task.cancel()
        self._tasks.clear()

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        if direction != FrameDirection.DOWNSTREAM:
            await self.push_upstream(frame)
            return

        if isinstance(frame, StartFrame):
            if frame.tts_provider:
                self._provider = frame.tts_provider
            if frame.speaker:
                self._speaker = frame.speaker
            self._cancel_all = False
            await self.push_downstream(frame)
            return

        if isinstance(frame, InterruptionFrame):
            await self.on_interruption(frame)
            await self.push_downstream(frame)
            return

        if isinstance(frame, TTSRequestFrame):
            if self._cancel_all:
                return
            text = (frame.text or "").strip()
            if not text:
                return
            seq = int(frame.seq or 0) or int(time.time() * 1000) % 1_000_000
            old = self._tasks.pop(seq, None)
            if old and not old.done():
                old.cancel()
            if len(self._tasks) >= self._max_concurrent:
                oldest = min(self._tasks)
                t = self._tasks.pop(oldest)
                if not t.done():
                    t.cancel()
            self._tasks[seq] = asyncio.create_task(self._speak(seq, text))
            return

        if isinstance(frame, EndFrame):
            for t in list(self._tasks.values()):
                t.cancel()
            self._tasks.clear()
            await self.push_downstream(frame)
            return

        await self.push_downstream(frame)

    async def _speak(self, seq: int, text: str) -> None:
        from app.gateway.speech.tts_registry import synthesize_tts_stream

        try:
            await self.push_downstream(BotStartedSpeakingFrame(seq=seq))
            if self.worker:
                vad = next(
                    (
                        p
                        for p in self.worker.pipeline.processors
                        if hasattr(p, "set_bot_speaking")
                    ),
                    None,
                )
                if vad:
                    vad.set_bot_speaking(True)
                if self.worker.metrics.get("bot_first_audio_at") is None:
                    # Will stamp on first audio chunk
                    pass

            first = True
            gen = synthesize_tts_stream(
                text,
                provider=self._provider,
                speaker=self._speaker,
            )
            async for chunk in gen:
                if self._cancel_all:
                    break
                if not isinstance(chunk, (bytes, bytearray, memoryview)):
                    continue
                data = bytes(chunk)
                if not data:
                    continue
                if first and self.worker:
                    self.worker.metrics["bot_first_audio_at"] = time.monotonic()
                    u_stop = self.worker.metrics.get("user_stopped_at")
                    if u_stop:
                        logger.info(
                            "voice_ttfb_ms=%.1f seq=%s provider=%s",
                            (self.worker.metrics["bot_first_audio_at"] - u_stop) * 1000,
                            seq,
                            self._provider,
                        )
                    first = False
                await self.push_downstream(
                    TTSAudioRawFrame(audio=data, seq=seq, format="mp3")
                )
            await self.push_downstream(BotStoppedSpeakingFrame(seq=seq))
        except asyncio.CancelledError:
            await self.push_downstream(BotStoppedSpeakingFrame(seq=seq))
            raise
        except Exception as e:
            logger.warning("tts speak failed seq=%s: %s", seq, e)
            await self.push_downstream(BotStoppedSpeakingFrame(seq=seq))
        finally:
            self._tasks.pop(seq, None)
            if not self._tasks and self.worker:
                vad = next(
                    (
                        p
                        for p in self.worker.pipeline.processors
                        if hasattr(p, "set_bot_speaking")
                    ),
                    None,
                )
                if vad:
                    vad.set_bot_speaking(False)
