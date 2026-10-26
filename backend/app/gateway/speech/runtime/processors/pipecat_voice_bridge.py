"""Full Pipecat voice runtime hosted inside our thin Frame session.

Pipeline (all Pipecat):
  VADProcessor(Silero) → EvoSTTService → UserTurnProcessor(SmartTurn|SpeechTimeout)
  → XiaomiHook → VolcengineTTSService → CaptureSink

Turn / latency follow Pipecat docs:
  - start: VADUserStartedSpeaking → UserStartedSpeaking (+ barge)
  - stop: SmartTurn (default) or SpeechTimeout; wait_for_transcript=True
  - latency: UserBotLatencyObserver (VAD stop − stop_secs → BotStartedSpeaking)

SpeechSession still speaks Evo frames on the wire (partial/final/tts_*/interrupted).
"""

from __future__ import annotations

import asyncio
import logging
import random
import re
import time
from collections.abc import Awaitable, Callable
from typing import Any

from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.vad.vad_analyzer import VADParams
from pipecat.frames.frames import (
    EndFrame as PipeEndFrame,
)
from pipecat.frames.frames import (
    BotStartedSpeakingFrame as PipeBotStartedSpeakingFrame,
    BotStoppedSpeakingFrame as PipeBotStoppedSpeakingFrame,
    InputAudioRawFrame,
    InterimTranscriptionFrame,
    InterruptionFrame as PipeInterruptionFrame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    LLMTextFrame as PipeLLMTextFrame,
    STTMuteFrame,
    TranscriptionFrame as PipeTranscriptionFrame,
    TTSAudioRawFrame as PipeTTSAudioRawFrame,
    TTSSpeakFrame as PipeTTSSpeakFrame,
    TTSStartedFrame,
    TTSStoppedFrame,
    UserStartedSpeakingFrame as PipeUserStartedSpeakingFrame,
    UserStoppedSpeakingFrame as PipeUserStoppedSpeakingFrame,
    VADUserStartedSpeakingFrame,
    VADUserStoppedSpeakingFrame,
)
from pipecat.observers.user_bot_latency_observer import UserBotLatencyObserver
from pipecat.pipeline.pipeline import Pipeline as PipePipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker as PipeWorker
from pipecat.processors.audio.vad_processor import VADProcessor
from pipecat.processors.frame_processor import FrameDirection as PipeDirection
from pipecat.processors.frame_processor import FrameProcessor as PipeFrameProcessor
from pipecat.turns.types import ProcessFrameResult
from pipecat.turns.user_start import VADUserTurnStartStrategy
from pipecat.turns.user_stop import SpeechTimeoutUserTurnStopStrategy
from pipecat.turns.user_turn_processor import UserTurnProcessor
from pipecat.turns.user_turn_strategies import UserTurnStrategies
from pipecat.workers.runner import WorkerRunner

from app.gateway.speech.runtime.aggregators import strip_markdown_light
from app.gateway.speech.runtime.frames import (
    AudioRawFrame,
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    EndFrame,
    Frame,
    InterruptionFrame,
    LLMResponseEndFrame,
    LLMTextFrame,
    StartFrame,
    TranscriptionFrame,
    TTSAudioRawFrame,
    TTSRequestFrame,
    TTSSpeakFrame,
    UserBotLatencyFrame,
    UserTurnCompleteFrame,
)
from app.gateway.speech.runtime.pipecat_volc_stt import EvoSTTService
from app.gateway.speech.runtime.pipecat_volc_tts import VolcengineTTSService
from app.gateway.speech.runtime.processor import FrameDirection, FrameProcessor
from app.gateway.speech.voice_file_log import voice_log, voice_playback_event

logger = logging.getLogger("evoflow.speech.pipecat_voice_bridge")

TurnHandler = Callable[[str], Awaitable[None]]

_READABLE = re.compile(r"[\w\u4e00-\u9fff]", re.UNICODE)
_ACK_POOL = ("好的", "嗯", "收到", "好的，稍等", "行", "好嘞")
# Pipecat 推荐默认；STT p99 表按 0.2 标定
_VAD_STOP_SECS = 0.2
_VAD_START_SECS = 0.2


def _has_readable(text: str) -> bool:
    return bool(_READABLE.search(text or ""))


def _norm_tts_cover(text: str) -> str:
    """Collapse whitespace for spoken-vs-plain coverage checks."""
    return re.sub(r"\s+", "", strip_markdown_light(text or ""))


