"""Bridge Xiaomi agent text into the frame pipeline.

On UserTurnComplete → notify host (client runs sendXiaomiChat).
Host feeds assistant deltas via inject_assistant_text → LLMTextFrame.
Ack / working lines use TTSSpeakFrame without leaving the runtime.
"""

from __future__ import annotations

import logging
import random
from collections.abc import Awaitable, Callable

from app.gateway.speech.runtime.frames import (
    Frame,
    InterruptionFrame,
    LLMResponseEndFrame,
    LLMTextFrame,
    StartFrame,
    TTSSpeakFrame,
    UserTurnCompleteFrame,
)
from app.gateway.speech.runtime.processor import FrameDirection, FrameProcessor

logger = logging.getLogger("evoflow.speech.xiaomi_bridge")

TurnHandler = Callable[[str], Awaitable[None]]

_ACK_POOL = ("好的", "嗯", "收到", "好的，稍等", "行", "好嘞")


class XiaomiBridgeProcessor(FrameProcessor):
    def __init__(
        self,
        *,
        on_user_turn: TurnHandler | None = None,
        auto_ack: bool = True,
    ) -> None:
        super().__init__(name="XiaomiBridge")
        self._on_user_turn = on_user_turn
        self._auto_ack = auto_ack
        self._ignore_assistant = False

    def set_turn_handler(self, handler: TurnHandler | None) -> None:
        self._on_user_turn = handler

    async def inject_assistant_text(self, text: str) -> None:
        if self._ignore_assistant or not text:
            return
        await self.push_downstream(LLMTextFrame(text=text))

    async def inject_assistant_end(self) -> None:
        self._ignore_assistant = False
        await self.push_downstream(LLMResponseEndFrame())

    async def inject_speak(self, text: str, seq: int | None = None) -> None:
        await self.push_downstream(TTSSpeakFrame(text=text, seq=seq))

    async def on_interruption(self, frame: Frame) -> None:
        self._ignore_assistant = True

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        if direction != FrameDirection.DOWNSTREAM:
            await self.push_upstream(frame)
            return

        if isinstance(frame, StartFrame):
            self._ignore_assistant = False
            await self.push_downstream(frame)
            return

        if isinstance(frame, InterruptionFrame):
            self._ignore_assistant = True
            await self.push_downstream(frame)
            return

        if isinstance(frame, UserTurnCompleteFrame):
            text = (frame.text or "").strip()
            if not text:
                return
            if self.worker:
                import time

                self.worker.metrics["user_stopped_at"] = time.monotonic()
                self.worker.metrics["bot_first_audio_at"] = None
            self._ignore_assistant = False
            if self._auto_ack:
                ack = random.choice(_ACK_POOL)
                await self.push_downstream(TTSSpeakFrame(text=ack))
            if self._on_user_turn:
                try:
                    await self._on_user_turn(text)
                except Exception as e:
                    logger.warning("on_user_turn failed: %s", e)
            # Still forward so TransportOut can emit turn_end to client
            await self.push_downstream(frame)
            return

        # Pass through LLM text already in-stream, transcripts for UI, etc.
        await self.push_downstream(frame)
