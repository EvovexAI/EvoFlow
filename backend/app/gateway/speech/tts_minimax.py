"""MiniMax TTS provider.

Implements speech synthesis via MiniMax T2A v2 API:
  POST https://api.minimaxi.com/v1/t2a_v2

- Model: speech-2.8-hd
- Response: JSON with hex-encoded audio in data.audio
- Non-streaming only: returns the full audio buffer.

Reference: https://platform.minimaxi.com/document/T2A%20V2
"""

from __future__ import annotations

import logging
from collections.abc import AsyncGenerator

import httpx

logger = logging.getLogger(__name__)

API_URL = "https://api.minimaxi.com/v1/t2a_v2"
DEFAULT_VOICE = "male-qn-qingse"
DEFAULT_MODEL = "speech-2.8-hd"
_TIMEOUT = 120.0


def _normalize_voice(voice_id: str | None) -> str:
    return (voice_id or "").strip() or DEFAULT_VOICE


async def synthesize_speech(
    text: str,
    *,
    voice_id: str | None = None,
    api_key: str,
    model: str | None = None,
) -> bytes:
    """Non-streaming MiniMax TTS — returns the full MP3 buffer."""
    if not api_key or not api_key.strip():
        raise ValueError(
            "MiniMax TTS: 缺少 API Key，请在 设置 → 模型 → 创意媒体 填写 minimaxKey，"
            "或设置环境变量 MINIMAX_API_KEY / MINIMAX_KEY。"
        )
    script = str(text or "").strip()
    if not script:
        raise ValueError("MiniMax TTS: 文本不能为空")

    voice = _normalize_voice(voice_id)
    payload = {
        "model": (model or DEFAULT_MODEL).strip() or DEFAULT_MODEL,
        "text": script,
        "voice_setting": {
            "voice_id": voice,
            "speed": 1.0,
            "emotion": "neutral",
            "vol": 1.0,
        },
        "audio_setting": {
            "sample_rate": 32000,
            "bitrate": 128000,
            "format": "mp3",
        },
    }
    headers = {
        "Authorization": f"Bearer {api_key.strip()}",
        "Content-Type": "application/json",
    }

    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        resp = await client.post(API_URL, json=payload, headers=headers)

    if resp.status_code >= 400:
        raise RuntimeError(f"MiniMax TTS HTTP {resp.status_code}: {resp.text[:300]}")

    try:
        data = resp.json()
    except Exception as e:
        raise RuntimeError(f"MiniMax TTS invalid JSON: {resp.text[:300]}") from e

    audio_hex = ""
    if isinstance(data, dict):
        inner = data.get("data")
        if isinstance(inner, dict):
            audio_hex = str(inner.get("audio") or "").strip()
    if not audio_hex:
        raise RuntimeError(f"MiniMax TTS: 响应中无音频数据: {str(data)[:300]}")

    try:
        return bytes.fromhex(audio_hex)
    except ValueError as e:
        raise RuntimeError(f"MiniMax TTS: 音频 hex 解码失败: {e}") from e


async def synthesize_speech_stream(
    text: str,
    *,
    voice_id: str | None = None,
    api_key: str,
    model: str | None = None,
) -> AsyncGenerator[bytes, None]:
    """MiniMax does not support true streaming — yield the full buffer once.

    Kept for interface symmetry with other providers so the registry can
    always call ``synthesize_*_stream`` regardless of provider.
    """
    audio = await synthesize_speech(
        text,
        voice_id=voice_id,
        api_key=api_key,
        model=model,
    )
    yield audio