def _plain_unspoken(plain: str, spoken_parts: list[str]) -> str | None:
    """Return text still missing from TTS this turn, or None if plain is covered.

    Ack short phrases are in spoken_parts but usually absent from plain; we
    match the longest spoken suffix that is a prefix of plain, then return the
    remainder. If nothing overlaps, return the full plain.
    """
    target = _norm_tts_cover(plain)
    if not target:
        return None
    spoken_norm = _norm_tts_cover("".join(spoken_parts or []))
    if not spoken_norm:
        return strip_markdown_light(plain).strip() or None
    if target in spoken_norm:
        return None
    # Longest suffix of spoken that is a prefix of target (ack + partial body)
    best = 0
    for i in range(len(spoken_norm)):
        suf = spoken_norm[i:]
        if target.startswith(suf) and len(suf) > best:
            best = len(suf)
    if best <= 0:
        return strip_markdown_light(plain).strip() or None
    # Map normalized prefix length back onto original plain (best-effort)
    kept = 0
    for idx, ch in enumerate(plain):
        if ch.isspace():
            continue
        kept += 1
        if kept >= best:
            rest = strip_markdown_light(plain[idx + 1 :]).strip()
            rest = rest.lstrip("，,、；; ")
            return rest or None
    return None


class _BotGatedVADStartStrategy(VADUserTurnStartStrategy):
    """VAD start，但 bot 仍在对用户出声时不打断（防喇叭回声自打断）。

    Pipecat 有 OutputTransport 的 BotStarted/Stopped；我们用 host._bot_audible
    （TTS 首包 → FE client_listening）等价。播报中语音打断请点 UI；播完后再听。
    """

    def __init__(self, host: PipecatVoiceBridge, **kwargs):
        super().__init__(**kwargs)
        self._host = host

    async def process_frame(self, frame):  # noqa: ANN001
        if isinstance(frame, VADUserStartedSpeakingFrame) and getattr(
            self._host, "_bot_audible", False
        ):
            voice_log("打断", "播报中忽略 VAD 开口（防回声自打断；点界面可手动打断）")
            return ProcessFrameResult.CONTINUE
        return await super().process_frame(frame)


