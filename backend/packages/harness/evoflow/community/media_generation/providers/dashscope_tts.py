from __future__ import annotations

import base64
import json
import logging
import os

import httpx

from evoflow.community.media_generation.config_helpers import dashscope_api_key, dashscope_base_url

logger = logging.getLogger(__name__)

# CosyVoice / Qwen-Audio-TTS non-streaming HTTP API (Model Studio / Token Plan).
# https://help.aliyun.com/zh/model-studio/cosyvoice-tts-http-api
# https://help.aliyun.com/zh/model-studio/token-plan-speech-synthesis
_SPEECH_SYNTH_PATH = "/services/audio/tts/SpeechSynthesizer"

TOKEN_PLAN_MEDIA_BASE = "https://token-plan.cn-beijing.maas.aliyuncs.com/api/v1"
TOKEN_PLAN_TTS_MODEL = "qwen-audio-3.0-tts-plus"
TOKEN_PLAN_DEFAULT_VOICE = "longanlingxin"
PAYG_TTS_MODEL = "cosyvoice-v3-flash"
PAYG_DEFAULT_VOICE = "longanyang"

# Legacy / catalog aliases → CosyVoice v3-flash voice ids.
_LEGACY_VOICE_MAP = {
    "longxiaochun": "longxiaochun_v3",
    "longxiaochun_v2": "longxiaochun_v3",
    "longshu": "longsanshu_v3",
    "longcheng": "longcheng_v3",
    "longxiao": "longhua_v3",
    "longmiao": "longmiao_v3",
    # Old mistaken "龙安阳" spelling → official 龙安洋
    "longanyang": "longanyang",
}

# CosyVoice 音色在 Token Plan 上不可用；落到官方推荐系统音色。
_TOKEN_PLAN_VOICE_FALLBACK = {
    "longanyang": "longanlufeng",
    "longanhuan": "longanlingxin",
    "longanhuan_v3.6": "longanhuan_v3.6",
    "longxiaochun_v3": "longanlingxin",
    "longxiaoxia_v3": "longanlingxin",
    "longcheng_v3": "longanlufeng",
    "longze_v3": "longanlufeng",
    "longmiao_v3": "longanlingxin",
    "longsanshu_v3": "longanlufeng",
    "longanrou_v3": "longanlingxin",
    "longyingjing_v3": "longanlingxin",
    "longhua_v3": "longanlingxin",
}


def _is_token_plan_key(api_key: str) -> bool:
    return str(api_key or "").strip().lower().startswith("sk-sp-")


def _is_token_plan_base(base_url: str) -> bool:
    return "token-plan" in str(base_url or "").strip().lower()


def _base_url(*, api_key: str = "") -> str:
    raw = dashscope_base_url().rstrip("/")
    # sk-sp- 套餐 Key 只能打 Token Plan 媒体口；落到按量 dashscope 会 InvalidApiKey。
    if _is_token_plan_key(api_key) and not _is_token_plan_base(raw):
        logger.info(
            "DashScope TTS: sk-sp- Key with non-token-plan base %s → %s",
            raw,
            TOKEN_PLAN_MEDIA_BASE,
        )
        return TOKEN_PLAN_MEDIA_BASE
    return raw or TOKEN_PLAN_MEDIA_BASE


def _resolve_model(model: str | None, *, token_plan: bool) -> str:
    env_default = TOKEN_PLAN_TTS_MODEL if token_plan else PAYG_TTS_MODEL
    raw = (model or os.getenv("DASHSCOPE_TTS_MODEL", env_default)).strip()
    if token_plan:
        # Token Plan 官方只列 qwen-audio-3.0-tts-plus；CosyVoice 型号会鉴权失败。
        if not raw or raw.startswith("cosyvoice"):
            return TOKEN_PLAN_TTS_MODEL
        return raw
    if raw in ("cosyvoice-v1", "cosyvoice-v1-flash"):
        return "cosyvoice-v3-flash"
    return raw or PAYG_TTS_MODEL


