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
from app.gateway.speech.voice_file_log import voice_log

logger = logging.getLogger("evoflow.speech.runtime.agg")

# Chinese + Latin sentence terminators (Pipecat-style boundary)
_SENTENCE_RE = re.compile(r"[^。！？!?；;\n]*[。！？!?；;\n]+")
# 首句快速开口：逗号/顿号也可切（对齐 Pipecat「先开口再讲完」）
_FIRST_PAUSE_RE = re.compile(r"[^。！？!?；;\n，,、]{8,}[，,、]")
_READABLE_RE = re.compile(r"[\w\u4e00-\u9fff]", re.UNICODE)
_FIRST_SENTENCE_MAX = 40


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


# TTS 念 URL/邮箱是「一长串英文字母」——语音场景最廉价感的瞬间；合成前口语化。
_URL_RE = re.compile(r"(?:https?://|www\.)\S+", re.IGNORECASE)
_EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
_LONG_ASCII_RUN_RE = re.compile(r"[A-Za-z0-9_./\\:-]{18,}")
# LLM 内联语气标记（[[tone:gentle]]）— 解析消费留待 agent prompt 侧启用，先剥防念出来
_TONE_MARK_RE = re.compile(r"\[\[\s*tone\s*:\s*[^\]]*\]\]", re.IGNORECASE)
# 书面腔确定性改写（模型漏网的机械感；只做高置信替换，宁少勿滥）
_BOOKISH_CONNECTIVE_RE = re.compile(r"(?:首先|其次|再者|此外|另外|总之|综上(?:所述)?|总的?[来讲]说|一般来[说讲])，\s*")
_VERB_DONE_RE = re.compile(r"进行了(处理|检查|确认|沟通|修改|更新|优化|调整|测试|部署)")
_VERB_TODO_RE = re.compile(r"进行(?=处理|检查|确认|沟通|修改|更新|优化|调整|测试|部署)")
_BOOKISH_PHRASE_RE = re.compile(r"如果需要的话|如果需要可|如有需要")
_CHINESE_COLON_RE = re.compile(r"([\u4e00-\u9fff])：")


def _spokenize(text: str) -> str:
    """书面腔 → 口语（TTS 兜底润色）。"""
    s = _BOOKISH_CONNECTIVE_RE.sub("", text)
    s = _VERB_DONE_RE.sub(r"\1了", s)
    s = _VERB_TODO_RE.sub("", s)
    s = _BOOKISH_PHRASE_RE.sub("要的话", s)
    # 中文冒号后接内容时念着生硬 → 逗号（时间 3：30 不受影响，仅限中文冒号）
    s = _CHINESE_COLON_RE.sub(r"\1，", s)
    return s


def normalize_for_tts(text: str) -> str:
    """口语化改写不适合朗读的 token（URL/邮箱/超长 ASCII 串），供 TTS 前调用。"""
    s = _TONE_MARK_RE.sub("", str(text or ""))
    s = _URL_RE.sub("链接", s)
    s = _EMAIL_RE.sub("邮箱地址", s)
    # 兜底：剩余超长 ASCII（路径/哈希/代码标识符）——念出来没人听得懂
    s = _LONG_ASCII_RUN_RE.sub("标识符", s)
    return _spokenize(s)


class SentenceAggregator(FrameProcessor):
    """Accumulate LLMTextFrame → emit TTSRequestFrame per sentence."""

    def __init__(self) -> None:
        super().__init__(name="SentenceAggregator")
        self._buf = ""
        self._seq = 0
        self._turn = 0
        self._emitted_in_turn = 0

    def _next_seq(self) -> int:
        self._seq += 1
        return self._seq

    async def on_interruption(self, frame: Frame) -> None:
        self._buf = ""
        self._emitted_in_turn = 0

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        if direction != FrameDirection.DOWNSTREAM:
            await self.push_upstream(frame)
            return

        if isinstance(frame, (InterruptionFrame, StartFrame)):
            self._buf = ""
            self._emitted_in_turn = 0
            await self.push_downstream(frame)
            return

        if isinstance(frame, TTSSpeakFrame):
            text = strip_markdown_light(frame.text)
            if text and _has_readable(text):
                seq = frame.seq if frame.seq is not None else self._next_seq()
                voice_log("分句", f"直接播报句 seq={seq}：「{text}」")
                await self.push_downstream(
                    TTSRequestFrame(text=text, seq=seq, turn=frame.turn)
                )
            return

        if isinstance(frame, LLMTextFrame):
            if frame.turn and frame.turn != self._turn:
                self._emitted_in_turn = 0
            self._buf += frame.text or ""
            self._turn = max(self._turn, frame.turn)
            await self._emit_complete_sentences(flush=False)
            return

        if isinstance(frame, (LLMResponseEndFrame, EndFrame)):
            await self._emit_complete_sentences(flush=True)
            self._emitted_in_turn = 0
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
                seq = self._next_seq()
                self._emitted_in_turn += 1
                voice_log("分句", f"切出完整句 seq={seq}：「{piece}」")
                await self.push_downstream(
                    TTSRequestFrame(text=piece, seq=seq, turn=self._turn)
                )
        self._buf = self._buf[last:]

        # 首句尚未开口：逗号/顿号或满 40 字快切，降低首包延迟
        if not flush and self._emitted_in_turn == 0 and self._buf and len(self._buf) >= 8:
            m = _FIRST_PAUSE_RE.match(self._buf)
            cut_at = m.end() if m else (_FIRST_SENTENCE_MAX if len(self._buf) >= _FIRST_SENTENCE_MAX else 0)
            if cut_at > 0:
                piece = strip_markdown_light(self._buf[:cut_at])
                self._buf = self._buf[cut_at:]
                if piece and _has_readable(piece):
                    seq = self._next_seq()
                    self._emitted_in_turn += 1
                    voice_log("分句", f"首句快切 seq={seq}：「{piece}」")
                    await self.push_downstream(
                        TTSRequestFrame(text=piece, seq=seq, turn=self._turn)
                    )

        if flush and self._buf.strip():
            piece = strip_markdown_light(self._buf)
            self._buf = ""
            if piece and _has_readable(piece):
                seq = self._next_seq()
                self._emitted_in_turn += 1
                voice_log("分句", f"冲刷残句 seq={seq}：「{piece}」")
                await self.push_downstream(
                    TTSRequestFrame(text=piece, seq=seq, turn=self._turn)
                )


class UserTurnAggregator(FrameProcessor):
    """LEGACY silence-window turn end — production uses Pipecat UserTurnProcessor.

    Kept for unit tests of the old Frame runtime.
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
