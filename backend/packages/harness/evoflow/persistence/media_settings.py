"""Media provider API credentials in ``evoflow_app_settings`` (key ``media.credentials``)."""

from __future__ import annotations

import copy
import os
from typing import Any

from evoflow.persistence import config_repositories as cfg_repo

MEDIA_CREDENTIALS_KEY = "media.credentials"

# Public field names (camelCase, stored in JSON as-is)
SECRET_FIELDS = frozenset(
    {
        "dashscopeApiKey",
        "klingAccessKeyId",
        "klingAccessKeySecret",
        "klingApiKey",
        "volcengineApiKey",
        "agnesApiKey",
        "volcengineSpeechApiKey",
        "volcengineTtsAccessToken",
        "aliyunAccessKeySecret",
        "openaiTtsKey",
        "elevenLabsKey",
        "minimaxKey",
    }
)

DEFAULT_MEDIA_CREDENTIALS: dict[str, Any] = {
    "dashscopeApiKey": "",
    "dashscopeBaseUrl": "",
    "klingAccessKeyId": "",
    "klingAccessKeySecret": "",
    "klingApiKey": "",
    "klingApiBase": "",
    "volcengineApiKey": "",
    "agnesApiKey": "",
    "volcengineArkBaseUrl": "",
    "jimengImageModel": "doubao-seedream-5.0-lite",
    "jimengVideoModel": "doubao-seedance-2.0",
    "jimengVideoBaseUrl": "",
    "volcengineTtsAppId": "",
    "volcengineTtsAccessToken": "",
    "volcengineSpeechApiKey": "",
    "volcengineTtsCluster": "volcano_tts",
    "volcengineTtsResourceId": "seed-tts-2.0",
    "volcengineTtsSpeaker": "zh_female_vv_uranus_bigtts",
    "volcengineAsrResourceId": "volc.seedasr.sauc.duration",
    # Multi-provider TTS credentials (OpenAI / ElevenLabs / MiniMax).
    # These are read by app.gateway.speech.tts_registry and its providers.
    "openaiTtsKey": "",
    "openaiTtsBaseUrl": "",
    "elevenLabsKey": "",
    "minimaxKey": "",
    "aliyunAccessKeyId": "",
    "aliyunAccessKeySecret": "",
    "aliyunOssBucket": "",
    "aliyunImsEndpoint": "",
    "enabledVendors": {
        "volcengine": True,
        "agnes": False,
        "dashscope": False,
        "kling": False,
        "volcengine-tts": False,
        "aliyun": False,
    },
}

DEFAULT_ENABLED_VENDORS: dict[str, bool] = dict(DEFAULT_MEDIA_CREDENTIALS["enabledVendors"])  # type: ignore[arg-type]

# Stable vendor ids (enabledVendors keys) → logical credential aliases exposed to scripts.
# SQLite field names are internal; remap here when storage changes — skill scripts only use aliases.
VENDOR_CREDENTIAL_ALIASES: dict[str, dict[str, str]] = {
    "volcengine": {
        "apiKey": "volcengineApiKey",
        "arkBaseUrl": "volcengineArkBaseUrl",
        "jimengVideoBaseUrl": "jimengVideoBaseUrl",
        "jimengImageModel": "jimengImageModel",
        "jimengVideoModel": "jimengVideoModel",
    },
    "agnes": {"apiKey": "agnesApiKey"},
    "dashscope": {"apiKey": "dashscopeApiKey", "baseUrl": "dashscopeBaseUrl"},
    "kling": {
        "accessKeyId": "klingAccessKeyId",
        "accessKeySecret": "klingAccessKeySecret",
        "apiKey": "klingApiKey",
        "apiBase": "klingApiBase",
    },
    "volcengine-tts": {
        "speechApiKey": "volcengineSpeechApiKey",
        "apiKey": "volcengineApiKey",
        "ttsAppId": "volcengineTtsAppId",
        "ttsAccessToken": "volcengineTtsAccessToken",
        "ttsCluster": "volcengineTtsCluster",
        "ttsResourceId": "volcengineTtsResourceId",
        "ttsSpeaker": "volcengineTtsSpeaker",
        "asrResourceId": "volcengineAsrResourceId",
    },
    "aliyun": {
        "accessKeyId": "aliyunAccessKeyId",
        "accessKeySecret": "aliyunAccessKeySecret",
        "ossBucket": "aliyunOssBucket",
        "imsEndpoint": "aliyunImsEndpoint",
    },
    # Multi-provider TTS vendors (no enabledVendors toggle; availability is
    # determined by validate_tts_config in tts_registry based on credentials).
    "openai-tts": {
        "apiKey": "openaiTtsKey",
        "baseUrl": "openaiTtsBaseUrl",
    },
    "elevenlabs-tts": {
        "apiKey": "elevenLabsKey",
    },
    "minimax-tts": {
        "apiKey": "minimaxKey",
    },
}

