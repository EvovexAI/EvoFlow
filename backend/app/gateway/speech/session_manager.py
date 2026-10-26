"""Speech session — PipelineWorker host for Xiaomi Frame voice runtime.

Protocol (C→S / S→C):
  C→S {"type":"start","speaker":"...","asr_provider":"volcengine","tts_provider":"volcengine"}
  C→S binary PCM16LE @16kHz mono
  C→S {"type":"flush"} | {"type":"barge_in"} | {"type":"stop"}
  C→S {"type":"speak","seq":1,"text":"..."}          # legacy / imperative TTS
  C→S {"type":"assistant_begin","trace_id":"vt-…"}    # 开闸 + 本轮 TRACE
  C→S {"type":"assistant_delta","text":"..."}         # LLM tokens → SentenceAgg
  C→S {"type":"assistant_end"}
  S→C {"type":"ready","sid":"vs-…"}
  S→C {"type":"trace","trace_id":"vt-…","sid":"vs-…"}
  S→C {"type":"partial"|"final","text":"..."}
  S→C {"type":"turn_end","text":"..."}
  S→C {"type":"tts_start","seq":n,"text":"...","trace_id":"…"} → binary → tts_end
  S→C {"type":"interrupted"} | {"type":"error","message":"..."}
  S→C {"type":"metrics","user_to_bot_ms":...}
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect

from app.gateway.speech.runtime.frames import (
    AudioRawFrame,
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    Frame,
    InterruptionFrame,
    StartFrame,
    TranscriptionFrame,
    TTSAudioRawFrame,
    TTSSpeakFrame,
    UserBotLatencyFrame,
    UserTurnCompleteFrame,
)
from app.gateway.speech.runtime.worker import PipelineWorker
from app.gateway.speech.runtime.xiaomi_pipeline import build_xiaomi_voice_pipeline
from app.gateway.speech.voice_file_log import (
    new_voice_trace,
    set_voice_trace,
    voice_log,
    voice_log_path_today,
    voice_log_paths_today,
    voice_playback_event,
)
from app.gateway.speech.volcengine_speech import speech_configured

logger = logging.getLogger("evoflow.speech.session")


class SpeechSession:
    """WebSocket host that drives a Xiaomi Frame pipeline."""

    def __init__(self, ws: WebSocket) -> None:
        self._ws = ws
        self._worker: PipelineWorker | None = None
        self._bridge = None
        self._asr = None
        self._vad = None
        self._closing = False
        self._tts_open_seqs: set[int] = set()
        self._default_speaker: str | None = None
        self._asr_provider = "volcengine"
        self._tts_provider = "volcengine"
        self._last_barge_at = 0.0
        self._last_barge_reason = ""
        self._barge_suppressed = 0
        # vs-… 整段 Frame 连接；vt-… 一轮提问→播报（前后端共用）
        self._sid = new_voice_trace("vs")
        self._trace_id = self._sid

    def _bind_trace(self, trace_id: str | None = None) -> str:
        tid = str(trace_id or self._trace_id or "").strip()
        if tid:
            self._trace_id = tid
            set_voice_trace(tid)
        elif self._trace_id:
            set_voice_trace(self._trace_id)
        return self._trace_id or ""

    def _adopt_trace_from(self, data: dict[str, Any] | None) -> str:
        raw = ""
        if isinstance(data, dict):
            raw = str(data.get("trace_id") or data.get("trace") or "").strip()
        if raw:
            return self._bind_trace(raw)
        return self._bind_trace()

    async def _emit_user_to_bot_metric_once(self, ms: float | None = None) -> None:
        """用户落静音 → 机器人开口。优先用 Pipecat Observer 给出的 ms。"""
        if not self._worker:
            return
        m = self._worker.metrics
        if m.get("user_to_bot_emitted"):
            return
        if ms is None:
            u_stop = m.get("user_stopped_at")
            bot_at = m.get("bot_first_audio_at")
            if not u_stop or not bot_at:
                return
            ms = (bot_at - u_stop) * 1000
        m["user_to_bot_emitted"] = True
        voice_log("延迟", f"用户落静音→机器人开口约 {ms:.0f} ms")
        try:
            await self._ws.send_json(
                {
                    "type": "metrics",
                    "user_to_bot_ms": round(float(ms), 1),
                    "anchor": "vad_silence→bot_started",
                }
            )
        except Exception:
            pass

    async def run(self) -> None:
        await self._ws.accept()
        # Soft gate: allow whisper-only setups; warn if nothing for TTS later.
        try:
            self._bind_trace(self._sid)
            await self._ws.send_json(
                {"type": "ready", "runtime": "frame", "sid": self._sid, "trace_id": self._trace_id}
            )
            paths = voice_log_paths_today()
            voice_log(
                "会话",
                f"语音会话已就绪（Frame 运行时）SID={self._sid}，播报日志目录：{paths.get('dir')} "
                f"后端={voice_log_path_today('后端')} 前端={voice_log_path_today('前端')}",
            )
        except Exception:
            return

        try:
            while True:
                msg = await self._ws.receive()
                if msg.get("type") == "websocket.disconnect":
                    break
                if msg.get("bytes") is not None:
                    await self._on_pcm(bytes(msg["bytes"]))
                    continue
                text = msg.get("text")
                if not text:
                    continue
                try:
                    data: dict[str, Any] = json.loads(text)
                except Exception:
                    continue
                op = str(data.get("type") or "")
                if op == "start":
                    self._adopt_trace_from(data)
                    await self._on_start(data)
                elif op == "speak":
                    self._adopt_trace_from(data)
                    await self._on_speak(data)
                elif op == "assistant_begin":
                    await self._on_assistant_begin(data)
                elif op == "assistant_delta":
                    self._bind_trace()
                    await self._on_assistant_delta(data)
                elif op == "assistant_end":
                    self._bind_trace()
                    await self._on_assistant_end()
                elif op == "flush":
                    self._bind_trace()
                    if self._asr:
                        await self._asr.flush_asr()
                elif op == "cancel":
                    # legacy single-seq cancel — treat as soft barge for that path
                    pass
                elif op == "barge_in":
                    self._adopt_trace_from(data)
                    reason = str(data.get("reason") or "client_barge_in").strip() or "client_barge_in"
                    await self._on_barge_in(reason)
                elif op == "client_listening":
                    # FE 本地播完（队列空）→ 释放 STT unmute hold，下一轮才能识别
                    if self._bridge and hasattr(self._bridge, "release_stt_unmute_hold"):
                        await self._bridge.release_stt_unmute_hold(reason="client_listening")
                elif op == "stop":
                    break
        except WebSocketDisconnect:
            pass
        except Exception as e:  # noqa: BLE001
            logger.warning("speech session loop error: %s", e)
        finally:
            await self._close()

    async def _ensure_pipeline(self) -> None:
        if self._worker:
            return

        async def on_user_turn(text: str) -> None:
            # Client still owns Xiaomi agent; we only signal turn_end.
            # 用户说完即开新 TRACE（若前端稍后 assistant_begin 带自己的 id 会覆盖对齐）
            tid = new_voice_trace("vt")
            self._bind_trace(tid)
            voice_log("对话", f"用户输入 → turn_end：「{text}」 TRACE={tid}")
            try:
                await self._ws.send_json(
                    {"type": "turn_end", "text": text, "trace_id": tid, "sid": self._sid}
                )
            except Exception:
                pass

        pipe, bridge, asr, vad = build_xiaomi_voice_pipeline(
            asr_provider=self._asr_provider,
            tts_provider=self._tts_provider,
            speaker=self._default_speaker,
            on_user_turn=on_user_turn,
        )
        self._bridge = bridge
        self._asr = asr  # PipecatVoiceBridge (flush_asr)
        self._vad = vad  # None — Silero lives inside Pipecat
        self._worker = PipelineWorker(
            pipe,
            on_output=self._on_pipeline_output,
            idle_timeout_s=600.0,
        )
        await self._worker.start(
            StartFrame(
                asr_provider=self._asr_provider,
                tts_provider=self._tts_provider,
                speaker=self._default_speaker,
            )
        )
        voice_log(
            "管线",
            f"已启动小V语音管线 ASR={self._asr_provider} TTS={self._tts_provider}"
            + (f" 音色={self._default_speaker}" if self._default_speaker else ""),
        )

    async def _on_start(self, data: dict[str, Any]) -> None:
        from app.gateway.speech.volcengine_speech import DEFAULT_TTS_SPEAKER

        speaker = str(data.get("speaker") or "").strip()
        # 钉死音色：空则产品默认，保证同 session 多句同一 speaker
        self._default_speaker = speaker or DEFAULT_TTS_SPEAKER
        self._asr_provider = str(data.get("asr_provider") or self._asr_provider).strip() or "volcengine"
        self._tts_provider = str(data.get("tts_provider") or self._tts_provider).strip() or "volcengine"
        if self._tts_provider in {"volcengine", "doubao"} and not speech_configured():
            try:
                await self._ws.send_json(
                    {
                        "type": "error",
                        "message": "speech not configured — enable 火山 TTS in Settings → Models",
                        "needsConfig": True,
                    }
                )
            except Exception:
                pass
        # Rebuild pipeline if already running with new providers
        if self._worker:
            await self._worker.stop()
            self._worker = None
        await self._ensure_pipeline()

    async def _on_pcm(self, pcm: bytes) -> None:
        await self._ensure_pipeline()
        if self._worker:
            await self._worker.push(AudioRawFrame(audio=pcm, sample_rate=16000))

    async def _on_speak(self, data: dict[str, Any]) -> None:
        """Legacy imperative TTS — inject TTSSpeakFrame into the live pipeline."""
        await self._ensure_pipeline()
        text = str(data.get("text") or "").strip()
        seq = int(data.get("seq") or 0)
        if not text or not self._bridge:
            return
        speaker = str(data.get("speaker") or "").strip() or self._default_speaker
        if speaker and self._worker:
            # Update speaker on TTS station if present
            for p in self._worker.pipeline.processors:
                if hasattr(p, "_speaker"):
                    p._speaker = speaker
        await self._bridge.inject_speak(text, seq=seq or None)

    async def _on_assistant_begin(self, data: dict[str, Any] | None = None) -> None:
        await self._ensure_pipeline()
        raw = ""
        if isinstance(data, dict):
            raw = str(data.get("trace_id") or data.get("trace") or "").strip()
        tid = self._bind_trace(raw or new_voice_trace("vt"))
        if self._bridge:
            await self._bridge.begin_assistant_turn()
            voice_playback_event(
                "流式正文",
                "",
                extra=f"新一轮助手正文开闸 turn={self._bridge.turn}",
            )
            try:
                await self._ws.send_json(
                    {"type": "trace", "trace_id": tid, "sid": self._sid, "turn": self._bridge.turn}
                )
            except Exception:
                pass

    async def _on_assistant_delta(self, data: dict[str, Any]) -> None:
        await self._ensure_pipeline()
        text = str(data.get("text") or "")
        if self._bridge and text:
            voice_playback_event("流式正文", text, extra="模型流式片段")
            await self._bridge.inject_assistant_text(text)

    async def _on_assistant_end(self) -> None:
        await self._ensure_pipeline()
        if self._bridge:
            voice_playback_event("流式正文", "", extra="本轮正文流结束，冲刷残句去合成")
            await self._bridge.inject_assistant_end()

    async def _on_barge_in(self, reason: str = "barge_in") -> None:
        if not self._worker:
            return
        now = time.monotonic()
        # 前端 continuous 回声会在几十毫秒内连发 barge_in；合并为一次并记被吞次数
        if now - self._last_barge_at < 0.25 and reason == self._last_barge_reason:
            self._barge_suppressed += 1
            return
        if self._barge_suppressed:
            voice_log(
                "打断",
                f"合并了 {self._barge_suppressed} 次重复 barge_in（reason={self._last_barge_reason}）",
            )
            self._barge_suppressed = 0
        self._last_barge_at = now
        self._last_barge_reason = reason
        voice_log("打断", f"收到打断请求 reason={reason}，正在停播并清空可中断队列")
        t0 = time.monotonic()
        await self._worker.broadcast_interruption(reason)
        if self._bridge and hasattr(self._bridge, "release_stt_unmute_hold"):
            await self._bridge.release_stt_unmute_hold(reason=f"barge:{reason}")
        try:
            await self._ws.send_json(
                {
                    "type": "interrupted",
                    "reason": reason,
                    "cleared_ms": round((time.monotonic() - t0) * 1000, 1),
                }
            )
        except Exception:
            pass
        # Close any open tts seqs for client
        await self._close_open_tts_seqs()

    async def _close_open_tts_seqs(self) -> None:
        """Tell the client every open player is cancelled (used on interruption)."""
        for seq in list(self._tts_open_seqs):
            try:
                await self._ws.send_json(
                    {"type": "tts_end", "seq": seq, "bytes": 0, "cancelled": True}
                )
            except Exception:
                pass
        self._tts_open_seqs.clear()

    async def _on_pipeline_output(self, frame: Frame) -> None:
        self._bind_trace()
        try:
            if isinstance(frame, TranscriptionFrame):
                kind = "最终" if frame.is_final else "中间"
                # partial 太密：只记最终 + 较长中间结果
                if frame.is_final or len(frame.text or "") >= 4:
                    voice_log("语音转文字", f"ASR{kind}结果：「{frame.text}」")
                await self._ws.send_json(
                    {
                        "type": "final" if frame.is_final else "partial",
                        "text": frame.text,
                        "is_final": frame.is_final,
                        "seg": frame.seg,
                    }
                )
                return
            if isinstance(frame, UserTurnCompleteFrame):
                # turn_end already sent from on_user_turn; also emit final for UI
                await self._ws.send_json(
                    {"type": "final", "text": frame.text, "is_final": True, "turn": True}
                )
                return
            if isinstance(frame, UserBotLatencyFrame):
                # Pipecat UserBotLatencyObserver 权威值
                await self._emit_user_to_bot_metric_once(ms=float(frame.user_to_bot_ms))
                return
            if isinstance(frame, BotStartedSpeakingFrame):
                self._tts_open_seqs.add(frame.seq)
                text = getattr(frame, "text", "") or ""
                await self._ws.send_json(
                    {
                        "type": "tts_start",
                        "seq": frame.seq,
                        "text": text,
                        "trace_id": self._trace_id,
                    }
                )
                # fallback：Observer 未触发时仍用 worker.metrics
                await self._emit_user_to_bot_metric_once()
                return
            if isinstance(frame, TTSAudioRawFrame):
                if frame.seq not in self._tts_open_seqs:
                    self._tts_open_seqs.add(frame.seq)
                    await self._ws.send_json(
                        {
                            "type": "tts_start",
                            "seq": frame.seq,
                            "text": "",
                            "trace_id": self._trace_id,
                        }
                    )
                packet = int(frame.seq).to_bytes(4, "little") + frame.audio
                await self._ws.send_bytes(packet)
                await self._emit_user_to_bot_metric_once()
                return
            if isinstance(frame, BotStoppedSpeakingFrame):
                self._tts_open_seqs.discard(frame.seq)
                text = getattr(frame, "text", "") or ""
                await self._ws.send_json(
                    {
                        "type": "tts_end",
                        "seq": frame.seq,
                        "text": text,
                        "trace_id": self._trace_id,
                    }
                )
                return
            if isinstance(frame, InterruptionFrame):
                # VAD 等管线内部触发的打断也要通知前端停播（Pipecat 里由
                # OutputTransport 停止写音频；我们前端自己持有播放队列）。
                reason = str(getattr(frame, "reason", "") or "interruption")
                if reason != "client_barge_in":
                    voice_log("打断", f"管线内触发打断 reason={reason}，通知前端停播")
                    try:
                        await self._ws.send_json(
                            {
                                "type": "interrupted",
                                "reason": reason,
                                "cleared_ms": 0,
                            }
                        )
                    except Exception:
                        pass
                    # 关闭前端还开着的播放器，避免残句卡在播放队列里。
                    await self._close_open_tts_seqs()
                return
        except Exception as e:
            logger.debug("pipeline output send failed: %s", e)

    async def _close(self) -> None:
        if self._closing:
            return
        self._closing = True
        if self._worker:
            try:
                await self._worker.stop()
            except Exception:
                pass
            self._worker = None
