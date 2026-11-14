from __future__ import annotations

import asyncio
import hashlib
import logging

from fastapi import APIRouter, File, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field

from app.gateway.speech.volcengine_asr_stream import run_asr_stream_proxy
from app.gateway.speech.volcengine_speech import (
    get_asr_stream_credentials,
    speech_configured,
    speech_streaming_asr_available,
    synthesize_speech_v3,
    synthesize_speech_v3_stream,
    transcribe_audio_flash,
)
from app.gateway.speech.whisper_manager import is_available as whisper_available

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/speech", tags=["speech"])


class SpeechStatusResponse(BaseModel):
    configured: bool = False
    streaming_asr: bool = False
    local_asr: bool = False
    wake_word: bool = False
    runtime: str = "frame"
    default_asr: str = "volcengine"
    default_tts: str = "volcengine"


class SpeechAsrResponse(BaseModel):
    text: str = ""


class SpeechTtsRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=4000)
    speaker: str | None = Field(default=None, max_length=256)
    preview: bool = False
    # TTS provider id. None / "volcengine" keeps backward-compatible behavior.
    # Supported: volcengine | doubao | dashscope | openai | elevenlabs | minimax
    provider: str | None = None
    # 与前端语音播报日志对齐的 TRACE（一轮提问→播报）
    trace_id: str | None = Field(default=None, max_length=64)
    # 火山 audio_params.speech_rate（-50..100）；显式传入时覆盖默认，不叠 emotion
    speech_rate: int | None = Field(default=None, ge=-50, le=100)


@router.get("/status", response_model=SpeechStatusResponse)
async def get_speech_status() -> SpeechStatusResponse:
    return SpeechStatusResponse(
        configured=speech_configured(),
        streaming_asr=speech_streaming_asr_available(),
        local_asr=whisper_available(),
        runtime="frame",
        default_asr="volcengine",
        default_tts="volcengine",
    )


@router.get("/health")
async def get_speech_health() -> dict:
    """语音链路启动自检（企业级：坏了要能被知道，而不是静默降级数周）。

    探测四件套：TTS 凭据 / ASR 凭据 / Frame 运行时依赖（pipecat+onnxruntime）/
    本地兜底 whisper。全部只读轻量检查（find_spec 不触发重 import）。
    """
    from importlib.util import find_spec

    from app.gateway.speech.asr_registry import validate_asr_config
    from app.gateway.speech.tts_registry import validate_tts_config

    try:
        tts = validate_tts_config("volcengine")
    except Exception as e:  # noqa: BLE001
        tts = {"ok": False, "guide": f"validate_tts_config error: {e}"}
    try:
        asr = validate_asr_config("volcengine")
    except Exception as e:  # noqa: BLE001
        asr = {"ok": False, "guide": f"validate_asr_config error: {e}"}

    deps: dict[str, bool] = {}
    for mod in ("pipecat", "onnxruntime"):
        try:
            deps[mod] = find_spec(mod) is not None
        except Exception:  # noqa: BLE001
            deps[mod] = False

    degraded: list[str] = []
    if not tts.get("ok"):
        degraded.append("tts_credentials")
    if not asr.get("ok"):
        degraded.append("asr_credentials")
    if not deps.get("pipecat"):
        degraded.append("pipecat_missing")
    if not deps.get("onnxruntime"):
        degraded.append("onnxruntime_missing")

    return {
        "ok": not degraded,
        "degraded": degraded,
        "tts": {"ok": bool(tts.get("ok")), "guide": tts.get("guide") or ""},
        "asr": {"ok": bool(asr.get("ok")), "guide": asr.get("guide") or ""},
        "runtime_deps": deps,
        "local_asr": whisper_available(),
    }


@router.get("/asr/providers")
async def speech_asr_providers() -> dict:
    """ASR provider catalog for Xiaomi voice settings."""
    from app.gateway.speech.asr_registry import list_asr_providers

    return {
        "providers": list_asr_providers(),
        "defaults": {"provider": "volcengine"},
    }


@router.get("/asr/validate")
async def speech_asr_validate(provider: str | None = None) -> dict:
    from app.gateway.speech.asr_registry import validate_asr_config

    return validate_asr_config(provider)


class SpeechLogEntry(BaseModel):
    stage: str = Field(default="前端", max_length=64)
    message: str = Field(..., min_length=1, max_length=2000)
    source: str | None = Field(default=None, max_length=32)
    detail: str | None = Field(default=None, max_length=1000)
    ts: str | None = None
    trace: str | None = Field(default=None, max_length=64)