def _resolve_voice(voice: str | None, *, model: str, token_plan: bool) -> str:
    env_default = TOKEN_PLAN_DEFAULT_VOICE if token_plan else PAYG_DEFAULT_VOICE
    raw = (voice or os.getenv("DASHSCOPE_TTS_VOICE", env_default)).strip()
    if not raw:
        return env_default
    mapped = _LEGACY_VOICE_MAP.get(raw, raw)
    if token_plan:
        # CosyVoice 音色名在 Qwen-Audio-TTS 上不通用
        if mapped in _TOKEN_PLAN_VOICE_FALLBACK:
            return _TOKEN_PLAN_VOICE_FALLBACK[mapped]
        if mapped.startswith("longxiao") or mapped.startswith("longcheng") or mapped.startswith("longze"):
            return TOKEN_PLAN_DEFAULT_VOICE
        return mapped
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


def _format_http_error(status: int, body: str, *, token_plan: bool, base: str, model: str) -> str:
    text = str(body or "")[:500]
    low = text.lower()
    if status in (401, 403) or "invalidapikey" in low or "invalid api-key" in low:
        if token_plan or "sk-sp-" in text:
            return (
                f"DashScope TTS {status}: Token Plan（sk-sp-）语音请走 "
                f"{TOKEN_PLAN_MEDIA_BASE} + model={TOKEN_PLAN_TTS_MODEL}，"
                f"当前 base={base} model={model}。请在设置→语音→阿里云语音确认 Base URL，"
                f"或重新「按套餐目录补齐」。原文：{text}"
            )
        return (
            f"DashScope TTS {status}: API Key 无效。按量请用 sk- Key + "
            f"https://dashscope.aliyuncs.com/api/v1；Token Plan 请用 sk-sp- + token-plan 媒体口。"
            f"原文：{text}"
        )
    return f"DashScope TTS {status}: {text}"


def synthesize_speech(text: str, *, voice: str | None = None, model: str | None = None) -> bytes:
    """DashScope / Token Plan speech synthesis (non-streaming)."""
    key = dashscope_api_key()
    if not key:
        raise ValueError("Set DASHSCOPE_API_KEY for DashScope TTS")

    script = str(text or "").strip()
    if not script:
        raise ValueError("TTS text must not be empty")

    token_plan = _is_token_plan_key(key)
    base = _base_url(api_key=key)
    if _is_token_plan_base(base):
        token_plan = True

    m = _resolve_model(model, token_plan=token_plan)
    v = _resolve_voice(voice, model=m, token_plan=token_plan)
    fmt = (os.getenv("DASHSCOPE_TTS_FORMAT", "mp3") or "mp3").strip().lower()
    if fmt not in ("mp3", "wav", "pcm", "opus"):
        fmt = "mp3"
    try:
        default_rate = "22050" if token_plan else "24000"
        sample_rate = int(os.getenv("DASHSCOPE_TTS_SAMPLE_RATE", default_rate))
    except ValueError:
        sample_rate = 22050 if token_plan else 24000

    body = {
        "model": m,
        "input": {
            "text": script,
            "voice": v,
            "format": fmt,
            "sample_rate": sample_rate,
        },
    }
    url = f"{base}{_SPEECH_SYNTH_PATH}"
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}

    with httpx.Client(timeout=120.0) as client:
        resp = client.post(url, headers=headers, json=body)

    if resp.status_code >= 400:
        raise RuntimeError(
            _format_http_error(
                resp.status_code,
                resp.text,
                token_plan=token_plan,
                base=base,
                model=m,
            )
        )

    content_type = (resp.headers.get("content-type") or "").lower()
    if "json" in content_type or (resp.content and resp.content[:1] == b"{"):
        data = resp.json()
        if not isinstance(data, dict):
            raise RuntimeError(f"DashScope TTS unexpected response type: {type(data)!r}")
        return _extract_audio_bytes(data)

    if resp.content:
        return resp.content

    raise RuntimeError("DashScope TTS returned empty response body")
