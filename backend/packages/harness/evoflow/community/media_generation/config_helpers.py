from __future__ import annotations

import os
from typing import Any

from evoflow.config import get_app_config

from .schemas import ImageProvider, VideoProvider, VoiceProvider


def ensure_media_credentials() -> None:
    """Load credentials from EvoPanel settings store into os.environ."""
    try:
        from evoflow.persistence.media_settings import apply_media_credentials_to_environ

        apply_media_credentials_to_environ()
    except Exception:
        pass


def _plan_media_route(capability: str) -> dict[str, Any] | None:
    """Active Agent Plan route for image/video when bound."""
    try:
        from evoflow.plans.resolver import resolve_capability

        route = resolve_capability(capability, vendor="volcengine", allow_missing=True)
        if route and str(route.get("source") or "") == "plan":
            return route
    except Exception:
        pass
    return None


def _tool_extra(tool_name: str) -> dict[str, Any]:
    cfg = get_app_config().get_tool_config(tool_name)
    if cfg is None:
        return {}
    return dict(cfg.model_extra or {})


def default_image_provider(tool_name: str = "media_image_generate") -> ImageProvider:
    raw = str(_tool_extra(tool_name).get("default_provider") or os.getenv("MEDIA_DEFAULT_IMAGE_PROVIDER") or "jimeng")
    if raw in ("jimeng", "kling", "wan"):
        return raw  # type: ignore[return-value]
    return "jimeng"


def default_video_provider(tool_name: str = "media_video_generate") -> VideoProvider:
    raw = str(_tool_extra(tool_name).get("default_provider") or os.getenv("MEDIA_DEFAULT_VIDEO_PROVIDER") or "jimeng")
    if raw in ("jimeng", "kling", "wan"):
        return raw  # type: ignore[return-value]
    return "jimeng"


def default_voice_provider(tool_name: str = "media_voiceover_synthesize") -> VoiceProvider:
    raw = str(
        _tool_extra(tool_name).get("default_provider")
        or os.getenv("MEDIA_DEFAULT_VOICE_PROVIDER")
        or "volcengine"
    )
    return "dashscope" if raw == "dashscope" else "volcengine"


def kling_credentials() -> tuple[str, str]:
    try:
        from evoflow.persistence.media_settings import get_vendor_credentials

        bundle = get_vendor_credentials("kling")
        key_id = bundle.get("accessKeyId", "")
        secret = bundle.get("accessKeySecret", "")
        if key_id and secret:
            return key_id, secret
        single = bundle.get("apiKey", "")
        if single:
            return single, ""
    except Exception:
        pass
    return "", ""


def dashscope_api_key() -> str:
    try:
        from evoflow.persistence.media_settings import get_vendor_credentials

        return get_vendor_credentials("dashscope").get("apiKey", "")
    except Exception:
        return ""


def dashscope_base_url() -> str:
    default = "https://dashscope.aliyuncs.com/api/v1"
    try:
        from evoflow.persistence.media_settings import get_vendor_credentials

        return get_vendor_credentials("dashscope").get("baseUrl", default).rstrip("/") or default
    except Exception:
        return default


def kling_api_base() -> str:
    default = "https://api.klingai.com"
    try:
        from evoflow.persistence.media_settings import get_vendor_credentials

        return get_vendor_credentials("kling").get("apiBase", default).rstrip("/") or default
    except Exception:
        return default


def volcengine_api_key() -> str:
    for cap in ("image", "video"):
        route = _plan_media_route(cap)
        if route:
            key = str(route.get("api_key") or "").strip()
            if key and not key.startswith("*"):
                return key
    try:
        from evoflow.persistence.media_settings import get_vendor_credentials

        return get_vendor_credentials("volcengine").get("apiKey", "")
    except Exception:
        return ""


def volcengine_ark_base() -> str:
    default = "https://ark.cn-beijing.volces.com/api/plan/v3"
    route = _plan_media_route("image") or _plan_media_route("video")
    if route:
        base = str(route.get("base_url") or "").strip().rstrip("/")
        if base:
            if base.endswith("/api/v3"):
                return base[: -len("/api/v3")] + "/api/plan/v3"
            return base
    try:
        from evoflow.persistence.media_settings import get_vendor_credentials

        base = get_vendor_credentials("volcengine").get("arkBaseUrl", default).rstrip("/")
    except Exception:
        base = default
    if base.endswith("/api/v3"):
        return base[: -len("/api/v3")] + "/api/plan/v3"
    return base or default


