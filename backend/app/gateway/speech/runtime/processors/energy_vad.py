"""Simple energy VAD — emits UserStarted/StoppedSpeaking for barge-in + turn."""

from __future__ import annotations

import audioop
import time

from app.gateway.speech.runtime.frames import (
    AudioRawFrame,
    Frame,
    InterruptionFrame,
    StartFrame,
    UserStartedSpeakingFrame,
    UserStoppedSpeakingFrame,
)
from app.gateway.speech.runtime.processor import FrameDirection, FrameProcessor


class EnergyVadProcessor(FrameProcessor):
    """PCM16 energy gate. Not as accurate as Silero; good enough for turn + barge-in."""

    def __init__(
        self,
        *,
        start_rms: int = 500,
        stop_rms: int = 350,
        start_frames: int = 3,
        stop_frames: int = 8,
        barge_in_enabled: bool = True,
    ) -> None:
        super().__init__(name="EnergyVad")
        self._start_rms = start_rms
        self._stop_rms = stop_rms
        self._start_need = start_frames
        self._stop_need = stop_frames
        self._barge_in_enabled = barge_in_enabled
        self._speaking = False
        self._high = 0
        self._low = 0
        self._bot_speaking = False
        self._last_start_at = 0.0

    def set_bot_speaking(self, active: bool) -> None:
        self._bot_speaking = active

    async def on_interruption(self, frame: Frame) -> None:
        pass

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        if direction != FrameDirection.DOWNSTREAM:
            await self.push_upstream(frame)
            return

        if isinstance(frame, StartFrame):
            self._speaking = False
            self._high = self._low = 0
            await self.push_downstream(frame)
            return

        if isinstance(frame, InterruptionFrame):
            await self.push_downstream(frame)
            return

        if isinstance(frame, AudioRawFrame):
            rms = 0
            if frame.audio:
                try:
                    rms = audioop.rms(frame.audio, 2)
                except Exception:
                    rms = 0
            await self._on_energy(rms)
            await self.push_downstream(frame)
            return

        await self.push_downstream(frame)

    async def _on_energy(self, rms: int) -> None:
        if not self._speaking:
            if rms >= self._start_rms:
                self._high += 1
                self._low = 0
                if self._high >= self._start_need:
                    self._speaking = True
                    self._high = 0
                    self._last_start_at = time.monotonic()
                    await self.push_downstream(UserStartedSpeakingFrame())
                    if self._barge_in_enabled and self._bot_speaking and self.worker:
                        await self.worker.broadcast_interruption("vad_barge_in")
            else:
                self._high = 0
            return

        if rms <= self._stop_rms:
            self._low += 1
            if self._low >= self._stop_need:
                self._speaking = False
                self._low = 0
                await self.push_downstream(UserStoppedSpeakingFrame())
        else:
            self._low = 0
