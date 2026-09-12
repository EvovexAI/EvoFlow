"""Multi-provider TTS registry.

Central registry for routing TTS requests to one of several providers:
  - volcengine  (火山引擎 Speech — reuses volcengine_speech.py)
  - doubao      (豆包方舟 — reuses volcengine_speech.py, ark- keys)
  - dashscope   (阿里 DashScope CosyVoice — reuses dashscope_tts.py)
  - openai      (OpenAI TTS — tts_openai.py)
  - elevenlabs  (ElevenLabs — tts_elevenlabs.py)
  - minimax     (MiniMax — tts_minimax.py)

Design mirrors the legacy voice module's ``tts-providers.js``:
  - ``TTS_PROVIDERS``         provider metadata (id/label/streaming)
  - ``TTS_VOICES``            per-provider voice catalog
  - ``TTS_PROVIDER_REQUIREMENTS``  credential requirements + guide
  - ``validate_tts_config``   preflight check
  - ``synthesize_tts`` / ``synthesize_tts_stream``  unified entry points

Backward compatibility: ``provider=None`` defaults to ``"volcengine"`` so
existing callers (and the old /tts endpoints) keep working unchanged.
"""

from __future__ import annotations

import logging
import os
from collections.abc import AsyncGenerator
from typing import Any

logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────────────────────
# Provider metadata
# ─────────────────────────────────────────────────────────────────────────────

TTS_PROVIDERS: list[dict[str, Any]] = [
    {"id": "volcengine", "label": "火山引擎", "streaming": True},
    {"id": "doubao", "label": "豆包（方舟）", "streaming": True},
    {"id": "dashscope", "label": "阿里 DashScope", "streaming": False},
    {"id": "openai", "label": "OpenAI TTS", "streaming": True},
    {"id": "elevenlabs", "label": "ElevenLabs", "streaming": True},
    {"id": "minimax", "label": "MiniMax", "streaming": False},
]

_PROVIDER_IDS: frozenset[str] = frozenset(p["id"] for p in TTS_PROVIDERS)
DEFAULT_PROVIDER = "volcengine"

# ─────────────────────────────────────────────────────────────────────────────
# Voice catalogs (adapted from the legacy voice module TTS_VOICES + existing volcengine speakers)
# ─────────────────────────────────────────────────────────────────────────────