def jimeng_video_base() -> str:
    try:
        from evoflow.persistence.media_settings import get_vendor_credentials

        bundle = get_vendor_credentials("volcengine")
        custom = bundle.get("jimengVideoBaseUrl", "").rstrip("/")
        if custom:
            return custom
    except Exception:
        pass
    return volcengine_ark_base().rstrip("/")


DEFAULT_JIMENG_IMAGE_MODEL = "doubao-seedream-5.0-lite"
DEFAULT_JIMENG_VIDEO_MODEL = "doubao-seedance-2.0"


def jimeng_image_model() -> str:
    route = _plan_media_route("image")
    if route and route.get("model_hint"):
        return str(route["model_hint"])
    try:
        from evoflow.persistence.media_settings import get_vendor_credentials

        m = get_vendor_credentials("volcengine").get("jimengImageModel", "")
        if m:
            return m
    except Exception:
        pass
    return DEFAULT_JIMENG_IMAGE_MODEL


def jimeng_video_model() -> str:
    route = _plan_media_route("video")
    if route and route.get("model_hint"):
        return str(route["model_hint"])
    try:
        from evoflow.persistence.media_settings import get_vendor_credentials

        m = get_vendor_credentials("volcengine").get("jimengVideoModel", "")
        if m:
            return m
    except Exception:
        pass
    return DEFAULT_JIMENG_VIDEO_MODEL


def aliyun_credentials() -> tuple[str, str, str]:
    try:
        from evoflow.persistence.media_settings import get_vendor_credentials

        bundle = get_vendor_credentials("aliyun")
        return (
            bundle.get("accessKeyId", ""),
            bundle.get("accessKeySecret", ""),
            bundle.get("ossBucket", ""),
        )
    except Exception:
        return "", "", ""


def is_jimeng_configured() -> bool:
    try:
        from evoflow.persistence.media_settings import vendor_has_usable_credentials

        return vendor_has_usable_credentials("volcengine")
    except Exception:
        return False


def is_wan_configured() -> bool:
    try:
        from evoflow.persistence.media_settings import vendor_has_usable_credentials

        return vendor_has_usable_credentials("dashscope")
    except Exception:
        return False


def is_kling_configured() -> bool:
    try:
        from evoflow.persistence.media_settings import vendor_has_usable_credentials

        return vendor_has_usable_credentials("kling")
    except Exception:
        return False


def is_volcengine_tts_configured() -> bool:
    try:
        from evoflow.persistence.media_settings import vendor_has_usable_credentials

        return vendor_has_usable_credentials("volcengine-tts")
    except Exception:
        return False


def is_dashscope_tts_configured() -> bool:
    return is_wan_configured()


IMAGE_PROVIDER_VENDOR: dict[str, str] = {"jimeng": "volcengine", "wan": "dashscope", "kling": "kling"}
VOICE_PROVIDER_VENDOR: dict[str, str] = {"volcengine": "volcengine-tts", "dashscope": "dashscope"}


def is_vendor_enabled(vendor_key: str) -> bool:
    try:
        from evoflow.persistence.media_settings import get_enabled_vendors

        return bool(get_enabled_vendors().get(vendor_key, False))
    except Exception:
        return vendor_key == "volcengine"


def _image_provider_has_credentials(provider: str) -> bool:
    if provider == "jimeng":
        return is_jimeng_configured()
    if provider == "wan":
        return is_wan_configured()
    if provider == "kling":
        return is_kling_configured()
    return False


def is_image_provider_configured(provider: str) -> bool:
    vendor = IMAGE_PROVIDER_VENDOR.get(provider)
    if not vendor or not is_vendor_enabled(vendor):
        return False
    return _image_provider_has_credentials(provider)


def is_video_provider_configured(provider: str) -> bool:
    return is_image_provider_configured(provider)


def _voice_provider_has_credentials(provider: str) -> bool:
    if provider == "volcengine":
        return is_volcengine_tts_configured()
    if provider == "dashscope":
        return is_dashscope_tts_configured()
    return False