# Provider names used in harness/scripts → vendor id in settings UI.
PROVIDER_TO_VENDOR: dict[str, str] = {
    "jimeng": "volcengine",
    "wan": "dashscope",
    "kling": "kling",
    "agnes": "agnes",
    "volcengine": "volcengine",
    "dashscope": "dashscope",
}

VENDOR_UI_LABELS: dict[str, str] = {
    "volcengine": "火山方舟",
    "agnes": "Agnes AI",
    "dashscope": "通义万相",
    "kling": "可灵",
    "volcengine-tts": "火山 TTS",
    "aliyun": "阿里云",
    "openai-tts": "OpenAI TTS",
    "elevenlabs-tts": "ElevenLabs",
    "minimax-tts": "MiniMax",
}


def normalize_vendor_id(vendor_or_provider: str) -> str:
    raw = str(vendor_or_provider or "").strip().lower()
    return PROVIDER_TO_VENDOR.get(raw, raw)


def get_vendor_credentials(vendor_id: str, *, require_enabled: bool = True) -> dict[str, str]:
    """Read credentials by stable vendor id; returns logical aliases (not env var names)."""
    vendor = normalize_vendor_id(vendor_id)
    aliases = VENDOR_CREDENTIAL_ALIASES.get(vendor)
    if not aliases:
        return {}
    if require_enabled and not get_enabled_vendors().get(vendor, False):
        return {}
    creds = get_media_credentials()
    out: dict[str, str] = {}
    for alias, field in aliases.items():
        val = str(creds.get(field) or "").strip()
        if val:
            out[alias] = val
    return out


def vendor_has_usable_credentials(vendor_id: str, *, require_enabled: bool = True) -> bool:
    bundle = get_vendor_credentials(vendor_id, require_enabled=require_enabled)
    vendor = normalize_vendor_id(vendor_id)
    if vendor == "kling":
        if bundle.get("apiKey"):
            return True
        return bool(bundle.get("accessKeyId") and bundle.get("accessKeySecret"))
    if vendor == "volcengine-tts":
        return bool(bundle.get("ttsAppId") and bundle.get("ttsAccessToken"))
    if vendor == "aliyun":
        return bool(bundle.get("accessKeyId") and bundle.get("accessKeySecret"))
    return bool(bundle.get("apiKey"))


def vendor_setup_hint(vendor_id: str) -> str:
    vendor = normalize_vendor_id(vendor_id)
    label = VENDOR_UI_LABELS.get(vendor, vendor_id)
    return (
        f"未配置或未启用 {label}。"
        f"请在 EvoFlow → 设置 → 模型 → 创意媒体 → {label} 填写凭据并打开启用开关。"
    )


def _deep_merge_defaults(raw: Any) -> dict[str, Any]:
    base = copy.deepcopy(DEFAULT_MEDIA_CREDENTIALS)
    if not isinstance(raw, dict):
        return base
    for k, v in raw.items():
        if k == "enabledVendors" and isinstance(v, dict):
            merged = dict(DEFAULT_ENABLED_VENDORS)
            for ek, ev in v.items():
                if ek in merged:
                    merged[ek] = bool(ev)
            base["enabledVendors"] = merged
            continue
        if k in base or k in SECRET_FIELDS or k.endswith("Url") or k.endswith("Endpoint") or k.endswith("Model"):
            base[k] = v if v is not None else ""
    return base


def get_enabled_vendors() -> dict[str, bool]:
    creds = get_media_credentials()
    raw = creds.get("enabledVendors")
    out = dict(DEFAULT_ENABLED_VENDORS)
    if isinstance(raw, dict):
        for k, v in raw.items():
            if k in out:
                out[k] = bool(v)
    return out


def get_media_credentials() -> dict[str, Any]:
    raw = cfg_repo.get_app_setting(MEDIA_CREDENTIALS_KEY)
    return _deep_merge_defaults(raw)


def _mask_secret(value: Any) -> str | None:
    if value is None:
        return None
    s = str(value).strip()
    if not s:
        return None
    if len(s) <= 4:
        return "****"
    return "*" * min(len(s) - 4, 12) + s[-4:]


def get_media_credentials_masked() -> dict[str, Any]:
    """Return credentials for API/UI with secrets masked."""
    creds = get_media_credentials()
    out: dict[str, Any] = {}
    configured: dict[str, bool] = {}
    for k, v in creds.items():
        if k in SECRET_FIELDS:
            masked = _mask_secret(v)
            out[k] = masked
            configured[k] = bool(str(v or "").strip())
        elif k == "enabledVendors" and isinstance(v, dict):
            out[k] = {ek: bool(ev) for ek, ev in v.items() if ek in DEFAULT_ENABLED_VENDORS}
        else:
            out[k] = v
    out["_configured"] = configured
    return out