def _build_user_turn_strategies(
    *, silence_s: float, host: PipecatVoiceBridge
) -> tuple[UserTurnStrategies, str]:
    """判停策略（对齐 Pipecat，按产品场景选型）。

    - 默认 **SpeechTimeout**：中文口语停顿多，SmartTurn 易「没说完就 COMPLETE」。
      ``user_speech_timeout`` ≈ 0.9s（Pipecat 文档常用 0.6；中文略放宽），
      且 ``wait_for_transcript=True``（没字不发）。
    - 可选 SmartTurn：环境变量 ``EVOFLOW_VOICE_SMART_TURN=1``（仍保留 transcript 门闩）。

    FilterIncomplete（LLM ●/◐ 门闩）需要 LLM 在 Pipecat 管线内，我们 LLM 在
    前端小V，无法直接套用；用更稳的 timeout + 语音路径 abort-then-send 代替。
    """
    import os

    start = [_BotGatedVADStartStrategy(host, enable_interruptions=True)]
    timeout_s = max(0.75, float(silence_s or 0.9))
    use_smart = (os.getenv("EVOFLOW_VOICE_SMART_TURN") or "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }
    if use_smart:
        try:
            from pipecat.audio.turn.smart_turn.local_smart_turn_v3 import LocalSmartTurnAnalyzerV3
            from pipecat.audio.turn.smart_turn.base_smart_turn import SmartTurnParams
            from pipecat.turns.user_stop import TurnAnalyzerUserTurnStopStrategy

            strategies = UserTurnStrategies(
                start=start,
                stop=[
                    TurnAnalyzerUserTurnStopStrategy(
                        turn_analyzer=LocalSmartTurnAnalyzerV3(
                            params=SmartTurnParams(stop_secs=max(3.0, timeout_s + 2.0)),
                        ),
                        wait_for_transcript=True,
                    )
                ],
            )
            return strategies, "SmartTurn-v3"
        except Exception as e:  # noqa: BLE001
            logger.warning("SmartTurn unavailable, fallback SpeechTimeout: %s", e)

    strategies = UserTurnStrategies(
        start=start,
        stop=[
            SpeechTimeoutUserTurnStopStrategy(
                user_speech_timeout=timeout_s,
                wait_for_transcript=True,
            )
        ],
    )
    return strategies, f"SpeechTimeout({timeout_s:.2f}s)"


class _CaptureSink(PipeFrameProcessor):
    """Forward selected Pipecat frames to the Evo host queue.

    Also emits Pipecat ``BotStartedSpeakingFrame`` (transport equivalent) so
    ``UserBotLatencyObserver`` can measure user-silence → bot-open. We have no
    OutputTransport; first TTSStarted ≈ wire opening.
    """

    def __init__(self, out_q: asyncio.Queue, host: PipecatVoiceBridge) -> None:
        super().__init__(enable_direct_mode=True, name="EvoVoiceSink")
        self._out_q = out_q
        self._host = host
        # 多句并发时 TTSStarted/Stopped 会交错；用深度避免 mute 抖动把 ASR 掐死。
        self._stt_mute_depth = 0
        self._bot_started_emitted = False

    async def _set_stt_mute(self, mute: bool, *, reason: str) -> None:
        if mute:
            self._stt_mute_depth += 1
            if self._stt_mute_depth == 1:
                voice_log("管线", f"TTS 开始 → STT mute（防回声） reason={reason}")
                await self.push_frame(STTMuteFrame(mute=True), PipeDirection.UPSTREAM)
        else:
            if self._stt_mute_depth <= 0:
                return
            self._stt_mute_depth -= 1
            if self._stt_mute_depth == 0:
                voice_log("管线", f"TTS 结束 → STT unmute reason={reason}")
                await self.push_frame(STTMuteFrame(mute=False), PipeDirection.UPSTREAM)

    async def process_frame(self, frame, direction):  # noqa: ANN001
        await super().process_frame(frame, direction)
        if direction == PipeDirection.DOWNSTREAM and isinstance(
            frame,
            (
                TTSStartedFrame,
                TTSStoppedFrame,
                PipeTTSAudioRawFrame,
                PipeTranscriptionFrame,
                InterimTranscriptionFrame,
                PipeUserStartedSpeakingFrame,
                PipeUserStoppedSpeakingFrame,
                VADUserStartedSpeakingFrame,
                VADUserStoppedSpeakingFrame,
                PipeInterruptionFrame,
            ),
        ):
            await self._out_q.put(frame)
        # Mute STT while TTS audio is flowing (avoid echo ASR / false barge).
        if direction == PipeDirection.DOWNSTREAM:
            if isinstance(frame, PipeInterruptionFrame):
                # 真打断（手动/播完后）：清 audible，允许下一轮
                self._host._bot_audible = False
                self._bot_started_emitted = False
                if self._stt_mute_depth > 0:
                    self._stt_mute_depth = 0
                    voice_log("打断", "Pipecat Interruption → STT unmute（清零 mute 深度）")
                    await self.push_frame(STTMuteFrame(mute=False), PipeDirection.UPSTREAM)
            elif isinstance(frame, TTSStartedFrame):
                self._host._bot_audible = True
                await self._set_stt_mute(True, reason="tts_start")
                # Pipecat latency observer anchors on BotStartedSpeakingFrame
                if not self._bot_started_emitted:
                    self._bot_started_emitted = True
                    await self.push_frame(PipeBotStartedSpeakingFrame(), direction)
            elif isinstance(frame, TTSStoppedFrame):
                await self._set_stt_mute(False, reason="tts_stop")
        await self.push_frame(frame, direction)


class _XiaomiHook(PipeFrameProcessor):
    """Turn-complete → FE callback + optional ack speak; tracks last transcript."""

    def __init__(
        self,
        *,
        on_user_turn: TurnHandler | None,
        auto_ack: bool,
        host: PipecatVoiceBridge,
    ) -> None:
        super().__init__(enable_direct_mode=True, name="XiaomiHook")
        self._on_user_turn = on_user_turn
        self._auto_ack = auto_ack
        self._host = host
        self._last_text = ""

    def set_turn_handler(self, handler: TurnHandler | None) -> None:
        self._on_user_turn = handler

    async def process_frame(self, frame, direction):  # noqa: ANN001
        await super().process_frame(frame, direction)
        if direction != PipeDirection.DOWNSTREAM:
            await self.push_frame(frame, direction)
            return

        if isinstance(frame, (PipeTranscriptionFrame, InterimTranscriptionFrame)):
            if frame.text:
                self._last_text = frame.text
            await self.push_frame(frame, direction)
            return

        # VAD 落静音锚点（Pipecat：timestamp − stop_secs）；正式 latency 由 Observer 算
        if isinstance(frame, VADUserStoppedSpeakingFrame):
            if self._host.worker:
                stop_secs = float(getattr(frame, "stop_secs", 0.0) or 0.0)
                # frame.timestamp 是 time.time()；worker metrics 用 monotonic，只存差值备用
                self._host.worker.metrics["vad_stop_secs"] = stop_secs
                self._host.worker.metrics["user_stopped_at"] = time.monotonic() - stop_secs
                self._host.worker.metrics["bot_first_audio_at"] = None
                self._host.worker.metrics["user_to_bot_emitted"] = False
            await self.push_frame(frame, direction)
            return

        if isinstance(frame, PipeUserStoppedSpeakingFrame):
            text = (self._last_text or "").strip()
            self._last_text = ""
            if text:
                self._host._ignore_assistant = False
                self._host._turn += 1
                turn = self._host._turn
                voice_log("对话", f"用户输入（完整）：「{text}」 turn={turn}")
                if self._auto_ack:
                    ack = random.choice(_ACK_POOL)
                    voice_log("播报", f"先播确认短句：「{ack}」")
                    await self.push_frame(PipeTTSSpeakFrame(text=ack))
                if self._on_user_turn:
                    try:
                        await self._on_user_turn(text)
                    except Exception as e:
                        logger.warning("on_user_turn failed: %s", e)
                # Surface turn text to Evo session (WS turn_end / final)
                await self._host._out_q.put(("user_turn", text, turn))
            else:
                # Stop 策略判完但 ASR 无字：常见于第二轮 ASR 已死 —— 必须打日志
                voice_log(
                    "对话",
                    "用户输入为空（ASR 可能已断/仍 mute）→ 本轮不发送",
                )
            await self.push_frame(frame, direction)
            return

        await self.push_frame(frame, direction)


class PipecatVoiceBridge(FrameProcessor):
    """Hosts the full Pipecat VAD→STT→Turn→TTS pipeline for Xiaomi voice."""

    def __init__(
        self,
        *,
        asr_provider: str | None = "volcengine",
        tts_provider: str | None = "volcengine",
        speaker: str | None = None,
        on_user_turn: TurnHandler | None = None,
        silence_ms: float = 900.0,
        auto_ack: bool = True,
    ) -> None:
        super().__init__(name="PipecatVoiceBridge")
        self._asr_provider = (asr_provider or "volcengine").strip().lower()
        self._tts_provider = (tts_provider or "volcengine").strip().lower()
        self._speaker = speaker
        self._on_user_turn = on_user_turn
        self._silence_s = max(0.2, float(silence_ms) / 1000.0)
        self._auto_ack = auto_ack

        self._stt: EvoSTTService | None = None
        self._tts: VolcengineTTSService | None = None
        self._hook: _XiaomiHook | None = None
        self._pipe_worker: PipeWorker | None = None
        self._runner: WorkerRunner | None = None
        self._runner_task: asyncio.Task[None] | None = None
        self._drain_task: asyncio.Task[None] | None = None
        self._out_q: asyncio.Queue[Any] = asyncio.Queue()
        self._started_evt = asyncio.Event()
        self._ready = False
        self._closing = False

        # Xiaomi bridge semantics (session_manager API)
        self._ignore_assistant = False
        self._turn = 0
        self._current_turn = 0
        self._min_turn = 0
        self._in_llm_turn = False
        self._seq_counter = 0
        self._ctx_seq: dict[str, int] = {}
        self._ctx_text: dict[str, str] = {}
        self._open_seqs: set[int] = set()
        self._last_stopped_at: float | None = None
        self._last_stopped_seq: int | None = None
        self._turn_mode = "unset"
        # True from first TTSStarted until FE client_listening / 真打断
        self._bot_audible = False
        self._assistant_plain = ""
        # 本轮是否已走进合成（on_tts_request）；用于 End 后兜底整段播报
        self._turn_tts_count = 0
        # 本轮已送去合成的文本（含确认短句）；End 后用覆盖检查补残句
        self._turn_spoken_texts: list[str] = []
        self._end_fallback_task: asyncio.Task[None] | None = None
        # FE VoicePhase：idle|listening|thinking|speaking（unmute/barge 门控）
        self._client_phase = "listening"
        # True：正文不流式分句，等 assistant_end 再整段 TTS（防残句少播）
        self._hold_body_tts_until_end = True

    # ── public API used by SpeechSession ───────────────────────────────

    @property
    def turn(self) -> int:
        return self._turn

    @property
    def client_phase(self) -> str:
        return self._client_phase or "listening"

    def set_client_phase(self, phase: str | None) -> None:
        p = (phase or "listening").strip().lower()
        if p not in ("idle", "listening", "thinking", "speaking"):
            p = "listening"
        prev = self._client_phase
        self._client_phase = p
        if prev != p:
            voice_log("决策", f"client_phase {prev} → {p}")

    def set_turn_handler(self, handler: TurnHandler | None = None) -> None:
        self._on_user_turn = handler
        if self._hook:
            self._hook.set_turn_handler(handler)

    async def begin_assistant_turn(self) -> None:
        self._ignore_assistant = False
        self._assistant_plain = ""
        self._turn_tts_count = 0
        self._turn_spoken_texts = []
        self._cancel_end_fallback()
        self._turn += 1
        # 上轮 End 与分句竞态时，残句会留在 aggregator，混进下一轮（日志：turn2 先合成「更细的…」）
        await self._close_llm_turn_and_drop_residual(reason="assistant_begin")

    async def inject_assistant_text(self, text: str) -> None:
        if self._ignore_assistant or not text:
            return
        self._assistant_plain = (self._assistant_plain or "") + text
        # 默认：只攒正文，等 End 整段播。流式分句曾在 End 竞态下少播尾句
        # （日志 19:01:44 只播到「飞书还开着呢」，丢了「你想让我点哪儿？」）。
        if self._hold_body_tts_until_end:
            return
        await self.queue_frame(
            LLMTextFrame(text=text, turn=self._turn), FrameDirection.DOWNSTREAM
        )

    async def inject_assistant_end(self) -> None:
        plain = (self._assistant_plain or "").strip()
        if plain:
            voice_log("对话", f"助手回复（完整）：「{plain[:800]}」" + ("…" if len(plain) > 800 else ""))
        elif self._ignore_assistant:
            voice_log("对话", "助手回复结束（本轮已打断/忽略，无正文）")
        else:
            voice_log("对话", "助手回复结束（空正文）")
        turn = self._turn
        if self._hold_body_tts_until_end:
            # 流式 delta 只攒字；End 时原子写入 Start+Text+End 到 Pipecat。
            # 勿经 Evo queue 拆成两帧：曾出现 Text 入管、End 见 _in_llm_turn=False
            # 被跳过 → 尾句卡缓冲，1s 兜底再灌一遍 = 多播半句（日志 19:29:28）。
            await self._close_llm_turn_and_drop_residual(reason="assistant_end_hold")
            if plain and _has_readable(plain) and not self._ignore_assistant:
                body = strip_markdown_light(plain)
                voice_log(
                    "分句",
                    f"正文齐 → 整段入分句管线 turn={turn}：「{body[:80]}」"
                    + ("…" if len(body) > 80 else ""),
                )
                await self._push_hold_body_to_tts(body)
                # hold 已保证 End 进管；勿再 coverage 补播（会与未完成的切句竞态重复）
            return
        await self.queue_frame(
            LLMResponseEndFrame(turn=turn), FrameDirection.DOWNSTREAM
        )
        # 禁止同步 flush aggregator（与 pipe 内 aggregate 竞态会截断）。
        # 若 EndFrame 因 _in_llm_turn 竞态未进 pipe / flush 空转，本轮会完全无合成
        # （日志 14:19：有完整正文却无「切出完整句」）。延迟兜底整段。
        if plain and _has_readable(plain) and not self._ignore_assistant:
            self._schedule_end_tts_fallback(plain, turn)

    async def _push_hold_body_to_tts(self, body: str) -> None:
        """Atomically feed one full assistant reply into Pipecat TTS aggregation."""
        await self._ensure_pipecat()
        if not self._pipe_worker or not self._ready:
            return
        self._in_llm_turn = True
        try:
            await self._pipe_worker.queue_frame(LLMFullResponseStartFrame())
            await self._pipe_worker.queue_frame(PipeLLMTextFrame(text=body))
            await self._pipe_worker.queue_frame(LLMFullResponseEndFrame())
        finally:
            self._in_llm_turn = False

    def _cancel_end_fallback(self) -> None:
        t = self._end_fallback_task
        self._end_fallback_task = None
        if t and not t.done():
            t.cancel()

    def _schedule_end_tts_fallback(self, plain: str, turn: int) -> None:
        """Streaming-mode only: if nothing body-sized was synthesized, push once."""
        self._cancel_end_fallback()

        async def _run() -> None:
            try:
                await asyncio.sleep(1.2)
                if self._ignore_assistant or turn != self._turn:
                    return
                if not self._pipe_worker or not self._ready:
                    return
                # 仅「完全没进正文合成」才兜底；勿按覆盖率补段（易与在途切句重复）
                body_hit = any(
                    len(_norm_tts_cover(t)) >= 8 for t in (self._turn_spoken_texts or [])
                )
                if body_hit:
                    return
                missing = strip_markdown_light(plain).strip()
                if not missing or not _has_readable(missing):
                    return
                voice_log(
                    "分句",
                    f"End 后仍无正文合成 → 兜底整段 turn={turn}：「{missing[:80]}」"
                    + ("…" if len(missing) > 80 else ""),
                )
                await self._push_hold_body_to_tts(missing)
            except asyncio.CancelledError:
                return
            except Exception:
                logger.exception("end TTS fallback failed")

        self._end_fallback_task = asyncio.create_task(_run())

    async def _close_llm_turn_and_drop_residual(self, *, reason: str) -> None:
        """Close dangling LLM turn and discard leftover aggregator text (no speak)."""
        if self._pipe_worker and self._ready and self._in_llm_turn:
            try:
                await self._pipe_worker.queue_frame(LLMFullResponseEndFrame())
            except Exception:
                logger.exception("failed to close LLM turn on %s", reason)
            self._in_llm_turn = False
        await self._drop_tts_residual(reason=reason)

    async def _drop_tts_residual(self, *, reason: str) -> None:
        agg = getattr(self._tts, "_text_aggregator", None) if self._tts else None
        if agg is None:
            return
        try:
            leftover = await agg.flush()
            text = (getattr(leftover, "text", None) or "").strip()
            if text:
                voice_log("分句", f"丢弃上轮残句 reason={reason}：「{text[:80]}」")
            await agg.reset()
        except Exception:
            logger.exception("failed to drop TTS residual on %s", reason)

    async def inject_speak(self, text: str, seq: int | None = None) -> None:
        if self._ignore_assistant:
            voice_log("打断", f"丢弃打断后迟到的直接播报：「{(text or '')[:48]}」")
            return
        await self.queue_frame(
            TTSSpeakFrame(text=text, seq=seq, turn=self._turn),
            FrameDirection.DOWNSTREAM,
        )

    async def flush_asr(self) -> None:
        if self._stt:
            await self._stt.flush_asr()

    async def release_stt_unmute_hold(self, *, reason: str = "client_listening") -> None:
        """FE local playback drained — allow STT to unmute for the next turn."""
        # 思考/播报相位：暂缓释放（FE 误发或 barge 附带 release 时）
        # 真打断 reason 以 barge: 开头仍放行，避免打断后永远哑麦
        phase = self._client_phase or "listening"
        is_barge_release = str(reason or "").startswith("barge:")
        if phase in ("thinking", "speaking") and not is_barge_release:
            voice_log(
                "决策",
                f"暂缓 unmute hold 释放 phase={phase} reason={reason}",
            )
            return
        was_audible = self._bot_audible
        self._bot_audible = False
        if self._stt and hasattr(self._stt, "release_unmute_hold"):
            await self._stt.release_unmute_hold(reason=reason)
        # 对齐 Pipecat OutputTransport：用户听完 ≈ BotStoppedSpeaking
        if was_audible and self._pipe_worker and self._ready:
            try:
                await self._pipe_worker.queue_frame(PipeBotStoppedSpeakingFrame())
            except Exception:
                pass
            voice_log("管线", f"BotStoppedSpeaking（{reason}）→ 可听下一轮")

    # ── lifecycle ──────────────────────────────────────────────────────

    async def start(self) -> None:
        await super().start()
        await self._ensure_pipecat()

    async def stop(self) -> None:
        await self._shutdown_pipecat()
        await super().stop()

    async def on_interruption(self, frame: Frame) -> None:
        self._ignore_assistant = True
        self._bot_audible = False
        self._turn += 1
        self._min_turn = max(int(self._min_turn or 0), int(self._current_turn or 0) + 1)
        self._in_llm_turn = False
        voice_log("打断", f"Pipecat Voice：抬高 min_turn={self._min_turn} turn={self._turn}")
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
            if frame.asr_provider:
                self._asr_provider = frame.asr_provider
            if frame.tts_provider:
                self._tts_provider = frame.tts_provider
            if frame.speaker:
                self._speaker = frame.speaker
            self._current_turn = 0
            self._min_turn = 0
            self._in_llm_turn = False
            self._ignore_assistant = False
            await self._ensure_pipecat()
            if self._stt:
                self._stt.set_provider(self._asr_provider)
            if self._tts:
                self._tts.set_provider(self._tts_provider)
                self._tts.set_speaker(self._speaker)
            await self.push_downstream(frame)
            return

        if isinstance(frame, InterruptionFrame):
            await self.push_downstream(frame)
            return

        if isinstance(frame, EndFrame):
            await self._shutdown_pipecat()
            await self.push_downstream(frame)
            return

        if isinstance(frame, AudioRawFrame):
            await self._ensure_pipecat()
            if self._pipe_worker and frame.audio:
                await self._pipe_worker.queue_frame(
                    InputAudioRawFrame(
                        audio=frame.audio,
                        sample_rate=int(frame.sample_rate or 16000),
                        num_channels=int(frame.num_channels or 1),
                    )
                )
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
            await self._ensure_pipecat()
            if self._pipe_worker and self._in_llm_turn:
                await self._pipe_worker.queue_frame(LLMFullResponseEndFrame())
            elif self._pipe_worker and not self._in_llm_turn:
                # Text 尚未 process 时 End 先到 → 旧逻辑丢 End，残句卡死；交由 inject 侧兜底播报
                voice_log(
                    "分句",
                    f"End 时 _in_llm_turn=False turn={turn} → 跳过 pipe End（等兜底整段播报）",
                )
            self._in_llm_turn = False
            return

        if isinstance(frame, (TTSSpeakFrame, TTSRequestFrame)):
            text = strip_markdown_light(getattr(frame, "text", "") or "")
            turn = int(getattr(frame, "turn", 0) or 0)
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

        vad = VADProcessor(
            vad_analyzer=SileroVADAnalyzer(
                sample_rate=16000,
                params=VADParams(
                    confidence=0.7,
                    start_secs=_VAD_START_SECS,
                    stop_secs=_VAD_STOP_SECS,
                    min_volume=0.35,
                ),
            )
        )
        self._stt = EvoSTTService(provider=self._asr_provider, sample_rate=16000)
        turn_strategies, turn_mode = _build_user_turn_strategies(
            silence_s=self._silence_s, host=self
        )
        # 外层兜底：旧值 max(5.0, …) 在火山只有 interim、SpeechTimeout 收不了口时
        # 硬等满 5s 才 turn_end（日志说完→定稿≈5.3s）。配合 STT vad_stop 冲定稿，
        # 正常路径走 0.9s SpeechTimeout；这里只作短兜底。
        turn = UserTurnProcessor(
            user_turn_strategies=turn_strategies,
            user_turn_stop_timeout=max(1.5, self._silence_s + 0.6),
        )
        self._hook = _XiaomiHook(
            on_user_turn=self._on_user_turn,
            auto_ack=self._auto_ack,
            host=self,
        )
        self._tts = VolcengineTTSService(
            provider=self._tts_provider, speaker=self._speaker
        )

        @self._tts.event_handler("on_tts_request")
        async def _on_tts_request(_svc, context_id: str, text: str):
            self._turn_tts_count += 1
            if text:
                self._turn_spoken_texts.append(str(text))
            # 仅当本轮正文已被覆盖时取消兜底；确认短句 on_tts 不应吃掉 End 补播
            plain_now = (self._assistant_plain or "").strip()
            if plain_now and _plain_unspoken(plain_now, self._turn_spoken_texts) is None:
                self._cancel_end_fallback()
            self._ctx_text[context_id] = text
            speaker = self._speaker or "(default)"
            # Pipecat 切句后进合成 — 对齐旧「分句」打点
            voice_log("分句", f"切出完整句 context={context_id}：「{text}」")
            voice_playback_event(
                "语音合成",
                text,
                extra=(
                    f"开始合成 context={context_id} provider={self._tts_provider} "
                    f"speaker={speaker}"
                ),
            )

        sink = _CaptureSink(self._out_q, host=self)
        pipeline = PipePipeline([vad, self._stt, turn, self._hook, self._tts, sink])

        latency_obs = UserBotLatencyObserver()

        @latency_obs.event_handler("on_latency_measured")
        async def _on_latency_measured(_obs, latency_seconds: float):
            ms = float(latency_seconds) * 1000.0
            voice_log("延迟", f"Pipecat 用户落静音→机器人开口 {ms:.0f} ms")
            if self.worker:
                now = time.monotonic()
                self.worker.metrics["bot_first_audio_at"] = now
                self.worker.metrics["user_stopped_at"] = now - float(latency_seconds)
                self.worker.metrics["user_to_bot_emitted"] = False
            await self._out_q.put(("latency", round(ms, 1)))

        @latency_obs.event_handler("on_latency_breakdown")
        async def _on_latency_breakdown(_obs, breakdown):
            try:
                lines = breakdown.turn_contribution_lines()
            except Exception:
                lines = []
            if lines:
                voice_log("延迟", "分解\n" + "\n".join(lines))

        self._pipe_worker = PipeWorker(
            pipeline,
            cancel_on_idle_timeout=False,
            idle_timeout_secs=None,
            enable_rtvi=False,
            enable_tracing=False,
            enable_turn_tracking=True,
            check_dangling_tasks=False,
            observers=[latency_obs],
            params=PipelineParams(
                enable_metrics=True,
                enable_usage_metrics=False,
                audio_in_sample_rate=16000,
                audio_out_sample_rate=24000,
            ),
            name="evo-voice",
        )

        @self._pipe_worker.event_handler("on_pipeline_started")
        async def _on_started(_worker, _frame):
            self._started_evt.set()

        self._runner = WorkerRunner(
            handle_sigint=False,
            handle_sigterm=False,
            check_dangling_tasks=False,
            name="evo-voice-runner",
        )
        await self._runner.add_workers(self._pipe_worker)
        self._runner_task = asyncio.create_task(
            self._runner.run(), name="evo-voice-runner-run"
        )
        self._drain_task = asyncio.create_task(self._drain_out(), name="evo-voice-drain")

        try:
            await asyncio.wait_for(self._started_evt.wait(), timeout=15.0)
        except TimeoutError:
            logger.error("Pipecat voice pipeline failed to start within 15s")
            await self._shutdown_pipecat()
            raise RuntimeError("Pipecat voice pipeline start timeout")
        self._ready = True
        self._turn_mode = turn_mode
        voice_log(
            "管线",
            f"Pipecat 语音管线就绪 Silero+STT+Turn({turn_mode})+TTS "
            f"ASR={self._asr_provider} TTS={self._tts_provider} "
            f"vad_stop={_VAD_STOP_SECS}s silence_fallback={self._silence_s:.2f}s",
        )
        logger.info(
            "Pipecat voice ready ASR=%s TTS=%s turn=%s vad_stop=%.2fs",
            self._asr_provider,
            self._tts_provider,
            turn_mode,
            _VAD_STOP_SECS,
        )

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
            self._stt = None
            self._tts = None
            self._hook = None
            self._closing = False
            self._ctx_seq.clear()
            self._ctx_text.clear()
            self._open_seqs.clear()
            self._last_stopped_at = None
            self._last_stopped_seq = None

    def _seq_for(self, context_id: str | None) -> int:
        cid = context_id or ""
        if cid not in self._ctx_seq:
            self._seq_counter += 1
            self._ctx_seq[cid] = self._seq_counter
        return self._ctx_seq[cid]

    async def _drain_out(self) -> None:
        try:
            while True:
                item = await self._out_q.get()
                try:
                    if isinstance(item, tuple) and item and item[0] == "user_turn":
                        _, text, _turn = item
                        await self.push_downstream(UserTurnCompleteFrame(text=text))
                        continue
                    if isinstance(item, tuple) and item and item[0] == "latency":
                        ms = float(item[1] or 0.0)
                        await self.push_downstream(
                            UserBotLatencyFrame(user_to_bot_ms=ms, source="pipecat")
                        )
                        continue
                    await self._emit_pipe_frame(item)
                except Exception:
                    logger.exception("failed to emit Pipecat frame to Evo pipeline")
        except asyncio.CancelledError:
            return

    async def _emit_pipe_frame(self, frame: Any) -> None:
        if isinstance(frame, VADUserStartedSpeakingFrame):
            voice_log("管线", "Silero VAD：用户开始说话")
            return

        if isinstance(frame, VADUserStoppedSpeakingFrame):
            stop_secs = float(getattr(frame, "stop_secs", 0.0) or 0.0)
            voice_log(
                "管线",
                f"Silero VAD：用户停止说话（stop_secs={stop_secs:.2f}s，"
                f"真实落静音≈判定前 {stop_secs:.2f}s）",
            )
            return

        if isinstance(frame, PipeUserStartedSpeakingFrame):
            voice_log("管线", "Turn：用户回合开始（可打断机器人）")
            return

        if isinstance(frame, PipeUserStoppedSpeakingFrame):
            # turn text 由 XiaomiHook 以 user_turn 元组另发；这里只记语义回合结束
            mode = getattr(self, "_turn_mode", "Turn")
            voice_log("管线", f"Turn：用户回合结束（stop={mode}，可发送）")
            return

        if isinstance(frame, PipeTranscriptionFrame):
            seg = None
            if isinstance(frame.result, dict):
                seg = frame.result.get("seg")
            await self.push_downstream(
                TranscriptionFrame(
                    text=frame.text or "",
                    is_final=bool(frame.finalized),
                    seg=seg,
                )
            )
            return

        if isinstance(frame, InterimTranscriptionFrame):
            seg = None
            if isinstance(frame.result, dict):
                seg = frame.result.get("seg")
            await self.push_downstream(
                TranscriptionFrame(text=frame.text or "", is_final=False, seg=seg)
            )
            return

        if isinstance(frame, PipeInterruptionFrame):
            # FE 相位门控：仅 speaking（或后端仍认为 bot 可听）才转发 VAD barge
            # 思考期转发会 abort 刚发出的模型 run（日志 18:10:21）
            phase = self._client_phase or "listening"
            if phase == "thinking" or (phase != "speaking" and not self._bot_audible):
                voice_log(
                    "打断",
                    f"抑制 VAD barge（phase={phase} bot_audible={self._bot_audible}）",
                )
                return
            voice_log("打断", "Pipecat 管线内打断（VAD barge-in）→ 通知前端停播")
            await self.push_downstream(InterruptionFrame(reason="vad_barge_in"))
            return

        if isinstance(frame, TTSStartedFrame):
            seq = self._seq_for(frame.context_id)
            text = self._ctx_text.get(frame.context_id or "", "")
            self._open_seqs.add(seq)
            handoff = ""
            if self._last_stopped_at is not None:
                gap_ms = (time.monotonic() - self._last_stopped_at) * 1000
                handoff = (
                    f" handoff_from_seq={self._last_stopped_seq} "
                    f"wire_gap={gap_ms:.0f}ms"
                )
            voice_playback_event(
                "语音播放",
                text,
                extra=(
                    f"首包音频下发 seq={seq} context={frame.context_id}"
                    f"（前端应开始播）{handoff}"
                ),
            )
            await self.push_downstream(BotStartedSpeakingFrame(seq=seq, text=text))
            return

        if isinstance(frame, PipeTTSAudioRawFrame):
            seq = self._seq_for(frame.context_id)
            text = self._ctx_text.get(frame.context_id or "", "")
            if seq not in self._open_seqs:
                self._open_seqs.add(seq)
                handoff = ""
                if self._last_stopped_at is not None:
                    gap_ms = (time.monotonic() - self._last_stopped_at) * 1000
                    handoff = (
                        f" handoff_from_seq={self._last_stopped_seq} "
                        f"wire_gap={gap_ms:.0f}ms"
                    )
                voice_playback_event(
                    "语音播放",
                    text,
                    extra=f"首包音频下发 seq={seq}（无 start，前端应开始播）{handoff}",
                )
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
            self._last_stopped_at = time.monotonic()
            self._last_stopped_seq = seq
            voice_playback_event(
                "播放结束",
                text,
                extra=f"一句音频下发完毕 seq={seq}",
            )
            await self.push_downstream(BotStoppedSpeakingFrame(seq=seq, text=text))
            return