def is_voice_provider_configured(provider: str) -> bool:
    vendor = VOICE_PROVIDER_VENDOR.get(provider)
    if not vendor or not is_vendor_enabled(vendor):
        return False
    return _voice_provider_has_credentials(provider)


def configured_image_providers() -> list[ImageProvider]:
    out: list[ImageProvider] = []
    for p in ("jimeng", "wan", "kling"):
        if is_image_provider_configured(p):
            out.append(p)  # type: ignore[arg-type]
    return out


def configured_video_providers() -> list[VideoProvider]:
    return configured_image_providers()  # type: ignore[return-value]


def configured_voice_providers() -> list[VoiceProvider]:
    out: list[VoiceProvider] = []
    for p in ("volcengine", "dashscope"):
        if is_voice_provider_configured(p):
            out.append(p)  # type: ignore[arg-type]
    return out


def available_media_providers() -> dict[str, list[str]]:
    return {
        "image": list(configured_image_providers()),
        "video": list(configured_video_providers()),
        "voice": list(configured_voice_providers()),
    }


def provider_unavailable_message(provider: str, *, media_kind: str) -> str | None:
    """Return error text if provider credentials are missing or disabled; else None."""
    if media_kind in ("image", "video"):
        vendor = IMAGE_PROVIDER_VENDOR.get(provider)
        if vendor and not is_vendor_enabled(vendor):
            return (
                f"媒体 provider {provider!r} 已停用，拒绝调用。"
                "请在 EvoPanel → 设置 → 模型 → 视频模型 中启用该厂商后再试。"
            )
        if is_image_provider_configured(provider):
            return None
        available = configured_image_providers()
        label = {"jimeng": "火山方舟(jimeng)", "wan": "通义万相(wan)", "kling": "可灵(kling)"}
    elif media_kind == "voice":
        vendor = VOICE_PROVIDER_VENDOR.get(provider)
        if vendor and not is_vendor_enabled(vendor):
            return (
                f"媒体 provider {provider!r} 已停用，拒绝调用。"
                "请在 EvoPanel → 设置 → 模型 → 视频模型 中启用该厂商后再试。"
            )
        if is_voice_provider_configured(provider):
            return None
        available = configured_voice_providers()
        label = {"volcengine": "火山 TTS", "dashscope": "DashScope TTS"}
    else:
        return None

    if not available:
        return (
            f"媒体 provider {provider!r} 未配置 API Key。"
            "请先在 EvoPanel → 设置 → 模型 → 视频模型 中保存对应厂商凭据。"
        )
    names = ", ".join(label.get(p, p) for p in available)
    return (
        f"媒体 provider {provider!r} 未配置，已拒绝调用。"
        f" 当前仅已配置：{names}。"
        f" 请勿使用未配置的渠道。"
    )


def resolve_image_provider(explicit: str | None, tool_name: str = "media_image_generate") -> tuple[str, str | None]:
    ensure_media_credentials()
    if explicit:
        err = provider_unavailable_message(explicit, media_kind="image")
        return explicit, err
    preferred = default_image_provider(tool_name)
    if is_image_provider_configured(preferred):
        return preferred, None
    for p in configured_image_providers():
        return p, None
    return preferred, provider_unavailable_message(preferred, media_kind="image")


def resolve_video_provider(explicit: str | None, tool_name: str = "media_video_generate") -> tuple[str, str | None]:
    ensure_media_credentials()
    if explicit:
        err = provider_unavailable_message(explicit, media_kind="video")
        return explicit, err
    preferred = default_video_provider(tool_name)
    if is_video_provider_configured(preferred):
        return preferred, None
    for p in configured_video_providers():
        return p, None
    return preferred, provider_unavailable_message(preferred, media_kind="video")


def resolve_voice_provider(explicit: str | None, tool_name: str = "media_voiceover_synthesize") -> tuple[str, str | None]:
    ensure_media_credentials()
    if explicit:
        err = provider_unavailable_message(explicit, media_kind="voice")
        return explicit, err
    preferred = default_voice_provider(tool_name)
    if is_voice_provider_configured(preferred):
        return preferred, None
    for p in configured_voice_providers():
        return p, None
    return preferred, provider_unavailable_message(preferred, media_kind="voice")
