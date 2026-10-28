"""EvoFlow ASR providers as a Pipecat STTService.

Wraps ``create_asr_session`` (volcengine / dashscope / whisper) so recognition, mute, and
TTFB metrics reuse Pipecat's STT base class instead of a hand-rolled processor.

Volcengine streaming ASR times out if no PCM arrives (~数秒). We therefore:
  - send silence keepalive while STT is muted (TTS anti-echo), and
  - send silence keepalive while idle between utterances (mic quiet), and
  - rebuild the session immediately when it dies (critical for turn-2+).

Unmute hold: backend TTSStopped often fires while the FE is still playing.
``hold_unmute`` keeps STT muted until FE sends ``client_listening`` (or safety timeout).
"""

from __future__ import annotations

import asyncio
import time
from collections import deque
from collections.abc import AsyncGenerator
from typing import Any

from loguru import logger

from pipecat.frames.frames import (
    EndFrame,
    Frame,
    InputAudioRawFrame,
    InterimTranscriptionFrame,
    StartFrame,
    STTMuteFrame,
    TranscriptionFrame,
    VADUserStartedSpeakingFrame,
    VADUserStoppedSpeakingFrame,
)
from pipecat.processors.frame_processor import FrameDirection
from pipecat.services.settings import STTSettings
from pipecat.services.stt_service import STTService
from pipecat.transcriptions.language import Language
from pipecat.utils.time import time_now_iso8601

from app.gateway.speech.voice_file_log import voice_log