class SpeechLogBatch(BaseModel):
    source: str = Field(default="前端", max_length=32)
    entries: list[SpeechLogEntry] = Field(default_factory=list)


@router.get("/log/path")
async def speech_log_path() -> dict:
    """Where Xiaomi voice-playback logs are written today (语音播报/前端|后端)."""
    from app.gateway.speech.voice_file_log import voice_log_path_today, voice_log_paths_today

    paths = voice_log_paths_today()
    fe = voice_log_path_today("前端")
    be = voice_log_path_today("后端")
    return {
        "ok": True,
        "dir": paths.get("dir"),
        "path": str(be),
        "frontend": str(fe),
        "backend": str(be),
        "exists": be.is_file() or fe.is_file(),
    }


@router.get("/playback/recent")
async def speech_playback_recent(limit: int = 50) -> dict:
    """Recent TTS utterances (memory ring + SQLite sidecar)."""
    from app.gateway.speech.playback_ledger import query_recent
    from app.gateway.speech.playback_store import voice_playback_db_path

    n = max(1, min(int(limit or 50), 200))
    rows = query_recent(limit=n)
    return {
        "ok": True,
        "count": len(rows),
        "items": rows,
        "db": str(voice_playback_db_path()),
    }


@router.get("/thinking-debug")
async def speech_thinking_debug(limit: int = 12, model: str = "") -> dict:
    """Voice HUD: is thinking-off guard loaded + last wire snapshots.

    Distinguishes UI phase「处理中」from real model reasoning (wire enable_thinking).
    Optional ``model=`` resolves catalog row (display name / default_mode / can disable).
    """
    from evoflow.observability.thinking_wire_ring import recent_thinking_wire, thinking_fix_probe

    probe = thinking_fix_probe()
    items = recent_thinking_wire(limit=max(1, min(int(limit or 12), 24)))
    last = items[0] if items else None
    # Heuristic: off when runtime_enabled is False AND wire not explicitly on
    wire_on = None
    if isinstance(last, dict):
        et = last.get("wire_enable_thinking")
        tt = str(last.get("wire_thinking_type") or "").strip().lower()
        re = str(last.get("wire_reasoning_effort") or "").strip().lower()
        if et is False or tt in ("disabled", "none", "off"):
            wire_on = False
        elif et is True or tt in ("enabled", "auto", "dynamic") or re in ("low", "medium", "high", "xhigh"):
            wire_on = True
        elif last.get("runtime_enabled") is False:
            wire_on = False

    model_id = str(model or "").strip()
    if not model_id and isinstance(last, dict):
        model_id = str(last.get("model") or "").strip()
    model_info: dict = {}
    if model_id:
        try:
            from evoflow.config.app_config import get_app_config
            from evoflow.models.factory import resolve_model_default_thinking_mode

            cfg = get_app_config().get_model_config(model_id)
            if cfg is None:
                # wire may log vendor model id (qwen3.8-flash); try match by .model field
                for m in get_app_config().models or []:
                    if str(getattr(m, "model", "") or "").strip() == model_id or str(
                        getattr(m, "name", "") or ""
                    ).strip() == model_id:
                        cfg = m
                        break
            if cfg is not None:
                mode = resolve_model_default_thinking_mode(cfg)
                model_info = {
                    "id": str(getattr(cfg, "name", "") or model_id),
                    "vendor_model": str(getattr(cfg, "model", "") or ""),
                    "display_name": str(getattr(cfg, "display_name", "") or getattr(cfg, "name", "") or model_id),
                    "vendor": str(getattr(cfg, "vendor", "") or ""),
                    "supports_thinking": bool(getattr(cfg, "supports_thinking", False)),
                    "thinking_default_mode": mode,
                    # GLM-5.3 等：default_mode=enabled → 厂商拒绝关思考
                    "thinking_always_on": mode == "enabled",
                    "can_disable_thinking": bool(getattr(cfg, "supports_thinking", False)) and mode != "enabled",
                }
        except Exception as e:  # noqa: BLE001
            model_info = {"id": model_id, "error": str(e)}

    note = "舞台「生成中」= 等模型出字，不等于设置里的「思考模式」"
    if model_info.get("thinking_always_on"):
        note = (
            f"当前模型 {model_info.get('display_name') or model_id} 默认强制开思考"
            "（default_mode=enabled，厂商通常拒绝关闭）——语音关思考对此模型无效，请换可关思考的模型"
        )

    return {
        "ok": True,
        "probe": probe,
        "last": last,
        "items": items,
        "model_thinking_on": wire_on,
        "model": model_info or None,
        "ui_note": note,
    }


