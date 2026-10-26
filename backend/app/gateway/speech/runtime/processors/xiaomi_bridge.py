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
from app.gateway.speech.voice_file_log import voice_log

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
        # 轮次代数：每次用户开口 +1。打断不会让它回退，所以打断前排队的旧句
        # （旧 turn）会被下游丢弃，而新一轮的句子（新 turn）正常合成。
        self._turn = 0

    def set_turn_handler(self, handler: TurnHandler | None = None) -> None:
        self._on_user_turn = handler

    @property
    def turn(self) -> int:
        return self._turn

    def begin_assistant_turn(self) -> None:
        """Open the gate for a new model reply (chat arm / keyboard turn).

        ASR 路径靠 UserTurnComplete 抬轮次；纯文本提问没有 turn_end，必须显式开闸，
        否则 barge 后 ``_ignore_assistant`` 会一直挡住后续正文。
        """
        self._ignore_assistant = False
        self._turn += 1

    async def inject_assistant_text(self, text: str) -> None:
        if self._ignore_assistant or not text:
            return
        await self.push_downstream(LLMTextFrame(text=text, turn=self._turn))

    async def inject_assistant_end(self) -> None:
        # 只标记本轮流结束并冲刷残句。
        # 不要在这里把 _ignore_assistant 复位：打断后迟到的 assistant_end
        # 会把「忽略迟到正文」的门重新打开，旧回复就会回流成语音。
        # 下一轮由 UserTurnCompleteFrame 统一开闸。
        await self.push_downstream(LLMResponseEndFrame(turn=self._turn))

    async def inject_speak(self, text: str, seq: int | None = None) -> None:
        # 打断后忽略迟到的 legacy speak，避免与新一轮叠播
        if self._ignore_assistant:
            voice_log("打断", f"丢弃打断后迟到的直接播报：「{(text or '')[:48]}」")
            return
        await self.push_downstream(TTSSpeakFrame(text=text, seq=seq, turn=self._turn))

    async def on_interruption(self, frame: Frame) -> None:
        self._ignore_assistant = True
        # 抬高轮次，使打断后的新句 turn > TTS.min_turn（含原 turn=0 的 speak 路径）
        self._turn += 1

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        if direction != FrameDirection.DOWNSTREAM:
            await self.push_upstream(frame)
            return

        if isinstance(frame, StartFrame):
            self._ignore_assistant = False
            await self.push_downstream(frame)
            return

        if isinstance(frame, InterruptionFrame):
            # turn / ignore 已在 on_interruption（_handle_interruption）里抬高
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
            # 新一轮：开闸并推进轮次代数（打断前排队的旧句因此会在下游被丢弃）。
            self._ignore_assistant = False
            self._turn += 1
            if self._auto_ack:
                ack = random.choice(_ACK_POOL)
                voice_log("播报", f"先播确认短句：「{ack}」")
                await self.push_downstream(TTSSpeakFrame(text=ack, turn=self._turn))
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