# 16kHz mono s16le · ~200ms ticks keep Volc ASR session warm
_KEEPALIVE_INTERVAL_S = 0.20
_KEEPALIVE_PCM = b"\x00" * (16000 * 2 // 5)  # 6400 bytes ≈ 200ms
# 距上一包真实/保活 PCM 超过该间隔就补静音（火山空闲约数秒就掐）
_IDLE_GAP_S = 0.18
# FE 播完才应 unmute；若 client_listening 丢失，最多卡住这么久。
# 旧值 8s：长回复多句串行本地播时常 >30s，超时强制 unmute → 麦收喇叭 → 卡顿/误 barge。
_UNMUTE_HOLD_SAFETY_S = 120.0
# mute 期环形缓冲：仅 barge 打断时回灌（抢话字头）。
# 正常 client_listening 放麦若回灌，缓冲里多是喇叭尾音 →「AI 最后一句被当作用户说」。
_MUTE_PCM_MAX_BYTES = 16000 * 2 * 2  # ≈2s


class EvoSTTService(STTService):
    """Streaming STT backed by EvoFlow ``asr_registry.create_asr_session``."""

    def __init__(
        self,
        *,
        provider: str = "volcengine",
        sample_rate: int = 16000,
        **kwargs,
    ) -> None:
        super().__init__(
            sample_rate=sample_rate,
            # SmartTurn / TurnAnalyzer 需要听见下游音频；passthrough 不影响 mute 丢识别
            audio_passthrough=True,
            settings=STTSettings(model=None, language=Language.ZH),
            **kwargs,
        )
        self._provider = (provider or "volcengine").strip().lower()
        self._session = None
        self._session_dead = False
        self._keepalive_task: asyncio.Task | None = None
        self._rebuild_task: asyncio.Task | None = None
        self._last_pcm_at = 0.0
        self._loop: asyncio.AbstractEventLoop | None = None
        # Hold unmute until FE finishes local playback (TTSStopped ≠ heard-done)
        self._hold_unmute = False
        self._pending_unmute = False
        self._unmute_hold_logged = False
        self._unmute_safety_task: asyncio.Task | None = None
        # mute 期间 Pipecat 会丢弃音频；自缓冲以便 unmute 回灌
        self._mute_pcm_buf: deque[bytes] = deque()
        self._mute_pcm_bytes = 0
        # 火山流式常只出 interim（definite 很晚/没有）→ SpeechTimeout 收不到
        # TranscriptionFrame._text，只能等 UserTurn 外层 5s 超时。落静音时把末次
        # interim 冲成 finalized，让 0.9s SpeechTimeout 能收口。
        self._last_interim_text = ""
        self._finalized_this_utt = False

    def set_provider(self, provider: str | None) -> None:
        if provider:
            self._provider = provider.strip().lower()

    async def start(self, frame: StartFrame):
        try:
            self._loop = asyncio.get_running_loop()
        except RuntimeError:
            self._loop = None
        await super().start(frame)
        await self._ensure_session()
        await self._ensure_keepalive()

    async def stop(self, frame: EndFrame):
        await self._cancel_unmute_safety()
        await self._stop_keepalive()
        await self._close_session()
        await super().stop(frame)

    async def cancel(self, frame):  # noqa: ANN001
        await self._cancel_unmute_safety()
        await self._stop_keepalive()
        await self._close_session()
        await super().cancel(frame)

    async def cleanup(self):
        await self._cancel_unmute_safety()
        await self._stop_keepalive()
        await self._close_session()
        await super().cleanup()

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        was_muted = self._muted
        # 用户又开口：允许下一轮 VAD-stop 再冲定稿
        if isinstance(frame, VADUserStartedSpeakingFrame):
            self._finalized_this_utt = False
        # 落静音：把末次 interim 冲成 finalized，供 SpeechTimeout 收口（勿等 5s 外层）
        if isinstance(frame, VADUserStoppedSpeakingFrame):
            await self._flush_interim_as_final(reason="vad_stop")
        # Intercept unmute while FE is still playing
        if isinstance(frame, STTMuteFrame) and not frame.mute and self._hold_unmute:
            self._pending_unmute = True
            if not self._unmute_hold_logged:
                self._unmute_hold_logged = True
                voice_log("管线", "STT unmute 请求已暂扣（等前端播完 / client_listening）")
            await self._ensure_unmute_safety()
            # Do not clear _muted; keep muted until FE listening.
            await self.push_frame(frame, direction)
            return

        await super().process_frame(frame, direction)

        if not isinstance(frame, STTMuteFrame):
            return

        if frame.mute and not was_muted:
            self._hold_unmute = True
            self._pending_unmute = False
            self._unmute_hold_logged = False
            await self._cancel_unmute_safety()
            voice_log("管线", "STT mute → 依赖静音保活（防火山 ASR 超时断线）")
            await self._ensure_keepalive()
        elif not frame.mute and was_muted:
            self._hold_unmute = False
            self._pending_unmute = False
            self._unmute_hold_logged = False
            await self._cancel_unmute_safety()
            # unmute 后若 mute 期间仍挂了，立刻重建，保证下一句能听
            if self._session_dead or not self._session:
                voice_log("管线", "STT unmute → 重建 ASR 会话（mute 期间已超时）")
                await self._close_session()
                await self._ensure_session()
            else:
                voice_log("管线", "STT unmute → ASR 会话仍存活（保活成功）")
            # TTSStopped 直通 unmute：缓冲里仍可能是播报尾音，默认丢弃
            self._discard_mute_pcm(reason="stt_mute_frame_off")
            await self._ensure_keepalive()

    async def release_unmute_hold(self, *, reason: str = "client_listening") -> None:
        """FE finished local playback — apply any pending unmute.

        If TTS is still flowing (no pending unmute yet), only clear the hold so
        the next real unmute from TTSStopped applies immediately.
        ``exit_listen`` / ``barge:`` may force unmute while still muted with no pending.
        """
        self._hold_unmute = False
        self._unmute_hold_logged = False
        await self._cancel_unmute_safety()
        reason_s = str(reason or "")
        is_barge = reason_s.startswith("barge:")
        force = (
            reason_s == "exit_listen"
            or reason_s.startswith("exit_listen")
            or is_barge
        )
        if not self._pending_unmute and not (force and self._muted):
            voice_log("管线", f"STT unmute hold 已清除 reason={reason_s}（无待处理 unmute）")
            # 已 unmuted 仍可能有缓冲：正常放麦丢弃；打断才回灌
            if not self._muted:
                if is_barge:
                    await self._flush_mute_pcm()
                else:
                    self._discard_mute_pcm(reason=reason_s or "client_listening")
            return
        was = self._muted
        self._muted = False
        self._pending_unmute = False
        voice_log("管线", f"STT unmute 已释放 reason={reason_s}{' force' if force else ''}")
        if was:
            if self._session_dead or not self._session:
                voice_log("管线", "STT unmute → 重建 ASR 会话（hold 期间已超时）")
                await self._close_session()
                await self._ensure_session()
            if is_barge:
                await self._flush_mute_pcm()
            else:
                # 播完放麦：丢弃 mute 窗 PCM（喇叭尾音），从干净麦开始听
                self._discard_mute_pcm(reason=reason_s or "client_listening")
            await self._ensure_keepalive()

    async def process_audio_frame(self, frame: InputAudioRawFrame, direction: FrameDirection):
        """Mute 时基类丢包；仅 pending_unmute 窗环形缓冲，供 barge 回灌字头。"""
        if self._muted and frame.audio:
            # 仅「TTS 已停、等前端播完」窗口缓冲——抢话字头在这儿；正常放麦会丢弃
            if self._pending_unmute:
                self._push_mute_pcm(frame.audio)
            return
        await super().process_audio_frame(frame, direction)

    def _push_mute_pcm(self, audio: bytes) -> None:
        if not audio:
            return
        self._mute_pcm_buf.append(audio)
        self._mute_pcm_bytes += len(audio)
        while self._mute_pcm_bytes > _MUTE_PCM_MAX_BYTES and self._mute_pcm_buf:
            old = self._mute_pcm_buf.popleft()
            self._mute_pcm_bytes -= len(old)

    def _clear_mute_pcm(self) -> None:
        self._mute_pcm_buf.clear()
        self._mute_pcm_bytes = 0

    def _discard_mute_pcm(self, *, reason: str = "") -> None:
        if not self._mute_pcm_buf:
            return
        n = self._mute_pcm_bytes
        self._clear_mute_pcm()
        ms = max(0, n // 32)  # 16kHz s16le → 32 bytes/ms
        voice_log(
            "管线",
            f"STT unmute → 丢弃 mute 期 PCM ≈{ms}ms（防回声进 ASR）"
            + (f" reason={reason}" if reason else ""),
        )

    async def _flush_mute_pcm(self) -> None:
        if not self._mute_pcm_buf:
            return
        n = self._mute_pcm_bytes
        chunks = list(self._mute_pcm_buf)
        self._clear_mute_pcm()
        if not self._session:
            return
        ms = max(0, n // 32)  # 16kHz s16le → 32 bytes/ms
        voice_log("管线", f"STT unmute → 回灌 mute 期 PCM ≈{ms}ms（打断保留字头）")
        for chunk in chunks:
            try:
                await self._session.send_pcm(chunk)
                self._last_pcm_at = time.monotonic()
            except Exception as e:
                logger.warning(f"{self} mute-pcm flush failed: {e}")
                voice_log("语音转文字", f"ASR 回灌失败，将重建会话：{e}")
                self._session_dead = True
                await self._close_session()
                self._schedule_rebuild()
                return

    async def flush_asr(self) -> None:
        if self._session:
            try:
                await self._session.flush()
            except Exception:
                pass

    async def run_stt(self, audio: bytes) -> AsyncGenerator[Frame | None, None]:
        if self._session_dead:
            await self._close_session()
        await self._ensure_session()
        await self._ensure_keepalive()
        if self._session and audio:
            try:
                await self._session.send_pcm(audio)
                self._last_pcm_at = time.monotonic()
            except Exception as e:
                logger.warning(f"{self} send_pcm failed: {e}")
                voice_log("语音转文字", f"ASR send_pcm 失败，将重建会话：{e}")
                self._session_dead = True
                await self._close_session()
                self._schedule_rebuild()
        yield None

    async def _ensure_keepalive(self) -> None:
        if self._keepalive_task and not self._keepalive_task.done():
            return
        self._keepalive_task = asyncio.create_task(
            self._keepalive_loop(), name="evo-asr-keepalive"
        )

    async def _stop_keepalive(self) -> None:
        task = self._keepalive_task
        self._keepalive_task = None
        if not task:
            return
        task.cancel()
        try:
            await task
        except (asyncio.CancelledError, Exception):
            pass

    async def _keepalive_loop(self) -> None:
        ticks = 0
        try:
            while True:
                await asyncio.sleep(_KEEPALIVE_INTERVAL_S)
                if self._session_dead or not self._session:
                    self._schedule_rebuild()
                    continue
                sess = self._session
                gap = time.monotonic() - (self._last_pcm_at or 0.0)
                # 有真实麦流在推就别抢；空闲 / mute（无麦包）时补静音
                if gap < _IDLE_GAP_S:
                    continue
                try:
                    await sess.send_pcm(_KEEPALIVE_PCM)
                    self._last_pcm_at = time.monotonic()
                    ticks += 1
                    if ticks == 1 or ticks % 50 == 0:
                        why = "mute" if self._muted else "idle"
                        voice_log(
                            "管线",
                            f"ASR {why} 保活已发 {ticks} 拍 silence≈{int(_KEEPALIVE_INTERVAL_S * 1000)}ms",
                        )
                except Exception as e:
                    logger.warning(f"{self} keepalive send failed: {e}")
                    self._session_dead = True
                    self._session = None
                    self._schedule_rebuild()
        except asyncio.CancelledError:
            return

    def _schedule_rebuild(self) -> None:
        if self._rebuild_task and not self._rebuild_task.done():
            return
        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        if running is not None:
            self._rebuild_task = running.create_task(
                self._rebuild_session(), name="evo-asr-rebuild"
            )
            return
        loop = self._loop
        if loop is not None and loop.is_running():

            def _done(fut: Any) -> None:  # noqa: ANN401
                try:
                    fut.result()
                except Exception:
                    pass

            fut = asyncio.run_coroutine_threadsafe(self._rebuild_session(), loop)
            fut.add_done_callback(_done)

    async def _rebuild_session(self) -> None:
        if self._session and not self._session_dead:
            return
        voice_log("管线", "ASR 会话已死 → 立即重建（保证下一轮能识别）")
        await self._close_session()
        await self._ensure_session()
        await self._ensure_keepalive()

    async def _ensure_unmute_safety(self) -> None:
        await self._cancel_unmute_safety()

        async def _safety() -> None:
            try:
                await asyncio.sleep(_UNMUTE_HOLD_SAFETY_S)
                if self._hold_unmute or self._pending_unmute:
                    voice_log(
                        "管线",
                        f"STT unmute 安全超时 {_UNMUTE_HOLD_SAFETY_S:.0f}s → 强制释放",
                    )
                    await self.release_unmute_hold(reason="unmute_safety_timeout")
            except asyncio.CancelledError:
                return

        self._unmute_safety_task = asyncio.create_task(
            _safety(), name="evo-asr-unmute-safety"
        )

    async def _cancel_unmute_safety(self) -> None:
        task = self._unmute_safety_task
        self._unmute_safety_task = None
        if not task:
            return
        task.cancel()
        try:
            await task
        except (asyncio.CancelledError, Exception):
            pass

    def _mark_session_dead(self, msg: str) -> None:
        self._session_dead = True
        self._session = None
        voice_log("语音转文字", f"ASR 错误 provider={self._provider}：{msg}")
        self._schedule_rebuild()

    async def _ensure_session(self) -> None:
        if self._session:
            return
        from app.gateway.speech.asr_registry import create_asr_session

        self._session_dead = False
        try:
            self._loop = asyncio.get_running_loop()
        except RuntimeError:
            pass

        async def on_transcript(text: str, is_final: bool, seg: str | None) -> None:
            if not text:
                return
            if is_final or len(text) >= 2:
                kind = "最终" if is_final else "中间"
                voice_log("语音转文字", f"ASR{kind}结果 provider={self._provider}：「{text}」")
            ts = time_now_iso8601()
            if is_final:
                self._last_interim_text = ""
                self._finalized_this_utt = True
                await self.push_frame(
                    TranscriptionFrame(
                        text=text,
                        user_id="user",
                        timestamp=ts,
                        language=Language.ZH,
                        result={"seg": seg} if seg else None,
                        finalized=True,
                    )
                )
                await self.stop_ttfb_metrics()
                await self.stop_processing_metrics()
            else:
                self._last_interim_text = text
                # VAD 后尾包：Interim 会清掉 SpeechTimeout 的 finalized 标志，直接再冲定稿
                if self._finalized_this_utt:
                    voice_log(
                        "语音转文字",
                        f"ASR落静音后尾包 → 再冲定稿 provider={self._provider}：「{text}」",
                    )
                    await self.push_frame(
                        TranscriptionFrame(
                            text=text,
                            user_id="user",
                            timestamp=ts,
                            language=Language.ZH,
                            result={"seg": seg or "vad-tail"},
                            finalized=True,
                        )
                    )
                else:
                    await self.push_frame(
                        InterimTranscriptionFrame(
                            text=text,
                            user_id="user",
                            timestamp=ts,
                            language=Language.ZH,
                            result={"seg": seg} if seg else None,
                        )
                    )

        def on_error(msg: str) -> None:
            # May be invoked without a running loop context — keep sync + schedule.
            logger.warning(f"{self} asr error: {msg}")
            try:
                loop = self._loop or asyncio.get_running_loop()
            except RuntimeError:
                loop = None
            if loop is not None and loop.is_running():
                loop.call_soon_threadsafe(self._mark_session_dead, str(msg))
            else:
                self._mark_session_dead(str(msg))

        async def on_error_async(msg: str) -> None:
            on_error(msg)

        try:
            self._session = await create_asr_session(
                self._provider,
                on_transcript=on_transcript,
                on_error=on_error_async,
            )
            await self._session.start()
            self._last_pcm_at = time.monotonic()
            voice_log("管线", f"ASR 会话已启动 provider={self._provider}")
            logger.info(f"{self} ASR session started provider={self._provider}")
            await self._ensure_keepalive()
        except Exception as e:
            logger.warning(f"{self} ASR session start failed ({self._provider}): {e}")
            voice_log("语音转文字", f"ASR 会话启动失败 provider={self._provider}：{e}")
            self._session = None
            self._session_dead = True

    async def _flush_interim_as_final(self, *, reason: str = "vad_stop") -> None:
        """落静音时把末次 interim 冲成 finalized TranscriptionFrame。

        火山流式多数只有中间结果；SpeechTimeout 只认 TranscriptionFrame 累积 ``_text``，
        没有 finalized 就会拖到 UserTurn 外层 5s 超时（日志里说完→turn_end≈5.3s）。
        """
        text = str(self._last_interim_text or "").strip()
        if not text or self._finalized_this_utt:
            return
        self._finalized_this_utt = True
        self._last_interim_text = ""
        voice_log(
            "语音转文字",
            f"ASR落静音冲定稿 reason={reason} provider={self._provider}：「{text}」",
        )
        await self.push_frame(
            TranscriptionFrame(
                text=text,
                user_id="user",
                timestamp=time_now_iso8601(),
                language=Language.ZH,
                result={"seg": "vad-flush"},
                finalized=True,
            )
        )
        try:
            await self.stop_ttfb_metrics()
            await self.stop_processing_metrics()
        except Exception:
            pass

    async def _close_session(self) -> None:
        sess = self._session
        self._session = None
        if not sess:
            return
        try:
            await sess.close()
        except Exception:
            pass