TTS_VOICES: dict[str, list[dict[str, str]]] = {
    "volcengine": [
        {"id": "zh_female_vv_uranus_bigtts", "label": "Vivi 2.0（女声，通用/多语种）"},
        {"id": "zh_female_xiaohe_uranus_bigtts", "label": "小何 2.0（女声，通用）"},
        {"id": "zh_female_shuangkuaisisi_uranus_bigtts", "label": "爽快思思 2.0（女声，活泼）"},
        {"id": "zh_female_cancan_uranus_bigtts", "label": "知性灿灿 2.0（女声，角色）"},
        {"id": "zh_female_tianmeixiaoyuan_uranus_bigtts", "label": "甜美小源 2.0（女声，甜美）"},
        {"id": "zh_male_m191_uranus_bigtts", "label": "云舟 2.0（男声，通用）"},
        {"id": "zh_male_taocheng_uranus_bigtts", "label": "小天 2.0（男声，通用）"},
        {"id": "zh_female_kefunvsheng_uranus_bigtts", "label": "暖阳女声 2.0（客服）"},
        {"id": "BV001_streaming", "label": "通用女声（1.0）"},
        {"id": "BV002_streaming", "label": "通用男声（1.0）"},
    ],
    "doubao": [
        {"id": "zh_female_xiaohe_uranus_bigtts", "label": "小何 2.0（女声，通用）"},
        {"id": "zh_female_vv_uranus_bigtts", "label": "Vivi 2.0（女声，通用/多语种）"},
        {"id": "zh_female_shuangkuaisisi_uranus_bigtts", "label": "爽快思思 2.0（女声，活泼）"},
        {"id": "zh_female_cancan_uranus_bigtts", "label": "知性灿灿 2.0（女声，角色）"},
        {"id": "zh_female_tianmeixiaoyuan_uranus_bigtts", "label": "甜美小源 2.0（女声，甜美）"},
        {"id": "zh_male_m191_uranus_bigtts", "label": "云舟 2.0（男声，通用）"},
        {"id": "zh_male_taocheng_uranus_bigtts", "label": "小天 2.0（男声，通用）"},
        {"id": "zh_female_kefunvsheng_uranus_bigtts", "label": "暖阳女声 2.0（客服）"},
    ],
    "dashscope": [
        {"id": "longanyang", "label": "龙安阳（女声，通用）"},
        {"id": "longxiaochun_v2", "label": "龙小淳 v2（女声，自然）"},
        {"id": "longshu", "label": "龙叔（男声，沉稳）"},
        {"id": "longcheng", "label": "龙诚（男声，标准）"},
        {"id": "longxiao", "label": "龙晓（女声，活泼）"},
        {"id": "longmiao", "label": "龙妙（女声，甜美）"},
    ],
    "openai": [
        {"id": "nova", "label": "Nova（女声，自然）"},
        {"id": "shimmer", "label": "Shimmer（女声，轻柔）"},
        {"id": "alloy", "label": "Alloy（中性）"},
        {"id": "echo", "label": "Echo（男声）"},
        {"id": "fable", "label": "Fable（男声，叙事）"},
        {"id": "onyx", "label": "Onyx（男声，低沉）"},
    ],
    "elevenlabs": [
        {"id": "pNInz6obpgDQGcFmaJgB", "label": "Adam（男声）"},
        {"id": "ErXwobaYiN019PkySvjV", "label": "Antoni（男声，温和）"},
        {"id": "MF3mGyEYCl7XYWbV9V6O", "label": "Elli（女声，年轻）"},
        {"id": "21m00Tcm4TlvDq8ikWAM", "label": "Rachel（女声，自然）"},
        {"id": "AZnzlk1XvdvUeBnXmlld", "label": "Domi（女声，有力）"},
        {"id": "TxGEqnHWrfWFTfGW9XjX", "label": "Josh（男声，深沉）"},
    ],
    "minimax": [
        {"id": "male-qn-qingse", "label": "青涩男声"},
        {"id": "male-qn-jingying", "label": "精英男声"},
        {"id": "male-qn-badao", "label": "霸道男声"},
        {"id": "female-shaonv", "label": "少女"},
        {"id": "female-yujie", "label": "御姐"},
        {"id": "female-chengshu", "label": "成熟女声"},
        {"id": "presenter_male", "label": "男主播"},
        {"id": "presenter_female", "label": "女主播"},
    ],
}

# ─────────────────────────────────────────────────────────────────────────────
# Credential requirements (preflight single source of truth)
#
# Each provider declares one or more "required groups"; a group is satisfied
# when ANY of its keys is non-empty in the credentials dict.  This mirrors
# the legacy voice module's TTS_PROVIDER_REQUIREMENTS so the frontend / validate endpoint
# can give actionable Chinese guidance before synthesis is attempted.
# ─────────────────────────────────────────────────────────────────────────────