@router.get("/playback/by-trace")
async def speech_playback_by_trace(trace: str = "", limit: int = 100) -> dict:
    """Utterances for one TRACE (vt-…)."""
    from app.gateway.speech.playback_ledger import query_by_trace

    tid = str(trace or "").strip()
    if not tid:
        raise HTTPException(status_code=400, detail="trace required")
    rows = query_by_trace(tid, limit=max(1, min(int(limit or 100), 500)))
    return {"ok": True, "trace_id": tid, "count": len(rows), "items": rows}


class PlaybackNoteRequest(BaseModel):
    """FE fixed-sfx / offline play lifecycle → utterance ledger."""

    phase: str = Field(..., min_length=1, max_length=32)
    text: str = Field(default="", max_length=2000)
    source: str = Field(default="fixed_sfx", max_length=32)
    trace_id: str | None = Field(default=None, max_length=64)
    seq: int = 0
    utterance_id: str | None = Field(default=None, max_length=180)
    play_token: str | None = Field(default=None, max_length=64)
    speaker: str = Field(default="", max_length=256)
    provider: str = Field(default="", max_length=64)
    duration_ms: int = 0
    bytes: int = 0
    error: str = Field(default="", max_length=500)


@router.post("/playback/note")
async def speech_playback_note(body: PlaybackNoteRequest) -> dict:
    """Best-effort ledger note (fixed_sfx wake/stop/farewell; does not block play)."""
    from app.gateway.speech.playback_ledger import note_client_event

    uid = note_client_event(
        phase=body.phase,
        text=body.text or "",
        trace_id=str(body.trace_id or ""),
        seq=int(body.seq or 0),
        source=str(body.source or "fixed_sfx"),
        speaker=body.speaker or "",
        provider=body.provider or "",
        duration_ms=int(body.duration_ms or 0),
        bytes_n=int(body.bytes or 0),
        error=body.error or "",
        utterance_id=str(body.utterance_id or ""),
        play_token=str(body.play_token or ""),
    )
    return {"ok": True, "utterance_id": uid}


@router.post("/log")
async def speech_log_append(batch: SpeechLogBatch) -> dict:
    """Frontend appends lines into 语音播报/前端-*.log.

    Best-effort debug sink: queue disk IO and return immediately. Awaiting
    ``to_thread`` still occupied DATA-lane slots for ~3s under load
    (2026-11-10 12:55 gateway-slow speech/log), delaying subscribe/messages.
    """
    from app.gateway.speech.voice_file_log import voice_log_batch

    entries = [e.model_dump() for e in (batch.entries or [])]
    source = str(batch.source or "前端")
    n = len(entries)
    if n <= 0:
        return {"ok": True, "count": 0, "queued": False}

    async def _write() -> None:
        try:
            await asyncio.to_thread(voice_log_batch, entries, default_source=source)
        except Exception:
            logger.debug("speech_log_append background write failed", exc_info=True)

    try:
        asyncio.get_running_loop().create_task(_write(), name="speech-log-write")
    except RuntimeError:
        try:
            voice_log_batch(entries, default_source=source)
        except Exception:
            return {"ok": False, "count": 0, "error": "log_write_failed"}
        return {"ok": True, "count": n, "queued": False}
    return {"ok": True, "count": n, "queued": True}


@router.websocket("/asr/stream")
async def speech_asr_stream(ws: WebSocket) -> None:
    await ws.accept()

    # Priority 1: Volcengine cloud ASR
    if speech_streaming_asr_available():
        try:
            await ws.send_json({"type": "ready"})
            api_key, resource_id, upstream_url = get_asr_stream_credentials()
            await run_asr_stream_proxy(
                ws,
                api_key=api_key,
                resource_id=resource_id,
                ws_url=upstream_url,
            )
            return
        except WebSocketDisconnect:
            return
        except Exception:
            # Cloud ASR failed → silently fall through to local
            pass

    # Priority 2: Local Whisper ASR (auto-starts if binary exists)
    if whisper_available():
        await ws.send_json({"type": "ready"})
        try:
            await _run_local_asr_proxy(ws)
            return
        except WebSocketDisconnect:
            return
        except Exception as e:
            try:
                await ws.send_json({"type": "error", "message": f"Local ASR error: {e}"})
            except Exception:
                pass
            return

    # Nothing available
    await ws.close(code=1013, reason="No ASR available — configure Volcengine or install openai-whisper")
    return


