"""Model id → media provider routing.

When the agent picks a model (e.g. ``gpt-image-2.5-sunburst`` / ``MiniMax-H3``),
we resolve which credential bundle (vendor) to use automatically.
"""

from __future__ import annotations

from typing import Any, Literal

Capability = Literal["image", "video"]

# Longest-prefix / exact model id → provider key used by tools/config_helpers.
_MODEL_PROVIDER_RULES: list[tuple[str, str, set[str]]] = [
    # (match, provider, capabilities) — match is exact id or prefix*
    ("doubao-seedream", "jimeng", {"image"}),
    ("doubao-seedance", "jimeng", {"video"}),
    ("jimeng", "jimeng", {"image", "video"}),
    ("wan2.", "wan", {"image", "video"}),
    ("wanx", "wan", {"image", "video"}),
    ("kling", "kling", {"image", "video"}),
    ("gpt-image", "openai", {"image"}),
    ("dall-e", "openai", {"image"}),
    ("MiniMax-H3", "minimax", {"video"}),
    ("MiniMax-Hailuo", "minimax", {"video"}),
    ("I2V-01", "minimax", {"video"}),
    ("T2V-01", "minimax", {"video"}),
]

# Provider → settings vendor id (media.credentials enabledVendors key)
PROVIDER_VENDOR: dict[str, str] = {
    "jimeng": "volcengine",
    "wan": "dashscope",
    "kling": "kling",
    "openai": "openai-image",
    "minimax": "minimax",
}


def provider_for_model(model_id: str | None, *, capability: Capability = "image") -> str | None:
    mid = str(model_id or "").strip()
    if not mid:
        return None
    for match, provider, caps in _MODEL_PROVIDER_RULES:
        if capability not in caps:
            continue
        if mid == match or mid.startswith(match):
            return provider
    return None


def vendor_for_provider(provider: str | None) -> str | None:
    p = str(provider or "").strip()
    return PROVIDER_VENDOR.get(p)


def credential_sources() -> list[dict[str, Any]]:
    """Human-readable where each channel's Key / Base URL is stored."""
    return [
        {
            "provider": "jimeng",
            "vendor": "volcengine",
            "label": "火山方舟（Seedream / Seedance）",
            "api_key_fields": ["volcengineApiKey"],
            "base_url_fields": ["volcengineArkBaseUrl"],
            "default_base_url": "https://ark.cn-beijing.volces.com/api/plan/v3",
            "priority": "若已绑定 Agent Plan，优先用套餐 ark- Key；否则用设置 → 模型 → 媒体渠道里的火山 Key",
            "models_hint": ["doubao-seedream-5-0-pro", "doubao-seedance-2.5"],
        },
        {
            "provider": "wan",
            "vendor": "dashscope",
            "label": "通义万相（DashScope）",
            "api_key_fields": ["dashscopeApiKey"],
            "base_url_fields": ["dashscopeBaseUrl"],
            "default_base_url": "https://dashscope.aliyuncs.com/api/v1",
            "priority": "设置 → 模型 → 媒体渠道 → 通义万相：填 API Key + 可选 Base URL，并启用该渠道",
            "models_hint": ["wan2.7-image", "wan2.7-i2v", "wan2.6-t2i"],
        },
        {
            "provider": "openai",
            "vendor": "openai-image",
            "label": "OpenAI / GPT 生图",
            "api_key_fields": ["openaiImageApiKey"],
            "base_url_fields": ["openaiImageBaseUrl"],
            "default_base_url": "https://api.openai.com/v1",
            "priority": "设置 → 模型 → 媒体渠道 → OpenAI 生图：填 API Key + Base URL（可用兼容网关）",
            "models_hint": ["gpt-image-2.5-sunburst", "gpt-image-2.5-flare"],
        },
        {
            "provider": "minimax",
            "vendor": "minimax",
            "label": "MiniMax 视频（H3）",
            "api_key_fields": ["minimaxMediaApiKey"],
            "base_url_fields": ["minimaxMediaBaseUrl"],
            "default_base_url": "https://api.minimax.cn",
            "priority": "设置 → 模型 → 媒体渠道 → MiniMax：填 API Key + Base URL",
            "models_hint": ["MiniMax-H3", "MiniMax-H3-Max"],
        },
        {
            "provider": "kling",
            "vendor": "kling",
            "label": "可灵",
            "api_key_fields": ["klingApiKey", "klingAccessKeyId+klingAccessKeySecret"],
            "base_url_fields": ["klingApiBase"],
            "default_base_url": "https://api.klingai.com",
            "priority": "设置 → 模型 → 媒体渠道 → 可灵",
            "models_hint": ["kling"],
        },
    ]


def input_image_formats() -> dict[str, Any]:
    """Document how to pass reference / first-frame images — verified against vendor docs."""
    return {
        "accepted": [
            {
                "form": "https_url",
                "example": "https://example.com/frame.png",
                "notes": "公网可访问；不要带登录 Cookie / 私有链临时过期",
            },
            {
                "form": "data_uri_base64",
                "example": "data:image/png;base64,iVBORw0KGgo...",
                "notes": "官方要求完整 Data URI；MIME 小写；禁止裸 base64",
            },
            {
                "form": "local_outputs_path",
                "example": "outputs/media_image_xxx.png 或 absolute_path",
                "notes": (
                    "平台会自动转换：jimeng/openai/minimax → data:image/...;base64；"
                    "wan → 上传为 oss:// 临时地址"
                ),
            },
            {
                "form": "asset_id",
                "example": "asset://ASSET_ID",
                "notes": "仅火山方舟素材库；图生视频可用",
            },
        ],
        "file_formats": {
            "ark_seedream_seedance": ["jpeg", "png", "webp", "bmp", "tiff", "gif", "heic", "heif"],
            "minimax_hailuo": ["jpg", "jpeg", "png", "webp"],
        },
        "limits": {
            "ark": "单张 ≤30MB；宽高比约 1/16–16；Seedream 5.0 pro/flash 最多约 10 张参考图",
            "minimax": "≤20MB；短边 >300px；宽高比 2:5–5:2",
        },
        "do_not": [
            "不要传裸 base64（无 data:image/...;base64, 前缀）——方舟会当 URL 解析并报 InvalidParameter",
            "不要假设绝对本地路径能被远端直接读；必须走 resolver（自动转 Data URI / oss）",
        ],
    }