def patch_media_credentials(patch: dict[str, Any] | None) -> dict[str, Any]:
    if not isinstance(patch, dict) or not patch:
        return get_media_credentials()
    current = get_media_credentials()
    for k, v in patch.items():
        if k.startswith("_"):
            continue
        if k == "enabledVendors" and isinstance(v, dict):
            ev = dict(get_enabled_vendors())
            for ek, val in v.items():
                if ek in ev:
                    ev[ek] = bool(val)
            current["enabledVendors"] = ev
            continue
        if k not in current and k not in SECRET_FIELDS:
            current[k] = v
            continue
        if k in SECRET_FIELDS:
            if v is None:
                current[k] = ""
            elif isinstance(v, str) and not v.strip():
                continue
            else:
                current[k] = str(v).strip()
        else:
            current[k] = "" if v is None else v
    cfg_repo.set_app_setting(MEDIA_CREDENTIALS_KEY, current)
    return current


# (env_var, credential_field) — only applied when vendor is enabled in EvoPanel
_VENDOR_ENV_BINDINGS: dict[str, list[tuple[str, str]]] = {
    "dashscope": [
        ("DASHSCOPE_API_KEY", "dashscopeApiKey"),
        ("DASHSCOPE_BASE_URL", "dashscopeBaseUrl"),
    ],
    "kling": [
        ("KLING_ACCESS_KEY_ID", "klingAccessKeyId"),
        ("KLING_ACCESS_KEY_SECRET", "klingAccessKeySecret"),
        ("KLING_API_KEY", "klingApiKey"),
        ("KLING_API_BASE", "klingApiBase"),
    ],
    "volcengine": [
        ("VOLCENGINE_API_KEY", "volcengineApiKey"),
        ("ARK_API_KEY", "volcengineApiKey"),
        ("VOLCENGINE_ARK_BASE_URL", "volcengineArkBaseUrl"),
        ("ARK_API_BASE_URL", "volcengineArkBaseUrl"),
        ("ARK_SEEDREAM_API_BASE_URL", "volcengineArkBaseUrl"),
        ("JIMENG_VIDEO_BASE_URL", "jimengVideoBaseUrl"),
        ("ARK_SEEDREAM_MODEL", "jimengImageModel"),
        ("ARK_MODEL", "jimengImageModel"),
        ("JIMENG_IMAGE_MODEL", "jimengImageModel"),
        ("JIMENG_VIDEO_MODEL", "jimengVideoModel"),
        ("SEEDANCE_MODEL", "jimengVideoModel"),
    ],
    "agnes": [
        ("AGNES_API_KEY", "agnesApiKey"),
        ("AGNES_API_TOKEN", "agnesApiKey"),
        ("APIHUB_AGNES_API_KEY", "agnesApiKey"),
    ],
    "volcengine-tts": [
        ("VOLCENGINE_SPEECH_API_KEY", "volcengineSpeechApiKey"),
        ("BYTEPLUS_SEED_SPEECH_API_KEY", "volcengineSpeechApiKey"),
        ("VOLCENGINE_API_KEY", "volcengineApiKey"),
        ("ARK_API_KEY", "volcengineApiKey"),
        ("VOLCENGINE_TTS_APPID", "volcengineTtsAppId"),
        ("VOLCENGINE_TTS_ACCESS_TOKEN", "volcengineTtsAccessToken"),
        ("VOLCENGINE_TTS_CLUSTER", "volcengineTtsCluster"),
        ("VOLCENGINE_TTS_RESOURCE_ID", "volcengineTtsResourceId"),
        ("VOLCENGINE_TTS_SPEAKER", "volcengineTtsSpeaker"),
        ("VOLCENGINE_ASR_RESOURCE_ID", "volcengineAsrResourceId"),
    ],
    "aliyun": [
        ("ALIYUN_ACCESS_KEY_ID", "aliyunAccessKeyId"),
        ("ALIYUN_ACCESS_KEY_SECRET", "aliyunAccessKeySecret"),
        ("ALIYUN_OSS_BUCKET", "aliyunOssBucket"),
        ("ALIYUN_IMS_ENDPOINT", "aliyunImsEndpoint"),
    ],
}


def apply_media_credentials_to_mapping(env: dict[str, str]) -> None:
    """Overlay stored media credentials onto *env* for enabled vendors only."""
    creds = get_media_credentials()
    enabled = get_enabled_vendors()
    managed_keys = {ek for bindings in _VENDOR_ENV_BINDINGS.values() for ek, _ in bindings}
    overlay: dict[str, str] = {}

    for vendor, bindings in _VENDOR_ENV_BINDINGS.items():
        if not bool(enabled.get(vendor, False)):
            continue
        for env_key, cred_key in bindings:
            s = str(creds.get(cred_key) or "").strip()
            if s:
                overlay[env_key] = s

    for key in managed_keys:
        env.pop(key, None)
    env.update(overlay)


def apply_media_credentials_to_environ() -> None:
    """Overlay stored credentials onto process env for **enabled** vendors only."""
    apply_media_credentials_to_mapping(os.environ)