@router.post("/asr", response_model=SpeechAsrResponse)
async def speech_asr(audio: UploadFile = File(...)) -> SpeechAsrResponse:
    if not speech_configured():
        raise HTTPException(status_code=503, detail="Speech not configured. Enable 火山 TTS in Settings → Models.")
    try:
        data = await audio.read()
        if not data:
            raise HTTPException(status_code=400, detail="Empty audio upload")
        fmt = "wav"
        if audio.content_type:
            if "webm" in audio.content_type:
                fmt = "webm"
            elif "mpeg" in audio.content_type or "mp3" in audio.content_type:
                fmt = "mp3"
            elif "ogg" in audio.content_type:
                fmt = "ogg"
        text = await asyncio.to_thread(transcribe_audio_flash, data, audio_format=fmt)
        return SpeechAsrResponse(text=text)
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e)) from e


@router.get("/tts/providers")
async def speech_tts_providers() -> dict:
    """Return available TTS providers (with configured flag) and voice catalogs.

    Frontend uses this to populate the provider picker and voice selector.
    """
    from app.gateway.speech.tts_registry import (
        TTS_VOICES,
        list_available_providers,
    )

    return {
        "providers": list_available_providers(),
        "voices": TTS_VOICES,
        "defaults": {"provider": "volcengine"},
    }


@router.get("/tts/validate")
async def speech_tts_validate(provider: str | None = None) -> dict:
    """Preflight check for a TTS provider's credentials.

    Query params:
      provider  optional provider id; when omitted checks the default (volcengine).
    Returns ``{ok, provider, missing?, guide?}``.
    """
    from app.gateway.speech.tts_registry import validate_tts_config

    return validate_tts_config(provider)