TTS_PROVIDER_REQUIREMENTS: dict[str, dict[str, Any]] = {
    "volcengine": {
        "label": "火山引擎",
        "groups": [{"keys": ["volcengineSpeechApiKey", "volcengineApiKey"], "label": "语音 API Key"}],
        "guide": (
            "请在 设置 → 模型 → 创意媒体 → 火山 TTS 填写语音 API Key，"
            "并打开启用开关。Agent Plan 用户可填火山方舟专属 Key（ark- 开头）。"
        ),
    },
    "doubao": {
        "label": "豆包（方舟）",
        "groups": [{"keys": ["volcengineSpeechApiKey", "volcengineApiKey"], "label": "语音 API Key / 方舟 Key"}],
        "guide": (
            "请在 设置 → 模型 → 创意媒体 → 火山 TTS 填写语音 API Key（ark- 开头的方舟 Key 也可）。"
        ),
    },
    "dashscope": {
        "label": "阿里 DashScope",
        "groups": [{"keys": ["dashscopeApiKey"], "label": "DashScope API Key"}],
        "guide": (
            "请在 设置 → 模型 → 创意媒体 → 通义万相 填写 DashScope API Key，并打开启用开关。"
        ),
    },
    "openai": {
        "label": "OpenAI TTS",
        "groups": [{"keys": ["openaiTtsKey"], "label": "API Key"}],
        "guide": (
            "请在 设置 → 模型 → 创意媒体 填写 openaiTtsKey（可选 openaiTtsBaseUrl 自定义端点），"
            "或设置环境变量 OPENAI_TTS_API_KEY / OPENAI_API_KEY。"
        ),
    },
    "elevenlabs": {
        "label": "ElevenLabs",
        "groups": [{"keys": ["elevenLabsKey"], "label": "API Key"}],
        "guide": (
            "请在 设置 → 模型 → 创意媒体 填写 elevenLabsKey，"
            "或设置环境变量 ELEVENLABS_API_KEY / ELEVENLABS_KEY。"
        ),
    },
    "minimax": {
        "label": "MiniMax",
        "groups": [{"keys": ["minimaxKey"], "label": "API Key"}],
        "guide": (
            "请在 设置 → 模型 → 创意媒体 填写 minimaxKey，"
            "或设置环境变量 MINIMAX_API_KEY / MINIMAX_KEY。"
        ),
    },
}


# ─────────────────────────────────────────────────────────────────────────────
# Credential resolution helpers
# ─────────────────────────────────────────────────────────────────────────────

def _get_creds() -> dict[str, Any]:
    """Fetch the current media credentials dict (with defaults merged)."""
    try:
        from evoflow.persistence.media_settings import get_media_credentials

        return get_media_credentials()
    except Exception:  # pragma: no cover - defensive
        return {}


def _cred_value(creds: dict[str, Any], key: str, *env_keys: str) -> str:
    """Return a credential value from creds dict first, then env vars."""
    val = str(creds.get(key) or "").strip()
    if val:
        return val
    for ek in env_keys:
        v = os.getenv(ek, "").strip()
        if v:
            return v
    return ""


def get_provider_credential_keys(provider: str) -> list[str]:
    """Return the flat list of credential field names a provider may use."""
    req = TTS_PROVIDER_REQUIREMENTS.get(provider)
    if not req:
        return []
    keys: list[str] = []
    for group in req.get("groups", []):
        for k in group.get("keys", []):
            if k not in keys:
                keys.append(k)
    # Include optional companion fields (base URLs etc.)
    if provider == "openai":
        for k in ("openaiTtsBaseUrl",):
            if k not in keys:
                keys.append(k)
    return keys


# ─────────────────────────────────────────────────────────────────────────────
# Preflight validation
# ─────────────────────────────────────────────────────────────────────────────

