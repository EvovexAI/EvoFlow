"""OpenAI TTS provider.

Implements speech synthesis via OpenAI's Audio API:
  POST {base_url}/v1/audio/speech

- Model: tts-1 (low latency) / tts-1-hd (higher quality)
- Response format: mp3
- Streaming: response body is HTTP chunked; yield raw chunks directly.

Reference: https://platform.openai.com/docs/api-reference/audio/createSpeech
"""

from __future__ import annotations

import logging
from collections.abc import AsyncGenerator

import httpx

logger = logging.getLogger(__name__)

DEFAULT_BASE_URL = "https://api.openai.com"
DEFAULT_VOICE = "nova"
DEFAULT_MODEL = "tts-1"
DEFAULT_FORMAT = "mp3"
_TIMEOUT = 120.0


def _normalize_base_url(base_url: str | None) -> str:
    return (base_url or "").strip().rstrip("/") or DEFAULT_BASE_URL


def _normalize_voice(voice_id: str | None) -> str:
    return (voice_id or "").strip() or DEFAULT_VOICE


async def synthesize_speech_stream(
    text: str,
    *,
    voice_id: str | None = None,
    api_key: str,
    base_url: str | None = None,
    model: str | None = None,
) -> AsyncGenerator[bytes, None]:
    """Stream MP3 chunks from OpenAI TTS as they arrive."""
    if not api_key or not api_key.strip():
        raise ValueError(
            "OpenAI TTS: 缺少 API Key，请在 设置 → 模型 → 创意媒体 填写 openaiTtsKey，"
            "或设置环境变量 OPENAI_API_KEY / OPENAI_TTS_API_KEY。"
        )
    script = str(text or "").strip()
    if not script:
        raise ValueError("OpenAI TTS: 文本不能为空")

    voice = _normalize_voice(voice_id)
    url = f"{_normalize_base_url(base_url)}/v1/audio/speech"
    payload = {
        "model": (model or DEFAULT_MODEL).strip() or DEFAULT_MODEL,
        "input": script,
        "voice": voice,
        "response_format": DEFAULT_FORMAT,
    }
    headers = {
        "Authorization": f"Bearer {api_key.strip()}",
        "Content-Type": "application/json",
    }

    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        async with client.stream("POST", url, json=payload, headers=headers) as resp:
            if resp.status_code >= 400:
                body = await resp.aread()
                raise RuntimeError(
                    f"OpenAI TTS HTTP {resp.status_code}: {body[:300]!r}"
                )
            async for chunk in resp.aiter_bytes():
                if chunk:
                    yield chunk


async def synthesize_speech(
    text: str,
    *,
    voice_id: str | None = None,
    api_key: str,
    base_url: str | None = None,
    model: str | None = None,
) -> bytes:
    """Non-streaming fallback: accumulate stream into a single bytes blob."""
    chunks: list[bytes] = []
    async for chunk in synthesize_speech_stream(
        text,
        voice_id=voice_id,
        api_key=api_key,
        base_url=base_url,
        model=model,
    ):
        chunks.append(chunk)
    if not chunks:
        raise RuntimeError("OpenAI TTS returned empty audio")
    return b"".join(chunks)
