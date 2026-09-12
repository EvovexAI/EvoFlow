from __future__ import annotations

import base64
import json
import logging
import os

import httpx

from evoflow.community.media_generation.config_helpers import dashscope_api_key

logger = logging.getLogger(__name__)

# CosyVoice non-streaming HTTP API (Model Studio).
# https://help.aliyun.com/zh/model-studio/cosyvoice-tts-http-api
_SPEECH_SYNTH_PATH = "/services/audio/tts/SpeechSynthesizer"

# Legacy env values mapped to v3-compatible defaults.
_LEGACY_VOICE_MAP = {
    "longxiaochun": "longanyang",
    "longxiaochun_v2": "longanhuan",
}


def _base_url() -> str:
    return os.getenv("DASHSCOPE_BASE_URL", "https://dashscope.aliyuncs.com/api/v1").rstrip("/")


def _resolve_model(model: str | None) -> str:
    raw = (model or os.getenv("DASHSCOPE_TTS_MODEL", "cosyvoice-v3-flash")).strip()
    if raw in ("cosyvoice-v1", "cosyvoice-v1-flash"):
        return "cosyvoice-v3-flash"
    return raw or "cosyvoice-v3-flash"


def _resolve_voice(voice: str | None, *, model: str) -> str:
    raw = (voice or os.getenv("DASHSCOPE_TTS_VOICE", "longanyang")).strip()
    if not raw:
        return "longanyang"
    mapped = _LEGACY_VOICE_MAP.get(raw, raw)
    if model.startswith("cosyvoice-v2") and mapped == "longanyang":
        return os.getenv("DASHSCOPE_TTS_VOICE_V2", "longxiaochun_v2")
    return mapped


def _extract_audio_bytes(data: dict) -> bytes:
    out = data.get("output") or {}
    if not isinstance(out, dict):
        raise RuntimeError(f"DashScope TTS unexpected output: {json.dumps(data, ensure_ascii=False)[:300]}")

    audio = out.get("audio")
    if isinstance(audio, dict):
        audio_data = audio.get("data")
        if isinstance(audio_data, str) and audio_data.strip():
            return base64.b64decode(audio_data)

        audio_url = audio.get("url")
        if isinstance(audio_url, str) and audio_url.strip().startswith(("http://", "https://")):
            with httpx.Client(timeout=120.0, follow_redirects=True) as client:
                ar = client.get(audio_url.strip())
            if ar.status_code >= 400:
                raise RuntimeError(f"DashScope TTS audio download {ar.status_code}: {ar.text[:300]}")
            if not ar.content:
                raise RuntimeError("DashScope TTS audio download returned empty body")
            return ar.content

    # Older/alternate shapes
    if isinstance(audio, str) and audio.strip():
        return base64.b64decode(audio)
    audio_b64 = out.get("audio_data")
    if isinstance(audio_b64, str) and audio_b64.strip():
        return base64.b64decode(audio_b64)
    audio_url = out.get("audio_url")
    if isinstance(audio_url, str) and audio_url.strip().startswith(("http://", "https://")):
        with httpx.Client(timeout=120.0, follow_redirects=True) as client:
            ar = client.get(audio_url.strip())
        return ar.content

    raise RuntimeError(f"DashScope TTS missing audio in response: {json.dumps(data, ensure_ascii=False)[:300]}")


def synthesize_speech(text: str, *, voice: str | None = None, model: str | None = None) -> bytes:
    """DashScope CosyVoice HTTP speech synthesis (non-streaming)."""
    key = dashscope_api_key()
    if not key:
        raise ValueError("Set DASHSCOPE_API_KEY for DashScope TTS")

    script = str(text or "").strip()
    if not script:
        raise ValueError("TTS text must not be empty")

    m = _resolve_model(model)
    v = _resolve_voice(voice, model=m)
    fmt = (os.getenv("DASHSCOPE_TTS_FORMAT", "mp3") or "mp3").strip().lower()
    if fmt not in ("mp3", "wav", "pcm", "opus"):
        fmt = "mp3"
    try:
        sample_rate = int(os.getenv("DASHSCOPE_TTS_SAMPLE_RATE", "24000"))
    except ValueError:
        sample_rate = 24000

    body = {
        "model": m,
        "input": {
            "text": script,
            "voice": v,
            "format": fmt,
            "sample_rate": sample_rate,
        },
    }
    url = f"{_base_url()}{_SPEECH_SYNTH_PATH}"
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}

    with httpx.Client(timeout=120.0) as client:
        resp = client.post(url, headers=headers, json=body)

    if resp.status_code >= 400:
        raise RuntimeError(f"DashScope TTS {resp.status_code}: {resp.text[:500]}")

    content_type = (resp.headers.get("content-type") or "").lower()
    if "json" in content_type or (resp.content and resp.content[:1] == b"{"):
        data = resp.json()
        if not isinstance(data, dict):
            raise RuntimeError(f"DashScope TTS unexpected response type: {type(data)!r}")
        return _extract_audio_bytes(data)

    if resp.content:
        return resp.content

    raise RuntimeError("DashScope TTS returned empty response body")