def validate_tts_config(provider: str | None, creds: dict[str, Any] | None = None) -> dict[str, Any]:
    """Preflight check: is *provider* valid and are its required creds present?

    Returns ``{ok: bool, provider: str, missing?: [..], guide?: str}``.
    Mirrors the legacy voice module ``validateTTSConfig``.
    """
    prov = (provider or "").strip().lower() or DEFAULT_PROVIDER
    req = TTS_PROVIDER_REQUIREMENTS.get(prov)
    if not req:
        return {
            "ok": False,
            "provider": prov,
            "guide": (
                f"未选择有效的语音合成服务商（当前：{provider or '空'}）。"
                "请在设置中选择 火山引擎 / 豆包 / DashScope / OpenAI / ElevenLabs / MiniMax 其中之一。"
            ),
        }
    creds = creds if creds is not None else _get_creds()
    missing: list[str] = []
    for group in req.get("groups", []):
        keys = group.get("keys", [])
        # Also check env fallbacks so a key set only in env still passes.
        env_map = {
            "volcengineSpeechApiKey": ("VOLCENGINE_SPEECH_API_KEY", "ARK_API_KEY"),
            "volcengineApiKey": ("VOLCENGINE_API_KEY", "ARK_API_KEY"),
            "dashscopeApiKey": ("DASHSCOPE_API_KEY",),
            "openaiTtsKey": ("OPENAI_TTS_API_KEY", "OPENAI_API_KEY"),
            "elevenLabsKey": ("ELEVENLABS_API_KEY", "ELEVENLABS_KEY"),
            "minimaxKey": ("MINIMAX_API_KEY", "MINIMAX_KEY"),
        }
        satisfied = False
        for k in keys:
            if str(creds.get(k) or "").strip():
                satisfied = True
                break
            for ek in env_map.get(k, ()):
                if os.getenv(ek, "").strip():
                    satisfied = True
                    break
            if satisfied:
                break
        if not satisfied:
            missing.append(group.get("label", " / ".join(keys)))

    if missing:
        return {
            "ok": False,
            "provider": prov,
            "missing": missing,
            "guide": f"{req['label']} 还没配置好：缺少 {('、'.join(missing))}。{req['guide']}",
        }
    return {"ok": True, "provider": prov}


def _is_provider_configured(provider: str, creds: dict[str, Any] | None = None) -> bool:
    return bool(validate_tts_config(provider, creds).get("ok"))


