"""LEGACY TTS processor — replaced by PipecatTtsBridge + VolcengineTTSService.

Kept for reference / emergency fallback. Production Xiaomi pipeline uses
``PipecatTtsBridge`` (real Pipecat TTSService + AudioContextManager).
"""

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
from app.gateway.speech.voice_file_log import voice_log, voice_playback_event

logger = logging.getLogger("evoflow.speech.tts_proc")

_EOS = object()


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
        # seq → synthesis task (runs ahead, concurrently)
        self._tasks: dict[int, asyncio.Task[None]] = {}
        # seq → chunk queue feeding the ordered playback
        self._queues: dict[int, asyncio.Queue] = {}
        # seq → playback task (emits audio in request order)
        self._play_tasks: dict[int, asyncio.Task[None]] = {}
        # request order of playback
        self._play_order: list[int] = []
        self._play_lock = asyncio.Lock()
        # seq → 原文（核对「合成了什么 / 下发播了什么」）
        self._seq_text: dict[int, str] = {}
        # 轮次代数（>0 表示带轮次；0 = 不限轮次的通用播报）
        self._current_turn = 0
        self._min_turn = 0

    async def on_interruption(self, frame: Frame) -> None:
        # 取消进行中的合成。打断后，打断前那一轮的句子（turn <= _current_turn）
        # 即使迟到也不再播报；新一轮的句子（turn > _current_turn）正常播。
        # 对齐 Pipecat 的 audio context 分级：丢弃可打断上下文，保留新的上下文。
        for task in list(self._tasks.values()):
            if not task.done():
                task.cancel()
        self._tasks.clear()
        for task in list(self._play_tasks.values()):
            if not task.done():
                task.cancel()
        self._play_tasks.clear()
        self._play_order.clear()
        self._queues.clear()
        self._seq_text.clear()
        # 始终抬高门槛：legacy speak 常用 turn=0，若不抬高则 barge 后旧句仍会重合成
        # （日志里反复出现 min_turn=0 + 同一句「直接播报句」）。
        self._min_turn = max(int(self._min_turn or 0), int(self._current_turn or 0) + 1)
        # 只在这里打一行；process_frame 不再重复调 on_interruption（见下）
        voice_log(
            "打断",
            f"TTS 工位：取消进行中合成（min_turn={self._min_turn}）",
        )

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
            await self.push_downstream(frame)
            return

        if isinstance(frame, InterruptionFrame):
            # _handle_interruption 已调用 on_interruption；这里只转发，避免日志×2
            await self.push_downstream(frame)
            return

        if isinstance(frame, TTSRequestFrame):
            text = (frame.text or "").strip()
            if not text:
                return
            turn = int(frame.turn or 0)
            # turn=0（legacy speak）也必须受 min_turn 约束，否则 barge 后旧句会无限重试
            if self._min_turn and turn < self._min_turn:
                # 打断前那一轮的残留句子 → 丢弃，不播。
                voice_log("打断", f"丢弃旧轮次句子 turn={turn}：「{text}」")
                return
            if turn:
                self._current_turn = turn
            seq = int(frame.seq or 0) or int(time.time() * 1000) % 1_000_000
            old = self._tasks.pop(seq, None)
            if old and not old.done():
                old.cancel()
            if len(self._tasks) >= self._max_concurrent:
                oldest = min(self._tasks)
                t = self._tasks.pop(oldest)
                if not t.done():
                    t.cancel()
            self._seq_text[seq] = text
            voice_playback_event(
                "语音合成",
                text,
                extra=f"开始合成 seq={seq} provider={self._provider}",
            )
            queue: asyncio.Queue = asyncio.Queue()
            self._queues[seq] = queue
            self._tasks[seq] = asyncio.create_task(self._synthesize(seq, text, queue))
            await self._enqueue_playback(seq)
            return

        if isinstance(frame, EndFrame):
            for t in list(self._tasks.values()):
                t.cancel()
            self._tasks.clear()
            for t in list(self._play_tasks.values()):
                t.cancel()
            self._play_tasks.clear()
            self._play_order.clear()
            self._queues.clear()
            self._seq_text.clear()
            await self.push_downstream(frame)
            return

        await self.push_downstream(frame)

    async def _enqueue_playback(self, seq: int) -> None:
        """Queue the playback of `seq` behind everything requested before it."""
        async with self._play_lock:
            self._play_order.append(seq)
            task = asyncio.create_task(self._play(seq), name=f"tts-play-{seq}")
            self._play_tasks[seq] = task

    async def _play(self, seq: int) -> None:
        """Emit the audio of `seq`, but only once earlier sentences finished."""
        queue = self._queues.get(seq)
        if queue is None:
            return
        # Wait until it is this sentence's turn to be heard.
        while True:
            async with self._play_lock:
                if not self._play_order or self._play_order[0] == seq:
                    break
                await asyncio.sleep(0.01)
        try:
            await self._emit(seq, queue)
        finally:
            async with self._play_lock:
                if self._play_order and self._play_order[0] == seq:
                    self._play_order.pop(0)

    async def _emit(self, seq: int, queue: asyncio.Queue) -> None:
        text = self._seq_text.get(seq, "")
        await self.push_downstream(BotStartedSpeakingFrame(seq=seq, text=text))
        if self.worker:
            self._set_bot_speaking(True)
        first = True
        try:
            while True:
                item = await queue.get()
                if item is _EOS:
                    break
                if not isinstance(item, (bytes, bytearray, memoryview)):
                    continue
                data = bytes(item)
                if not data:
                    continue
                if first:
                    voice_playback_event(
                        "语音播放",
                        text,
                        extra=f"首包音频下发 seq={seq}（前端应开始播）",
                    )
                    if self.worker:
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
                await self.push_downstream(TTSAudioRawFrame(audio=data, seq=seq, format="mp3"))
        finally:
            voice_playback_event(
                "播放结束",
                text,
                extra=f"一句音频下发完毕 seq={seq}",
            )
            await self.push_downstream(BotStoppedSpeakingFrame(seq=seq, text=text))
            self._tasks.pop(seq, None)
            self._queues.pop(seq, None)
            self._play_tasks.pop(seq, None)
            self._seq_text.pop(seq, None)
            if not self._tasks and self.worker:
                self._set_bot_speaking(False)

    def _set_bot_speaking(self, active: bool) -> None:
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

    async def _synthesize(self, seq: int, text: str, queue: asyncio.Queue) -> None:
        from app.gateway.speech.tts_registry import synthesize_tts_stream

        t0 = time.perf_counter()
        first_chunk = True
        total = 0
        try:
            gen = synthesize_tts_stream(
                text,
                provider=self._provider,
                speaker=self._speaker,
            )
            async for chunk in gen:
                if not isinstance(chunk, (bytes, bytearray, memoryview)):
                    continue
                data = bytes(chunk)
                if not data:
                    continue
                total += len(data)
                if first_chunk:
                    ms = (time.perf_counter() - t0) * 1000
                    voice_playback_event(
                        "语音合成",
                        text,
                        extra=f"流式首包到达 seq={seq} ttfb={ms:.0f}ms",
                    )
                    first_chunk = False
                queue.put_nowait(data)
            ms_all = (time.perf_counter() - t0) * 1000
            voice_playback_event(
                "语音合成",
                text,
                extra=f"流式合成完成 seq={seq} bytes={total} cost={ms_all:.0f}ms",
            )
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.warning("tts synthesize failed seq=%s: %s", seq, e)
            voice_playback_event(
                "语音合成",
                text,
                extra=f"合成失败 seq={seq} err={e}",
            )
        finally:
            queue.put_nowait(_EOS)
