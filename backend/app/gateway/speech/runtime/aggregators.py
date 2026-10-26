"""Text aggregators: sentence split for TTS, user-turn end detection."""

from __future__ import annotations

import asyncio
import logging
import re

from app.gateway.speech.runtime.frames import (
    EndFrame,
    Frame,
    InterruptionFrame,
    LLMResponseEndFrame,
    LLMTextFrame,
    StartFrame,
    TranscriptionFrame,
    TTSRequestFrame,
    TTSSpeakFrame,
    UserStartedSpeakingFrame,
    UserStoppedSpeakingFrame,
    UserTurnCompleteFrame,
)
from app.gateway.speech.runtime.processor import FrameDirection, FrameProcessor

logger = logging.getLogger("evoflow.speech.runtime.agg")

# Chinese + Latin sentence terminators (Pipecat-style boundary)
_SENTENCE_RE = re.compile(r"[^。！？!?；;\n]*[。！？!?；;\n]+")
_READABLE_RE = re.compile(r"[\w\u4e00-\u9fff]", re.UNICODE)


def _has_readable(text: str) -> bool:
    return bool(_READABLE_RE.search(text or ""))


def strip_markdown_light(text: str) -> str:
    s = str(text or "").strip()
    s = re.sub(r"\*\*(.+?)\*\*", r"\1", s)
    s = re.sub(r"\*(.+?)\*", r"\1", s)
    s = re.sub(r"`(.+?)`", r"\1", s)
    s = re.sub(r"#{1,6}\s+", "", s)
    s = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", s)
    s = re.sub(r"\n+", " ", s)
    return s.strip()


class SentenceAggregator(FrameProcessor):
    """Accumulate LLMTextFrame → emit TTSRequestFrame per sentence."""

    def __init__(self) -> None:
        super().__init__(name="SentenceAggregator")
        self._buf = ""
        self._seq = 0

    def _next_seq(self) -> int:
        self._seq += 1
        return self._seq

    async def on_interruption(self, frame: Frame) -> None:
        self._buf = ""

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        if direction != FrameDirection.DOWNSTREAM:
            await self.push_upstream(frame)
            return

        if isinstance(frame, (InterruptionFrame, StartFrame)):
            self._buf = ""
            await self.push_downstream(frame)
            return

        if isinstance(frame, TTSSpeakFrame):
            text = strip_markdown_light(frame.text)
            if text and _has_readable(text):
                seq = frame.seq if frame.seq is not None else self._next_seq()
                await self.push_downstream(TTSRequestFrame(text=text, seq=seq))
            return

        if isinstance(frame, LLMTextFrame):
            self._buf += frame.text or ""
            await self._emit_complete_sentences(flush=False)
            return

        if isinstance(frame, (LLMResponseEndFrame, EndFrame)):
            await self._emit_complete_sentences(flush=True)
            await self.push_downstream(frame)
            return

        await self.push_downstream(frame)

    async def _emit_complete_sentences(self, *, flush: bool) -> None:
        if not self._buf:
            return
        last = 0
        for m in _SENTENCE_RE.finditer(self._buf):
            piece = strip_markdown_light(m.group(0))
            last = m.end()
            if piece and _has_readable(piece):
                await self.push_downstream(TTSRequestFrame(text=piece, seq=self._next_seq()))
        self._buf = self._buf[last:]
        if flush and self._buf.strip():
            piece = strip_markdown_light(self._buf)
            self._buf = ""
            if piece and _has_readable(piece):
                await self.push_downstream(TTSRequestFrame(text=piece, seq=self._next_seq()))


class UserTurnAggregator(FrameProcessor):
    """Silence window + ASR final → UserTurnCompleteFrame.

    First version: transcript-driven (no local SmartTurn model).
    """

    def __init__(
        self,
        *,
        silence_ms: float = 900.0,
        final_grace_ms: float = 400.0,
    ) -> None:
        super().__init__(name="UserTurnAggregator")
        self._silence_ms = silence_ms
        self._final_grace_ms = final_grace_ms
        self._text = ""
        self._timer: asyncio.Task[None] | None = None
        self._speaking = False
        self._completed_for_text = ""

    async def on_interruption(self, frame: Frame) -> None:
        # User barge-in during bot speech: do not wipe the new utterance buffer
        # unless this aggregator was holding an old pending send — cancel timer only.
        self._cancel_timer()

    def _cancel_timer(self) -> None:
        if self._timer and not self._timer.done():
            self._timer.cancel()
        self._timer = None

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        if direction != FrameDirection.DOWNSTREAM:
            await self.push_upstream(frame)
            return

        if isinstance(frame, StartFrame):
            self._text = ""
            self._completed_for_text = ""
            self._cancel_timer()
            await self.push_downstream(frame)
            return

        if isinstance(frame, UserStartedSpeakingFrame):
            self._speaking = True
            self._cancel_timer()
            await self.push_downstream(frame)
            return

        if isinstance(frame, UserStoppedSpeakingFrame):
            self._speaking = False
            await self.push_downstream(frame)
            self._arm_timer(self._silence_ms)
            return

        if isinstance(frame, TranscriptionFrame):
            text = (frame.text or "").strip()
            if text:
                self._text = text
                await self.push_downstream(frame)
                if frame.is_final:
                    self._arm_timer(self._final_grace_ms)
                else:
                    self._arm_timer(self._silence_ms)
            return

        if isinstance(frame, InterruptionFrame):
            await self.push_downstream(frame)
            return

        await self.push_downstream(frame)

    def _arm_timer(self, delay_ms: float) -> None:
        self._cancel_timer()
        self._timer = asyncio.create_task(self._fire_after(delay_ms / 1000.0))

    async def _fire_after(self, delay_s: float) -> None:
        try:
            await asyncio.sleep(delay_s)
            text = self._text.strip()
            if not text or text == self._completed_for_text:
                return
            self._completed_for_text = text
            self._text = ""
            await self.push_downstream(UserTurnCompleteFrame(text=text))
        except asyncio.CancelledError:
            return
