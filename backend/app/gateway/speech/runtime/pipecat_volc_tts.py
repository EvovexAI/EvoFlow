"""Volcengine / Doubao TTS as a real Pipecat TTSService.

Yields MP3 chunks (our browser MSE path) while reusing Pipecat's
AudioContextManager ordered playback.

Latency notes (from 语音播报 logs):
  - Base TTSService awaits full ``run_tts`` per sentence → next sentence
    cannot start until the previous HTTP stream finishes (seen as 6s TTFB).
  - Default ``stop_frame_timeout_s=3`` adds multi-second gaps between seqs.
  - We concurrentize synthesis and close each context as soon as audio ends.
"""

from __future__ import annotations

import asyncio
import re
import time
import uuid
from collections.abc import AsyncGenerator, AsyncIterator

from loguru import logger

from pipecat.frames.frames import (
    AggregatedTextFrame,
    ErrorFrame,
    Frame,
    InterruptionFrame,
    TTSAudioRawFrame,
    TTSStartedFrame,
    TTSStoppedFrame,
)
from pipecat.processors.frame_processor import FrameDirection
from pipecat.services.settings import TTSSettings
from pipecat.services.tts_service import TTSContext, TTSService
from pipecat.transcriptions.language import Language
from pipecat.utils.text.base_text_aggregator import Aggregation, TextType
from pipecat.utils.text.simple_text_aggregator import SimpleTextAggregator

from app.gateway.speech.voice_file_log import voice_playback_event

# 首句快切：逗号/顿号亦可切（略宽于旧版 8 字，保证「从前有个修表匠，」能开口）
_FIRST_PAUSE_RE = re.compile(r"[^。！？!?；;\n，,、]{6,}[，,、]")
_FIRST_SENTENCE_MAX = 36


class FastFirstSentenceAggregator(SimpleTextAggregator):
    """Sentence aggregator with first-utterance fast cut on comma / 40 chars."""

    def __init__(self, **kwargs) -> None:
        super().__init__(**kwargs)
        self._emitted_in_turn = 0

    async def handle_interruption(self) -> None:
        await super().handle_interruption()
        self._emitted_in_turn = 0

    async def reset(self) -> None:
        await super().reset()
        self._emitted_in_turn = 0

    async def aggregate(self, text: str) -> AsyncIterator[Aggregation]:
        async for agg in super().aggregate(text):
            self._emitted_in_turn += 1
            yield agg

        if (
            self._aggregation_type != TextType.TOKEN
            and self._emitted_in_turn == 0
            and self._text
            and len(self._text) >= 6
        ):
            m = _FIRST_PAUSE_RE.match(self._text)
            cut_at = (
                m.end()
                if m
                else (_FIRST_SENTENCE_MAX if len(self._text) >= _FIRST_SENTENCE_MAX else 0)
            )
            if cut_at > 0:
                piece = self._text[:cut_at].strip(" ")
                remainder = self._text[cut_at:]
                self._text = remainder
                # Reset lookahead; remainder may continue aggregating.
                from pipecat.utils.text import simple_text_aggregator as _sta

                self._lookahead_state = _sta._LookaheadState.IDLE
                if piece:
                    self._emitted_in_turn += 1
                    yield Aggregation(text=piece, type=TextType.SENTENCE)

    async def flush(self) -> Aggregation | None:
        result = await super().flush()
        self._emitted_in_turn = 0
        return result


