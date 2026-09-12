from __future__ import annotations

import hashlib

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
from app.gateway.speech.whisper_manager import is_available as whisper_available, start_whisper as ensure_whisper

router = APIRouter(prefix="/api/speech", tags=["speech"])


class SpeechStatusResponse(BaseModel):
    configured: bool = False
    streaming_asr: bool = False
    local_asr: bool = False
    wake_word: bool = False


class SpeechAsrResponse(BaseModel):
    text: str = ""


class SpeechTtsRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=4000)
    speaker: str | None = Field(default=None, max_length=256)
    preview: bool = False
    # TTS provider id. None / "volcengine" keeps backward-compatible behavior.
    # Supported: volcengine | doubao | dashscope | openai | elevenlabs | minimax
    provider: str | None = None


@router.get("/status", response_model=SpeechStatusResponse)
async def get_speech_status() -> SpeechStatusResponse:
    return SpeechStatusResponse(
        configured=speech_configured(),
        streaming_asr=speech_streaming_asr_available(),
        local_asr=whisper_available(),
    )


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
        except Exception as e:
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
        text = transcribe_audio_flash(data, audio_format=fmt)
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
        if provider == "volcengine":
            # Native volcengine path (keeps exact prior behavior for volcengine).
            audio_bytes, used_speaker = synthesize_speech_v3(
                text, speaker=speaker, preview=body.preview
            )
        else:
            from app.gateway.speech.tts_registry import synthesize_tts

            audio_bytes, used_speaker = synthesize_tts(
                text,
                provider=provider,
                speaker=speaker,
                preview=body.preview,
            )
        digest = hashlib.md5(audio_bytes).hexdigest()[:12]
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
        raise HTTPException(status_code=502, detail=str(e)) from e


@router.post("/tts/stream")
async def speech_tts_stream(body: SpeechTtsRequest) -> StreamingResponse:
    """Streaming TTS — yields audio chunks as they arrive from the provider.

    Reduces first-byte latency vs the non-streaming /tts endpoint.
    """
    provider = (body.provider or "").strip().lower() or "volcengine"
    text = body.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Empty text")

    if provider == "volcengine" and not speech_configured():
        raise HTTPException(
            status_code=503,
            detail="Speech not configured. Enable 火山 TTS in Settings → Models.",
        )
    try:
        speaker = body.speaker.strip() if body.speaker else None
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

        async def _out():
            yield first
            async for chunk in aiter:
                yield chunk

        return StreamingResponse(_out(), media_type="audio/mpeg")
    except HTTPException:
        raise
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e)) from e


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
