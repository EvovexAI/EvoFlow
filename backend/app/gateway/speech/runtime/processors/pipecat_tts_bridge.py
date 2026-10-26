"""Embed a real Pipecat TTSService inside our Xiaomi Frame pipeline.

Maps EvoFlow frames → Pipecat Text/TTSSpeak/Interruption → VolcengineTTSService
(SimpleTextAggregator + AudioContextManager) → EvoFlow BotStarted / TTSAudio / BotStopped.

Wire protocol stays seq(4 LE) + MP3 for the browser MSE player.
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from typing import Any

from pipecat.frames.frames import (
    EndFrame as PipeEndFrame,
)
from pipecat.frames.frames import (
    InterruptionFrame as PipeInterruptionFrame,
)
from pipecat.frames.frames import (
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    LLMTextFrame as PipeLLMTextFrame,
    TTSAudioRawFrame as PipeTTSAudioRawFrame,
    TTSSpeakFrame as PipeTTSSpeakFrame,
    TTSStartedFrame,
    TTSStoppedFrame,
)
from pipecat.pipeline.pipeline import Pipeline as PipePipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker as PipeWorker
from pipecat.processors.frame_processor import FrameDirection as PipeDirection
from pipecat.processors.frame_processor import FrameProcessor as PipeFrameProcessor
from pipecat.workers.runner import WorkerRunner

from app.gateway.speech.runtime.aggregators import strip_markdown_light
from app.gateway.speech.runtime.frames import (
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    EndFrame,
    Frame,
    InterruptionFrame,
    LLMResponseEndFrame,
    LLMTextFrame,
    StartFrame,
    TTSAudioRawFrame,
    TTSRequestFrame,
    TTSSpeakFrame,
)
from app.gateway.speech.runtime.pipecat_volc_tts import VolcengineTTSService
from app.gateway.speech.runtime.processor import FrameDirection, FrameProcessor
from app.gateway.speech.voice_file_log import voice_log, voice_playback_event

logger = logging.getLogger("evoflow.speech.pipecat_tts_bridge")

_READABLE = re.compile(r"[\w\u4e00-\u9fff]", re.UNICODE)


def _has_readable(text: str) -> bool:
    return bool(_READABLE.search(text or ""))


class _CaptureSink(PipeFrameProcessor):
    """Collect TTS audio lifecycle frames for the Evo bridge."""

    def __init__(self, out_q: asyncio.Queue) -> None:
        super().__init__(enable_direct_mode=True, name="EvoTtsSink")
        self._out_q = out_q

    async def process_frame(self, frame, direction):  # noqa: ANN001
        await super().process_frame(frame, direction)
        if direction == PipeDirection.DOWNSTREAM and isinstance(
            frame, (TTSStartedFrame, TTSStoppedFrame, PipeTTSAudioRawFrame)
        ):
            await self._out_q.put(frame)
        await self.push_frame(frame, direction)


class PipecatTtsBridge(FrameProcessor):
    """Our FrameProcessor that hosts a long-lived Pipecat TTS mini-pipeline."""

    def __init__(
        self,
        *,
        provider: str | None = "volcengine",
        speaker: str | None = None,
    ) -> None:
        super().__init__(name="PipecatTtsBridge")
        self._provider = (provider or "volcengine").strip().lower()
        self._speaker = speaker
        self._tts: VolcengineTTSService | None = None
        self._pipe_worker: PipeWorker | None = None
        self._runner: WorkerRunner | None = None
        self._runner_task: asyncio.Task[None] | None = None
        self._drain_task: asyncio.Task[None] | None = None
        self._out_q: asyncio.Queue[Any] = asyncio.Queue()
        self._started_evt = asyncio.Event()
        self._ready = False
        self._closing = False
        # turn gate (legacy speak uses turn=0)
        self._current_turn = 0
        self._min_turn = 0
        self._in_llm_turn = False
        # context_id → seq / text
        self._seq_counter = 0
        self._ctx_seq: dict[str, int] = {}
        self._ctx_text: dict[str, str] = {}
        self._open_seqs: set[int] = set()

    async def start(self) -> None:
        await super().start()
        await self._ensure_pipecat()

    async def stop(self) -> None:
        await self._shutdown_pipecat()
        await super().stop()

    async def on_interruption(self, frame: Frame) -> None:
        self._min_turn = max(int(self._min_turn or 0), int(self._current_turn or 0) + 1)
        self._in_llm_turn = False
        voice_log("打断", f"Pipecat TTS：抬高 min_turn={self._min_turn}")
        if self._pipe_worker and self._ready:
            try:
                await self._pipe_worker.queue_frame(PipeInterruptionFrame())
            except Exception:
                logger.exception("failed to push InterruptionFrame into Pipecat")

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        if direction != FrameDirection.DOWNSTREAM:
            await self.push_upstream(frame)
            return

        if isinstance(frame, StartFrame):
            if frame.tts_provider:
                self._provider = frame.tts_provider
            if frame.speaker:
                self._speaker = frame.speaker
            self._current_turn = 0
            self._min_turn = 0
            self._in_llm_turn = False
            await self._ensure_pipecat()
            if self._tts:
                self._tts.set_provider(self._provider)
                self._tts.set_speaker(self._speaker)
            await self.push_downstream(frame)
            return

        if isinstance(frame, InterruptionFrame):
            # on_interruption already pushed into Pipecat
            await self.push_downstream(frame)
            return

        if isinstance(frame, EndFrame):
            await self._shutdown_pipecat()
            await self.push_downstream(frame)
            return

        if isinstance(frame, LLMTextFrame):
            turn = int(frame.turn or 0)
            if self._min_turn and turn and turn < self._min_turn:
                voice_log("打断", f"丢弃旧轮次正文 turn={turn}")
                return
            if turn:
                self._current_turn = turn
            text = strip_markdown_light(frame.text or "")
            if not text:
                return
            await self._ensure_pipecat()
            if not self._in_llm_turn:
                self._in_llm_turn = True
                await self._pipe_worker.queue_frame(LLMFullResponseStartFrame())
            await self._pipe_worker.queue_frame(PipeLLMTextFrame(text=text))
            return

        if isinstance(frame, LLMResponseEndFrame):
            turn = int(frame.turn or 0)
            if turn:
                self._current_turn = max(self._current_turn, turn)
            if self._pipe_worker and self._in_llm_turn:
                await self._pipe_worker.queue_frame(LLMFullResponseEndFrame())
            self._in_llm_turn = False
            return

        if isinstance(frame, (TTSSpeakFrame, TTSRequestFrame)):
            text = strip_markdown_light(getattr(frame, "text", "") or "")
            turn = int(getattr(frame, "turn", 0) or 0)
            # turn=0 legacy speak still gated by min_turn
            if self._min_turn and turn < self._min_turn:
                voice_log("打断", f"丢弃旧轮次句子 turn={turn}：「{text}」")
                return
            if turn:
                self._current_turn = turn
            if not text or not _has_readable(text):
                return
            await self._ensure_pipecat()
            seq = getattr(frame, "seq", None)
            voice_log("分句", f"直接播报句 seq={seq}：「{text}」")
            await self._pipe_worker.queue_frame(PipeTTSSpeakFrame(text=text))
            return

        await self.push_downstream(frame)

    # ── Pipecat lifecycle ──────────────────────────────────────────────

    async def _ensure_pipecat(self) -> None:
        if self._ready and self._pipe_worker:
            return
        if self._closing:
            return

        self._out_q = asyncio.Queue()
        self._started_evt.clear()
        self._tts = VolcengineTTSService(provider=self._provider, speaker=self._speaker)

        @self._tts.event_handler("on_tts_request")
        async def _on_tts_request(_svc, context_id: str, text: str):
            self._ctx_text[context_id] = text
            voice_playback_event(
                "语音合成",
                text,
                extra=f"Pipecat 开始合成 context={context_id}",
            )

        sink = _CaptureSink(self._out_q)
        pipeline = PipePipeline([self._tts, sink])
        self._pipe_worker = PipeWorker(
            pipeline,
            cancel_on_idle_timeout=False,
            idle_timeout_secs=None,
            enable_rtvi=False,
            enable_tracing=False,
            check_dangling_tasks=False,
            params=PipelineParams(
                enable_metrics=False,
                enable_usage_metrics=False,
                audio_out_sample_rate=24000,
            ),
            name="evo-tts",
        )

        @self._pipe_worker.event_handler("on_pipeline_started")
        async def _on_started(_worker, _frame):
            self._started_evt.set()

        self._runner = WorkerRunner(
            handle_sigint=False,
            handle_sigterm=False,
            check_dangling_tasks=False,
            name="evo-tts-runner",
        )
        await self._runner.add_workers(self._pipe_worker)
        self._runner_task = asyncio.create_task(self._runner.run(), name="evo-tts-runner-run")
        self._drain_task = asyncio.create_task(self._drain_out(), name="evo-tts-drain")

        try:
            await asyncio.wait_for(self._started_evt.wait(), timeout=10.0)
        except TimeoutError:
            logger.error("Pipecat TTS pipeline failed to start within 10s")
            await self._shutdown_pipecat()
            raise RuntimeError("Pipecat TTS pipeline start timeout")
        self._ready = True
        logger.info("Pipecat TTS mini-pipeline ready provider=%s", self._provider)

    async def _shutdown_pipecat(self) -> None:
        if self._closing:
            return
        self._closing = True
        self._ready = False
        try:
            if self._pipe_worker:
                try:
                    await self._pipe_worker.queue_frame(PipeEndFrame())
                except Exception:
                    pass
            if self._runner:
                try:
                    await self._runner.cancel()
                except Exception:
                    pass
            if self._runner_task:
                try:
                    await asyncio.wait_for(self._runner_task, timeout=3.0)
                except (TimeoutError, asyncio.CancelledError, Exception):
                    self._runner_task.cancel()
            if self._drain_task and not self._drain_task.done():
                self._drain_task.cancel()
                try:
                    await self._drain_task
                except (asyncio.CancelledError, Exception):
                    pass
        finally:
            self._pipe_worker = None
            self._runner = None
            self._runner_task = None
            self._drain_task = None
            self._tts = None
            self._closing = False
            self._ctx_seq.clear()
            self._ctx_text.clear()
            self._open_seqs.clear()

    def _seq_for(self, context_id: str | None) -> int:
        cid = context_id or ""
        if cid not in self._ctx_seq:
            self._seq_counter += 1
            self._ctx_seq[cid] = self._seq_counter
        return self._ctx_seq[cid]

    async def _drain_out(self) -> None:
        try:
            while True:
                frame = await self._out_q.get()
                try:
                    await self._emit_pipe_frame(frame)
                except Exception:
                    logger.exception("failed to emit Pipecat TTS frame to Evo pipeline")
        except asyncio.CancelledError:
            return

    async def _emit_pipe_frame(self, frame: Any) -> None:
        if isinstance(frame, TTSStartedFrame):
            seq = self._seq_for(frame.context_id)
            text = self._ctx_text.get(frame.context_id or "", "")
            self._open_seqs.add(seq)
            self._set_bot_speaking(True)
            if self.worker and not self.worker.metrics.get("bot_first_audio_at"):
                # Will set on first audio; just note start.
                pass
            voice_playback_event(
                "语音播放",
                text,
                extra=f"首包就绪 seq={seq} context={frame.context_id}",
            )
            await self.push_downstream(BotStartedSpeakingFrame(seq=seq, text=text))
            return

        if isinstance(frame, PipeTTSAudioRawFrame):
            seq = self._seq_for(frame.context_id)
            text = self._ctx_text.get(frame.context_id or "", "")
            if seq not in self._open_seqs:
                self._open_seqs.add(seq)
                await self.push_downstream(BotStartedSpeakingFrame(seq=seq, text=text))
            if self.worker and not self.worker.metrics.get("bot_first_audio_at"):
                self.worker.metrics["bot_first_audio_at"] = time.monotonic()
            await self.push_downstream(
                TTSAudioRawFrame(audio=bytes(frame.audio), seq=seq, format="mp3")
            )
            return

        if isinstance(frame, TTSStoppedFrame):
            seq = self._seq_for(frame.context_id)
            text = self._ctx_text.pop(frame.context_id or "", "")
            self._open_seqs.discard(seq)
            voice_playback_event(
                "播放结束",
                text,
                extra=f"一句音频下发完毕 seq={seq}",
            )
            await self.push_downstream(BotStoppedSpeakingFrame(seq=seq, text=text))
            if not self._open_seqs:
                self._set_bot_speaking(False)
            return

    def _set_bot_speaking(self, active: bool) -> None:
        if not self.worker:
            return
        vad = next(
            (
                p
                for p in self.worker.pipeline.processors
                if hasattr(p, "set_bot_speaking")
            ),
            None,
        )
        if vad:
            vad.set_bot_speaking(active)