class VolcengineTTSService(TTSService):
    """Pipecat TTSService wrapping EvoFlow ``synthesize_tts_stream``."""

    def __init__(
        self,
        *,
        provider: str = "volcengine",
        speaker: str | None = None,
        sample_rate: int = 24000,
        **kwargs,
    ) -> None:
        super().__init__(
            sample_rate=sample_rate,
            # TTSStarted 由 run_tts 在首包音频时 yield；收口在 _bg.finally。
            push_start_frame=False,
            push_stop_frames=False,
            # MP3 wire format — do not inject PCM silence after stop.
            push_silence_after_stop=False,
            # 每句独立 context → 前端 seq/tts_start/tts_end 一一对应。
            reuse_context_id_within_turn=False,
            # 空等首包时 ACM get() 上限；真正收口靠 finally。
            stop_frame_timeout_s=60.0,
            settings=TTSSettings(model=None, voice=speaker, language=Language.ZH),
            **kwargs,
        )
        self._provider = (provider or "volcengine").strip().lower()
        # 空 speaker 钉死产品默认，避免各句落到不同 Gateway 默认
        from app.gateway.speech.volcengine_speech import DEFAULT_TTS_SPEAKER

        self._speaker = (speaker or "").strip() or DEFAULT_TTS_SPEAKER
        # 同会话复用 uid，减轻厂商侧音色/韵律漂移
        self._session_uid = f"evoflow-chat-{uuid.uuid4().hex[:12]}"
        self._bg_tasks: set[asyncio.Task] = set()
        self._text_aggregator = FastFirstSentenceAggregator(
            aggregation_type=self._text_aggregation_mode,
            language=self._text_aggregator.language,
        )

    def set_provider(self, provider: str | None) -> None:
        if provider:
            self._provider = provider.strip().lower()

    def set_speaker(self, speaker: str | None) -> None:
        from app.gateway.speech.volcengine_speech import DEFAULT_TTS_SPEAKER

        pinned = (speaker or "").strip() or DEFAULT_TTS_SPEAKER
        # 同会话内不因空值冲掉已钉好的音色
        if pinned:
            self._speaker = pinned

    def refresh_session(self) -> None:
        """New sticky uid after barge / new voice session."""
        self._session_uid = f"evoflow-chat-{uuid.uuid4().hex[:12]}"

    async def _handle_interruption(self, frame: InterruptionFrame, direction: FrameDirection):
        for t in list(self._bg_tasks):
            t.cancel()
        self._bg_tasks.clear()
        self.refresh_session()
        await super()._handle_interruption(frame, direction)

    async def _speak_text(self, src_frame: AggregatedTextFrame, text: str, context_id: str):
        """Speak one sentence without blocking the next sentence's synthesis."""
        if self.supports_processing_metrics and not self._is_streaming_tokens:
            await self.start_processing_metrics()

        prepared_text = await self._transform_text(text, src_frame.text_type)
        if prepared_text is None:
            await self.stop_processing_metrics()
            return

        context = self._tts_contexts.setdefault(
            context_id, TTSContext(interruptible=src_frame.interruptible)
        )
        await self._announce_text(src_frame, context_id)
        await self._call_event_handler("on_tts_request", context_id, prepared_text)
        # 先占坑保播放顺序，TTSStarted 延到 run_tts 首包音频。
        if not self.audio_context_available(context_id):
            await self.create_audio_context(context_id)
        await self._register_spoken_text(src_frame, prepared_text, context_id)

        queued_at = time.perf_counter()

        async def _bg() -> None:
            try:
                wait_ms = (time.perf_counter() - queued_at) * 1000
                if wait_ms > 5:
                    voice_playback_event(
                        "语音合成",
                        prepared_text,
                        extra=(
                            f"并发合成排队结束 context={context_id} "
                            f"queue_wait={wait_ms:.0f}ms"
                        ),
                    )
                await self.start_ttfb_metrics()
                await self._synthesize_text(prepared_text, context_id)
                await self._push_spoken_text(
                    src_frame, text, context_id, context.append_to_context
                )
            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.warning(f"{self} bg synth failed context={context_id}: {e}")
                voice_playback_event(
                    "语音合成",
                    prepared_text,
                    extra=f"合成失败 context={context_id} err={e}",
                )
                try:
                    if self.audio_context_available(context_id):
                        await self.append_to_audio_context(
                            context_id, ErrorFrame(error=str(e))
                        )
                except Exception:
                    pass
            finally:
                await self.stop_processing_metrics()
                # 合成结束后再 tts_end，绝不在空等 TTFB 时提前收口
                try:
                    if self.audio_context_available(context_id):
                        await self.append_to_audio_context(
                            context_id,
                            TTSStoppedFrame(context_id=context_id),
                        )
                        await self.remove_audio_context(context_id)
                except Exception as e:
                    logger.trace(f"{self} close context {context_id}: {e}")

        task = asyncio.create_task(_bg(), name=f"volc-tts-{context_id[:8]}")
        self._bg_tasks.add(task)

        def _done(t: asyncio.Task) -> None:
            self._bg_tasks.discard(t)
            if t.cancelled():
                return
            try:
                exc = t.exception()
            except asyncio.CancelledError:
                return
            if exc:
                logger.warning(f"{self} synth task error: {exc}")

        task.add_done_callback(_done)

    async def run_tts(self, text: str, context_id: str) -> AsyncGenerator[Frame | None, None]:
        from app.gateway.speech.tts_registry import synthesize_tts_stream

        t0 = time.perf_counter()
        first = True
        total = 0
        speaker = self._speaker or "(default)"
        try:
            await self.start_tts_usage_metrics(text)
            async for chunk in synthesize_tts_stream(
                text,
                provider=self._provider,
                speaker=self._speaker,
                session_uid=self._session_uid,
            ):
                if not isinstance(chunk, (bytes, bytearray, memoryview)):
                    continue
                data = bytes(chunk)
                if not data:
                    continue
                total += len(data)
                if first:
                    await self.stop_ttfb_metrics()
                    ms = (time.perf_counter() - t0) * 1000
                    voice_playback_event(
                        "语音合成",
                        text,
                        extra=(
                            f"流式首包到达 context={context_id} ttfb={ms:.0f}ms "
                            f"speaker={speaker} uid={self._session_uid}"
                        ),
                    )
                    # 与首包音频一起下发，前端不会空 play
                    yield TTSStartedFrame(context_id=context_id)
                    first = False
                yield TTSAudioRawFrame(data, self.sample_rate, 1, context_id=context_id)
            ms_all = (time.perf_counter() - t0) * 1000
            voice_playback_event(
                "语音合成",
                text,
                extra=(
                    f"流式合成完成 context={context_id} bytes={total} "
                    f"cost={ms_all:.0f}ms provider={self._provider} speaker={speaker}"
                ),
            )
        except Exception as e:
            logger.warning(f"{self} synthesize failed context={context_id}: {e}")
            voice_playback_event(
                "语音合成",
                text,
                extra=f"合成失败 context={context_id} err={e} speaker={speaker}",
            )
            yield ErrorFrame(error=str(e))
