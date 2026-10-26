"""Speech session — PipelineWorker host for Xiaomi Frame voice runtime.

Protocol (C→S / S→C):
  C→S {"type":"start","speaker":"...","asr_provider":"volcengine","tts_provider":"volcengine"}
  C→S binary PCM16LE @16kHz mono
  C→S {"type":"flush"} | {"type":"barge_in"} | {"type":"stop"}
  C→S {"type":"speak","seq":1,"text":"..."}          # legacy / imperative TTS
  C→S {"type":"assistant_delta","text":"..."}         # LLM tokens → SentenceAgg
  C→S {"type":"assistant_end"}
  S→C {"type":"ready"}
  S→C {"type":"partial"|"final","text":"..."}
  S→C {"type":"turn_end","text":"..."}
  S→C {"type":"tts_start","seq":n} → <binary 4B-seq+mp3>… → {"type":"tts_end","seq":n}
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
    UserTurnCompleteFrame,
)
from app.gateway.speech.runtime.worker import PipelineWorker
from app.gateway.speech.runtime.xiaomi_pipeline import build_xiaomi_voice_pipeline
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

    async def run(self) -> None:
        await self._ws.accept()
        # Soft gate: allow whisper-only setups; warn if nothing for TTS later.
        try:
            await self._ws.send_json({"type": "ready", "runtime": "frame"})
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
                    await self._on_start(data)
                elif op == "speak":
                    await self._on_speak(data)
                elif op == "assistant_delta":
                    await self._on_assistant_delta(data)
                elif op == "assistant_end":
                    await self._on_assistant_end()
                elif op == "flush":
                    if self._asr:
                        await self._asr.flush_asr()
                elif op == "cancel":
                    # legacy single-seq cancel — treat as soft barge for that path
                    pass
                elif op == "barge_in":
                    await self._on_barge_in("client_barge_in")
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
            try:
                await self._ws.send_json({"type": "turn_end", "text": text})
            except Exception:
                pass

        pipe, bridge, asr, vad = build_xiaomi_voice_pipeline(
            asr_provider=self._asr_provider,
            tts_provider=self._tts_provider,
            speaker=self._default_speaker,
            on_user_turn=on_user_turn,
        )
        self._bridge = bridge
        self._asr = asr
        self._vad = vad
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

    async def _on_start(self, data: dict[str, Any]) -> None:
        speaker = str(data.get("speaker") or "").strip()
        self._default_speaker = speaker or None
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

    async def _on_assistant_delta(self, data: dict[str, Any]) -> None:
        await self._ensure_pipeline()
        text = str(data.get("text") or "")
        if self._bridge and text:
            await self._bridge.inject_assistant_text(text)

    async def _on_assistant_end(self) -> None:
        await self._ensure_pipeline()
        if self._bridge:
            await self._bridge.inject_assistant_end()

    async def _on_barge_in(self, reason: str = "barge_in") -> None:
        if not self._worker:
            return
        t0 = time.monotonic()
        await self._worker.broadcast_interruption(reason)
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
        for seq in list(self._tts_open_seqs):
            try:
                await self._ws.send_json(
                    {"type": "tts_end", "seq": seq, "bytes": 0, "cancelled": True}
                )
            except Exception:
                pass
        self._tts_open_seqs.clear()

    async def _on_pipeline_output(self, frame: Frame) -> None:
        try:
            if isinstance(frame, TranscriptionFrame):
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
            if isinstance(frame, BotStartedSpeakingFrame):
                self._tts_open_seqs.add(frame.seq)
                await self._ws.send_json({"type": "tts_start", "seq": frame.seq})
                return
            if isinstance(frame, TTSAudioRawFrame):
                if frame.seq not in self._tts_open_seqs:
                    self._tts_open_seqs.add(frame.seq)
                    await self._ws.send_json({"type": "tts_start", "seq": frame.seq})
                packet = int(frame.seq).to_bytes(4, "little") + frame.audio
                await self._ws.send_bytes(packet)
                return
            if isinstance(frame, BotStoppedSpeakingFrame):
                self._tts_open_seqs.discard(frame.seq)
                await self._ws.send_json({"type": "tts_end", "seq": frame.seq})
                # Emit TTFB metric once per reply if available
                if self._worker:
                    m = self._worker.metrics
                    if m.get("user_stopped_at") and m.get("bot_first_audio_at"):
                        ms = (m["bot_first_audio_at"] - m["user_stopped_at"]) * 1000
                        await self._ws.send_json(
                            {"type": "metrics", "user_to_bot_ms": round(ms, 1)}
                        )
                return
            if isinstance(frame, InterruptionFrame):
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
