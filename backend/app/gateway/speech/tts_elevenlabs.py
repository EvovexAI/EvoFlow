"""ElevenLabs TTS provider.

Implements speech synthesis via ElevenLabs Text-to-Sound API:
  POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream

- Model: eleven_flash_v2_5 (low latency, cost-effective)
- Streaming: HTTP chunked, yield raw audio bytes directly.

Reference: https://elevenlabs.io/docs/api-reference/endpoint/stream-text-to-speech
"""

from __future__ import annotations

import logging
from collections.abc import AsyncGenerator

import httpx

logger = logging.getLogger(__name__)

API_BASE = "https://api.elevenlabs.io"
DEFAULT_VOICE = "pNInz6obpgDQGcFmaJgB"  # Adam
DEFAULT_MODEL = "eleven_flash_v2_5"
_TIMEOUT = 120.0


def _normalize_voice(voice_id: str | None) -> str:
    return (voice_id or "").strip() or DEFAULT_VOICE


async def synthesize_speech_stream(
    text: str,
    *,
    voice_id: str | None = None,
    api_key: str,
    model_id: str | None = None,
) -> AsyncGenerator[bytes, None]:
    """Stream audio chunks from ElevenLabs TTS as they arrive."""
    if not api_key or not api_key.strip():
        raise ValueError(
            "ElevenLabs TTS: 缺少 API Key，请在 设置 → 模型 → 创意媒体 填写 elevenLabsKey，"
            "或设置环境变量 ELEVENLABS_API_KEY / ELEVENLABS_KEY。"
        )
    script = str(text or "").strip()
    if not script:
        raise ValueError("ElevenLabs TTS: 文本不能为空")

    voice = _normalize_voice(voice_id)
    url = f"{API_BASE}/v1/text-to-speech/{voice}/stream"
    payload = {
        "text": script,
        "model_id": (model_id or DEFAULT_MODEL).strip() or DEFAULT_MODEL,
        "voice_settings": {
            "stability": 0.5,
            "similarity_boost": 0.75,
            "style": 0.0,
        },
    }
    headers = {
        "xi-api-key": api_key.strip(),
        "Content-Type": "application/json",
        "Accept": "audio/mpeg",
    }

    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        async with client.stream("POST", url, json=payload, headers=headers) as resp:
            if resp.status_code >= 400:
                body = await resp.aread()
                raise RuntimeError(
                    f"ElevenLabs TTS HTTP {resp.status_code}: {body[:300]!r}"
                )
            async for chunk in resp.aiter_bytes():
                if chunk:
                    yield chunk


async def synthesize_speech(
    text: str,
    *,
    voice_id: str | None = None,
    api_key: str,
    model_id: str | None = None,
) -> bytes:
    """Non-streaming fallback: accumulate stream into a single bytes blob."""
    chunks: list[bytes] = []
    async for chunk in synthesize_speech_stream(
        text,
        voice_id=voice_id,
        api_key=api_key,
        model_id=model_id,
    ):
        chunks.append(chunk)
    if not chunks:
        raise RuntimeError("ElevenLabs TTS returned empty audio")
    return b"".join(chunks)
