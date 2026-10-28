"""Multi-provider ASR registry (Volcengine default; DashScope / Whisper)."""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from typing import Any, Protocol

logger = logging.getLogger("evoflow.speech.asr_registry")

ASR_PROVIDERS: list[dict[str, Any]] = [
    {"id": "volcengine", "label": "火山引擎", "streaming": True},
    {"id": "dashscope", "label": "阿里 DashScope（Paraformer）", "streaming": True},
    {"id": "whisper", "label": "本地 Whisper", "streaming": True},
]

DEFAULT_ASR_PROVIDER = "volcengine"

ASR_PROVIDER_REQUIREMENTS: dict[str, dict[str, Any]] = {
    "volcengine": {
        "label": "火山引擎",
        "groups": [{"keys": ["volcengineSpeechApiKey", "volcengineApiKey"], "label": "语音 API Key"}],
        "guide": "请在 设置 → 模型 → 语音 → 火山语音 填写语音 API Key。",
    },
    "dashscope": {
        "label": "阿里 DashScope",
        "groups": [{"keys": ["dashscopeApiKey"], "label": "DashScope API Key"}],
        "guide": "请在 设置 → 模型 → 语音 → 阿里云语音 填写 DashScope API Key（与通义万相共用）。",
    },
    "whisper": {
        "label": "本地 Whisper",
        "groups": [],
        "guide": "需安装 openai-whisper 或打包 whisper_server；无云端 Key 时自动回退。",
    },
}

TranscriptCallback = Callable[[str, bool, str | None], Awaitable[None]]
ErrorCallback = Callable[[str], Awaitable[None]]


class AsrSession(Protocol):
    async def start(self) -> None: ...
    async def send_pcm(self, pcm: bytes) -> None: ...
    async def flush(self) -> None: ...
    async def close(self) -> None: ...


def list_asr_providers() -> list[dict[str, Any]]:
    from app.gateway.speech.providers.dashscope_asr_session import dashscope_asr_available
    from app.gateway.speech.volcengine_speech import speech_streaming_asr_available
    from app.gateway.speech.whisper_manager import is_available as whisper_available

    rows = []
    for p in ASR_PROVIDERS:
        configured = False
        if p["id"] == "volcengine":
            configured = speech_streaming_asr_available()
        elif p["id"] == "dashscope":
            configured = dashscope_asr_available()
        elif p["id"] == "whisper":
            configured = whisper_available()
        rows.append({**p, "configured": configured})
    return rows


def validate_asr_config(provider: str | None = None) -> dict[str, Any]:
    prov = (provider or "").strip().lower() or DEFAULT_ASR_PROVIDER
    req = ASR_PROVIDER_REQUIREMENTS.get(prov)
    if not req:
        return {
            "ok": False,
            "provider": prov,
            "guide": f"未知 ASR 服务商：{provider or '空'}。请选择 volcengine / dashscope / whisper。",
        }
    if prov == "volcengine":
        from app.gateway.speech.volcengine_speech import speech_streaming_asr_available

        if not speech_streaming_asr_available():
            return {
                "ok": False,
                "provider": prov,
                "missing": ["语音 API Key"],
                "guide": req["guide"],
            }
    if prov == "dashscope":
        from app.gateway.speech.providers.dashscope_asr_session import dashscope_asr_available

        if not dashscope_asr_available():
            return {
                "ok": False,
                "provider": prov,
                "missing": ["DashScope API Key"],
                "guide": req["guide"],
            }
    if prov == "whisper":
        from app.gateway.speech.whisper_manager import is_available as whisper_available

        if not whisper_available():
            return {
                "ok": False,
                "provider": prov,
                "guide": req["guide"],
            }
    return {"ok": True, "provider": prov}


async def create_asr_session(
    provider: str | None,
    *,
    on_transcript: TranscriptCallback,
    on_error: ErrorCallback | None = None,
) -> AsrSession:
    prov = (provider or "").strip().lower() or DEFAULT_ASR_PROVIDER
    if prov == "volcengine":
        from app.gateway.speech.providers.volcengine_asr_session import VolcengineAsrSession

        return VolcengineAsrSession(on_transcript=on_transcript, on_error=on_error)
    if prov == "dashscope":
        from app.gateway.speech.providers.dashscope_asr_session import DashscopeAsrSession

        return DashscopeAsrSession(on_transcript=on_transcript, on_error=on_error)
    if prov == "whisper":
        from app.gateway.speech.providers.whisper_asr_session import WhisperAsrSession

        return WhisperAsrSession(on_transcript=on_transcript, on_error=on_error)
    raise ValueError(f"unknown ASR provider: {prov}")