@router.post("/tts")
async def speech_tts(body: SpeechTtsRequest) -> Response:
    import time

    from app.gateway.speech.voice_file_log import set_voice_trace, voice_playback_event

    provider = (body.provider or "").strip().lower() or "volcengine"
    text = body.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Empty text")

    # Backward-compatible fast path: volcengine still uses the original
    # configured-check + direct call so existing frontends are unaffected.
    if provider == "volcengine" and not speech_configured():
        raise HTTPException(
            status_code=503,
            detail="Speech not configured. Enable 火山 TTS in Settings → Models.",
        )
    try:
        speaker = body.speaker.strip() if body.speaker else None
        if body.trace_id:
            set_voice_trace(body.trace_id)
        voice_playback_event(
            "语音合成",
            text,
            extra=f"HTTP /tts 开始 provider={provider}",
            trace=body.trace_id,
        )
        t0 = time.perf_counter()
        speech_rate = body.speech_rate
        if provider == "volcengine":
            # Native volcengine path (keeps exact prior behavior for volcengine).
            # Both providers do sync HTTP (up to 120s timeout) — must not run on
            # the gateway event loop.
            audio_bytes, used_speaker = await asyncio.to_thread(
                synthesize_speech_v3,
                text,
                speaker=speaker,
                preview=body.preview,
                speech_rate=speech_rate,
            )
        else:
            from app.gateway.speech.tts_registry import synthesize_tts

            audio_bytes, used_speaker = await asyncio.to_thread(
                synthesize_tts,
                text,
                provider=provider,
                speaker=speaker,
                preview=body.preview,
                speech_rate=speech_rate,
            )
        ms = (time.perf_counter() - t0) * 1000
        digest = hashlib.md5(audio_bytes).hexdigest()[:12]
        voice_playback_event(
            "语音合成",
            text,
            extra=f"HTTP /tts 完成 bytes={len(audio_bytes)} cost={ms:.0f}ms digest={digest}",
            trace=body.trace_id,
        )
        return Response(
            content=audio_bytes,
            media_type="audio/mpeg",
            headers={
                "X-Tts-Speaker": used_speaker,
                "X-Tts-Provider": provider,
                "X-Tts-Digest": digest,
                "Access-Control-Expose-Headers": "X-Tts-Speaker, X-Tts-Provider, X-Tts-Digest",
            },
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        import logging

        logging.getLogger("evoflow.speech.tts").exception(
            "HTTP /tts failed provider=%s text=%r: %s", provider, text[:48], e
        )
        raise HTTPException(status_code=502, detail=str(e)) from e


@router.post("/tts/stream")
async def speech_tts_stream(body: SpeechTtsRequest) -> StreamingResponse:
    """Streaming TTS — yields audio chunks as they arrive from the provider.

    Reduces first-byte latency vs the non-streaming /tts endpoint.
    """
    import time

    from app.gateway.speech.voice_file_log import set_voice_trace, voice_playback_event

    provider = (body.provider or "").strip().lower() or "volcengine"
    text = body.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Empty text")

    if provider in {"volcengine", "doubao"} and not speech_configured():
        raise HTTPException(
            status_code=503,
            detail="Speech not configured. Enable 火山 TTS in Settings → Models → 语音.",
        )
    if provider not in {"volcengine", "doubao"}:
        from app.gateway.speech.tts_registry import validate_tts_config

        pre = validate_tts_config(provider)
        if not pre.get("ok"):
            raise HTTPException(status_code=503, detail=pre.get("guide") or f"{provider} TTS 未配置")
    try:
        speaker = body.speaker.strip() if body.speaker else None
        if body.trace_id:
            set_voice_trace(body.trace_id)
        voice_playback_event(
            "语音合成",
            text,
            extra=f"HTTP /tts/stream 开始 provider={provider}",
            trace=body.trace_id,
        )
        t0 = time.perf_counter()
        if provider == "volcengine":
            # Native volcengine path (keeps exact prior behavior for volcengine).
            gen = synthesize_speech_v3_stream(text, speaker=speaker, preview=body.preview)
        else:
            from app.gateway.speech.tts_registry import synthesize_tts_stream

            gen = synthesize_tts_stream(
                text,
                provider=provider,
                speaker=speaker,
                preview=body.preview,
            )

        # Peek first chunk so credential/config errors become HTTP errors
        # (instead of a mid-stream ASGI crash that leaves the browser with an empty audio blob).
        aiter = gen.__aiter__()
        try:
            first = await aiter.__anext__()
        except StopAsyncIteration:
            raise HTTPException(status_code=502, detail="TTS returned empty audio") from None

        first_ms = (time.perf_counter() - t0) * 1000
        voice_playback_event(
            "语音合成",
            text,
            extra=f"HTTP /tts/stream 首包 ttfb={first_ms:.0f}ms",
            trace=body.trace_id,
        )

        async def _out():
            total = len(first) if isinstance(first, (bytes, bytearray)) else 0
            yield first
            async for chunk in aiter:
                if isinstance(chunk, (bytes, bytearray)):
                    total += len(chunk)
                yield chunk
            ms_all = (time.perf_counter() - t0) * 1000
            voice_playback_event(
                "语音合成",
                text,
                extra=f"HTTP /tts/stream 完成 bytes={total} cost={ms_all:.0f}ms",
                trace=body.trace_id,
            )

        return StreamingResponse(_out(), media_type="audio/mpeg")
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e)) from e


@router.websocket("/session")
async def speech_session(ws: WebSocket) -> None:
    """Xiaomi Frame-runtime voice session (PCM in → ASR → turn → TTS out).

    Protocol: ``app/gateway/speech/session_manager.py``.
    """
    from app.gateway.speech.session_manager import SpeechSession

    await SpeechSession(ws).run()


async def _run_local_asr_proxy(client_ws: WebSocket) -> None:
    """Proxy WebSocket between frontend and local whisper_server."""
    import json

    import websockets

    from app.gateway.speech.whisper_manager import WHISPER_WS_URL

    async with websockets.connect(WHISPER_WS_URL) as whisper_ws:

        async def _client_to_whisper():
            async for msg in client_ws:
                if isinstance(msg, bytes):
                    await whisper_ws.send(msg)
                elif isinstance(msg, str):
                    await whisper_ws.send(msg)
                else:
                    try:
                        await whisper_ws.send(json.dumps(msg))
                    except Exception:
                        pass

        async def _whisper_to_client():
            async for msg in whisper_ws:
                if isinstance(msg, str):
                    await client_ws.send_text(msg)
                else:
                    await client_ws.send_bytes(msg)

        import asyncio as _asyncio

        done, pending = await _asyncio.wait(
            [
                _asyncio.ensure_future(_client_to_whisper()),
                _asyncio.ensure_future(_whisper_to_client()),
            ],
            return_when=_asyncio.FIRST_COMPLETED,
        )
        for task in pending:
            task.cancel()
