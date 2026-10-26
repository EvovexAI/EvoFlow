"""LEGACY ASR processor — production uses Pipecat EvoSTTService via PipecatVoiceBridge."""

from __future__ import annotations

import logging

from app.gateway.speech.asr_registry import DEFAULT_ASR_PROVIDER, create_asr_session
from app.gateway.speech.runtime.frames import (
    AudioRawFrame,
    EndFrame,
    Frame,
    InterruptionFrame,
    StartFrame,
    TranscriptionFrame,
)
from app.gateway.speech.runtime.processor import FrameDirection, FrameProcessor

logger = logging.getLogger("evoflow.speech.asr_proc")


class AsrProcessor(FrameProcessor):
    def __init__(self, provider: str | None = None) -> None:
        super().__init__(name="AsrProcessor")
        self._provider = (provider or DEFAULT_ASR_PROVIDER).strip().lower()
        self._session = None
        self._started = False

    async def on_interruption(self, frame: Frame) -> None:
        # Keep ASR session alive during barge-in (user is speaking into it).
        pass

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        if direction != FrameDirection.DOWNSTREAM:
            await self.push_upstream(frame)
            return

        if isinstance(frame, StartFrame):
            if frame.asr_provider:
                self._provider = frame.asr_provider
            await self._ensure_session()
            await self.push_downstream(frame)
            return

        if isinstance(frame, AudioRawFrame):
            await self._ensure_session()
            if self._session:
                try:
                    await self._session.send_pcm(frame.audio)
                except Exception as e:
                    logger.warning("asr send_pcm failed: %s", e)
            # Do not forward raw audio further (downstream does not need PCM)
            return

        if isinstance(frame, InterruptionFrame):
            await self.push_downstream(frame)
            return

        if isinstance(frame, EndFrame):
            await self._close_session()
            await self.push_downstream(frame)
            return

        await self.push_downstream(frame)

    async def _ensure_session(self) -> None:
        if self._session:
            return

        async def on_transcript(text: str, is_final: bool, seg: str | None) -> None:
            await self.push_downstream(
                TranscriptionFrame(text=text, is_final=is_final, seg=seg)
            )

        async def on_error(msg: str) -> None:
            logger.warning("asr error: %s", msg)

        try:
            self._session = await create_asr_session(
                self._provider,
                on_transcript=on_transcript,
                on_error=on_error,
            )
            await self._session.start()
            self._started = True
        except Exception as e:
            logger.warning("asr session start failed (%s): %s", self._provider, e)
            self._session = None

    async def _close_session(self) -> None:
        if self._session:
            try:
                await self._session.close()
            except Exception:
                pass
            self._session = None
            self._started = False

    async def stop(self) -> None:
        await self._close_session()
        await super().stop()

    async def flush_asr(self) -> None:
        if self._session:
            try:
                await self._session.flush()
            except Exception:
                pass