def list_available_providers(creds: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    """Return provider metadata annotated with ``configured`` and ``voices``."""
    creds = creds if creds is not None else _get_creds()
    out: list[dict[str, Any]] = []
    for p in TTS_PROVIDERS:
        pid = p["id"]
        out.append(
            {
                "id": pid,
                "label": p["label"],
                "streaming": p.get("streaming", False),
                "configured": _is_provider_configured(pid, creds),
            }
        )
    return out


# ─────────────────────────────────────────────────────────────────────────────
# Unified synthesis entry points
# ─────────────────────────────────────────────────────────────────────────────

def _resolve_provider(provider: str | None) -> str:
    prov = (provider or "").strip().lower() or DEFAULT_PROVIDER
    if prov not in _PROVIDER_IDS:
        raise ValueError(
            f"未知的 TTS 服务商: {provider!r}。支持: {', '.join(_PROVIDER_IDS)}。"
        )
    return prov


def _preflight_or_raise(provider: str, creds: dict[str, Any]) -> None:
    res = validate_tts_config(provider, creds)
    if not res.get("ok"):
        raise ValueError(res.get("guide") or f"{provider} TTS 未正确配置")


def synthesize_tts(
    text: str,
    *,
    provider: str | None = None,
    speaker: str | None = None,
    preview: bool = False,
    creds: dict[str, Any] | None = None,
) -> tuple[bytes, str]:
    """Synchronous (non-streaming) TTS — returns (audio_bytes, used_speaker).

    For streaming-capable providers this accumulates the stream.  For
    MiniMax/DashScope (non-streaming) it calls their native synthesize.
    """
    prov = _resolve_provider(provider)
    creds = creds if creds is not None else _get_creds()
    _preflight_or_raise(prov, creds)
    voice = (speaker or "").strip()

    if prov in ("volcengine", "doubao"):
        # Reuse existing volcengine implementation (unchanged signature).
        from app.gateway.speech.volcengine_speech import synthesize_speech_v3

        audio, used = synthesize_speech_v3(text, speaker=voice or None, preview=preview)
        return audio, used

    if prov == "dashscope":
        from evoflow.community.media_generation.providers.dashscope_tts import synthesize_speech as _ds

        audio = _ds(text, voice=voice or None)
        return audio, voice or "longanyang"

    if prov == "openai":
        from app.gateway.speech.tts_openai import synthesize_speech as _oai

        key = _cred_value(creds, "openaiTtsKey", "OPENAI_TTS_API_KEY", "OPENAI_API_KEY")
        base = _cred_value(creds, "openaiTtsBaseUrl", "OPENAI_TTS_BASE_URL", "OPENAI_BASE_URL")
        audio = _sync_run(
            _oai(text, voice_id=voice or None, api_key=key, base_url=base or None)
        )
        return audio, voice or "nova"

    if prov == "elevenlabs":
        from app.gateway.speech.tts_elevenlabs import synthesize_speech as _el

        key = _cred_value(creds, "elevenLabsKey", "ELEVENLABS_API_KEY", "ELEVENLABS_KEY")
        audio = _sync_run(_el(text, voice_id=voice or None, api_key=key))
        return audio, voice or "pNInz6obpgDQGcFmaJgB"

    if prov == "minimax":
        from app.gateway.speech.tts_minimax import synthesize_speech as _mm

        key = _cred_value(creds, "minimaxKey", "MINIMAX_API_KEY", "MINIMAX_KEY")
        audio = _sync_run(_mm(text, voice_id=voice or None, api_key=key))
        return audio, voice or "male-qn-qingse"

    raise ValueError(f"不支持的 TTS 服务商: {prov}")


def _sync_run(coro):
    """Run an async coroutine to completion from sync context."""
    import asyncio

    try:
        loop = asyncio.get_event_loop()
        if loop.is_running():  # pragma: no cover - caller inside an event loop
            # Create a fresh loop to avoid "loop already running" deadlock.
            import concurrent.futures

            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as ex:
                return ex.submit(asyncio.run, coro).result()
    except RuntimeError:
        pass
    return asyncio.run(coro)


async def synthesize_tts_stream(
    text: str,
    *,
    provider: str | None = None,
    speaker: str | None = None,
    preview: bool = False,
    creds: dict[str, Any] | None = None,
) -> AsyncGenerator[bytes, None]:
    """Streaming TTS — yields audio chunks as they arrive from the provider."""
    prov = _resolve_provider(provider)
    creds = creds if creds is not None else _get_creds()
    _preflight_or_raise(prov, creds)
    voice = (speaker or "").strip()

    if prov in ("volcengine", "doubao"):
        from app.gateway.speech.volcengine_speech import synthesize_speech_v3_stream

        async for chunk in synthesize_speech_v3_stream(
            text, speaker=voice or None, preview=preview
        ):
            yield chunk
        return

    if prov == "dashscope":
        # DashScope has no native stream; synthesize then yield once.
        from evoflow.community.media_generation.providers.dashscope_tts import synthesize_speech as _ds

        yield _ds(text, voice=voice or None)
        return

    if prov == "openai":
        from app.gateway.speech.tts_openai import synthesize_speech_stream

        key = _cred_value(creds, "openaiTtsKey", "OPENAI_TTS_API_KEY", "OPENAI_API_KEY")
        base = _cred_value(creds, "openaiTtsBaseUrl", "OPENAI_TTS_BASE_URL", "OPENAI_BASE_URL")
        async for chunk in synthesize_speech_stream(
            text, voice_id=voice or None, api_key=key, base_url=base or None
        ):
            yield chunk
        return

    if prov == "elevenlabs":
        from app.gateway.speech.tts_elevenlabs import synthesize_speech_stream

        key = _cred_value(creds, "elevenLabsKey", "ELEVENLABS_API_KEY", "ELEVENLABS_KEY")
        async for chunk in synthesize_speech_stream(
            text, voice_id=voice or None, api_key=key
        ):
            yield chunk
        return

    if prov == "minimax":
        from app.gateway.speech.tts_minimax import synthesize_speech_stream

        key = _cred_value(creds, "minimaxKey", "MINIMAX_API_KEY", "MINIMAX_KEY")
        async for chunk in synthesize_speech_stream(
            text, voice_id=voice or None, api_key=key
        ):
            yield chunk
        return

    raise ValueError(f"不支持的 TTS 服务商: {prov}")
