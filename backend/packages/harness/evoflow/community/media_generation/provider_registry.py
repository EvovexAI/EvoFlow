"""Model id → media provider routing + channel catalog SSOT.

When the agent picks a model (e.g. ``gpt-image-2.5-sunburst`` / ``MiniMax-H3`` /
``wan2.7-image``), we resolve which credential bundle (vendor) to use automatically.
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
    ("Qwen-Image", "openai", {"image"}),  # OpenAI Images gateways (e.g. hon-maas)
    ("qwen-image", "openai", {"image"}),
    ("MiniMax-H3", "minimax", {"video"}),
    ("MiniMax-Hailuo", "minimax", {"video"}),
    ("minimax-h3", "minimax", {"video"}),  # OpenAI-Videos gateways (e.g. hon-maas)
    ("minimax-hailuo", "minimax", {"video"}),
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
    mid_l = mid.lower()
    for match, provider, caps in _MODEL_PROVIDER_RULES:
        if capability not in caps:
            continue
        if mid == match or mid.startswith(match):
            return provider
        # Case-insensitive for gateway ids like minimax-h3/QY3
        ml = match.lower()
        if mid_l == ml or mid_l.startswith(ml):
            return provider
    return None


def vendor_for_provider(provider: str | None) -> str | None:
    p = str(provider or "").strip()
    return PROVIDER_VENDOR.get(p)


def channel_image_models() -> list[dict[str, Any]]:
    """Non-Plan image models exposed in media.catalog (provider-routed Keys)."""
    return [
        {
            "id": "gpt-image-2.5-sunburst",
            "label": "GPT Image 2.5 Sunburst",
            "provider": "openai",
            "min_tier": None,
            "use_when": "画质优先；已配置 OpenAI 生图 Key",
            "protocol": "openai_images_sync",
        },
        {
            "id": "gpt-image-2.5-flare",
            "label": "GPT Image 2.5 Flare",
            "provider": "openai",
            "min_tier": None,
            "use_when": "更快的日常生图",
            "protocol": "openai_images_sync",
        },
        {
            "id": "Qwen-Image-2.1",
            "label": "Qwen-Image 2.1（OpenAI Images 网关）",
            "provider": "openai",
            "min_tier": None,
            "use_when": (
                "Base URL 填网关 …/v1（如 hon-maas）；"
                "POST /images/generations；通用路由自动选渠"
            ),
            "protocol": "openai_images_sync",
        },
        {
            "id": "Qwen-Image-2.1/QY5",
            "label": "Qwen-Image 2.1/QY5（指定渠道）",
            "provider": "openai",
            "min_tier": None,
            "use_when": "同上网关；优先指定渠道，失败自动切换",
            "protocol": "openai_images_sync",
        },
        {
            "id": "wan2.7-image",
            "label": "万相 2.7 生图",
            "provider": "wan",
            "min_tier": None,
            "use_when": "已配置通义万相 Key；多模态 messages 同步协议（推荐）",
            "protocol": "wan_multimodal_sync",
            "modes": ["text2image", "image2image"],
        },
        {
            "id": "wan2.7-image-pro",
            "label": "万相 2.7 Pro 生图",
            "provider": "wan",
            "min_tier": None,
            "use_when": "更高画质 / 4K 文生图；同 2.7 多模态协议",
            "protocol": "wan_multimodal_sync",
            "modes": ["text2image", "image2image"],
        },
        {
            "id": "wan2.6-t2i",
            "label": "万相 2.6 文生图",
            "provider": "wan",
            "min_tier": None,
            "use_when": "兼容旧账号 / 旧配额；legacy text2image 异步",
            "protocol": "wan_text2image_async",
        },
    ]


def channel_video_models() -> list[dict[str, Any]]:
    """Non-Plan video models exposed in media.catalog."""
    return [
        {
            "id": "MiniMax-H3",
            "label": "MiniMax H3（官方）",
            "provider": "minimax",
            "min_tier": None,
            "use_when": (
                "仅官方 api.minimax.cn Key；勿在 OpenAI Videos 网关下使用此 id（会 503 model_not_found）。"
                "图生视频传 first_frame_url；768P/2K · 4–15s。无官方 Key 时优先 Seedance/万相。"
            ),
            "protocol": "minimax_h3_content",
            "requires_official_key": True,
        },
        {
            "id": "MiniMax-H3-Max",
            "label": "MiniMax H3 Max（官方）",
            "provider": "minimax",
            "min_tier": None,
            "use_when": "仅官方 Key；更快出片；480P/768P · 5–15s。网关请改用 minimax-h3。",
            "protocol": "minimax_h3_content",
            "requires_official_key": True,
        },
        {
            "id": "minimax-h3",
            "label": "minimax-h3（OpenAI Videos 网关）",
            "provider": "minimax",
            "min_tier": None,
            "use_when": (
                "Base URL 填网关 …/v1（如 hon-maas）；"
                "multipart POST /videos + extra_params t2va/fl2va；"
                "图生视频用 input_references + frame_indices；"
                "渠道锁定可用 minimax-h3/QY3；"
                "勿写成 MiniMax-H3（大小写不同路由）"
            ),
            "protocol": "openai_videos",
        },
        {
            "id": "minimax-h3/QY3",
            "label": "minimax-h3/QY3（指定渠道）",
            "provider": "minimax",
            "min_tier": None,
            "use_when": "同上网关 multipart /videos；指定渠道 id",
            "protocol": "openai_videos",
        },
        {
            "id": "wan2.7-i2v",
            "label": "万相 2.7 图生视频",
            "provider": "wan",
            "min_tier": None,
            "use_when": "推荐；首帧/首尾帧走 input.media[]；可加 driving_audio",
            "protocol": "wan_media_async",
            "duration": "2–15 秒",
            "resolution": ["720P", "1080P"],
        },
        {
            "id": "wan2.7-t2v",
            "label": "万相 2.7 文生视频",
            "provider": "wan",
            "min_tier": None,
            "use_when": "无首帧时的文生视频；同 video-synthesis 异步",
            "protocol": "wan_media_async",
            "duration": "2–15 秒",
            "resolution": ["720P", "1080P"],
        },
        {
            "id": "wan2.6-i2v",
            "label": "万相 2.6 图生视频",
            "provider": "wan",
            "min_tier": None,
            "use_when": "兼容旧协议（img_url）；新任务优先 wan2.7-i2v",
            "protocol": "wan_img_url_async",
        },
        {
            "id": "wan2.6-t2v",
            "label": "万相 2.6 文生视频",
            "provider": "wan",
            "min_tier": None,
            "use_when": "兼容旧协议；新任务优先 wan2.7-t2v",
            "protocol": "wan_img_url_async",
        },
    ]


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
            "priority": "设置 → 模型 → 生图生视频 → 通义万相：填 API Key + 可选 Base URL，并启用该渠道",
            "models_hint": ["wan2.7-image", "wan2.7-i2v", "wan2.7-t2v", "wan2.6-t2i", "wan2.6-i2v"],
            "protocols": {
                "wan2.7-image": "multimodal-generation sync (messages/content)",
                "wan2.7-i2v": "video-synthesis async (input.media[])",
                "wan2.6-*": "legacy text2image / img_url",
            },
        },
        {
            "provider": "openai",
            "vendor": "openai-image",
            "label": "OpenAI / GPT 生图（含兼容网关）",
            "api_key_fields": ["openaiImageApiKey"],
            "base_url_fields": ["openaiImageBaseUrl"],
            "default_base_url": "https://api.openai.com/v1",
            "priority": (
                "设置 → 模型 → 生图生视频 → OpenAI 生图：填 API Key + Base URL。"
                "官方用 api.openai.com；hon-maas 等网关填 …/v1，模型用 Qwen-Image-2.1"
            ),
            "models_hint": [
                "gpt-image-2.5-sunburst",
                "gpt-image-2.5-flare",
                "Qwen-Image-2.1",
                "Qwen-Image-2.1/QY5",
            ],
            "protocols": {
                "official_gpt_image": "POST {base}/images/generations",
                "qwen_image_gateway": "同上路径；model=Qwen-Image-2.1[/渠道]",
            },
        },
        {
            "provider": "minimax",
            "vendor": "minimax",
            "label": "MiniMax 视频（H3）",
            "api_key_fields": ["minimaxMediaApiKey"],
            "base_url_fields": ["minimaxMediaBaseUrl"],
            "default_base_url": "https://api.minimax.cn",
            "priority": "设置 → 模型 → 生图生视频 → MiniMax：填 API Key + Base URL",
            "models_hint": ["MiniMax-H3", "MiniMax-H3-Max", "minimax-h3", "minimax-h3/QY3"],
            "protocols": {
                "official": "POST {base}/v2/video_generation（api.minimax.cn）",
                "openai_videos_gateway": (
                    "multipart POST {base}/videos（base …/v1；"
                    "size/width/height/aspect_ratio + extra_params t2va|fl2va；"
                    "图生：repeated input_references + frame_indices [0]|[0,-1]）"
                ),
            },
        },
        {
            "provider": "kling",
            "vendor": "kling",
            "label": "可灵",
            "api_key_fields": ["klingApiKey", "klingAccessKeyId+klingAccessKeySecret"],
            "base_url_fields": ["klingApiBase"],
            "default_base_url": "https://api.klingai.com",
            "priority": "设置 → 模型 → 生图生视频 → 可灵",
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
                    "wan → 上传为 oss:// 临时地址（2.7 media[] / 2.6 img_url 均可）"
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
            "wan_27": ["jpeg", "jpg", "png", "bmp", "webp"],
        },
        "limits": {
            "ark": "单张 ≤30MB；宽高比约 1/16–16；Seedream 5.0 pro/flash 最多约 10 张参考图",
            "minimax": "≤20MB；短边 >300px；宽高比 2:5–5:2",
            "wan": "首帧/尾帧 ≤20MB；宽高 [240,8000]；宽高比 1:8～8:1",
        },
        "do_not": [
            "不要传裸 base64（无 data:image/...;base64, 前缀）——方舟会当 URL 解析并报 InvalidParameter",
            "不要假设绝对本地路径能被远端直接读；必须走 resolver（自动转 Data URI / oss）",
        ],
    }


def key_routing_summary() -> str:
    return (
        "传 model 时会按模型前缀自动选 provider，再用该渠道的 API Key / Base URL。"
        "也可显式传 provider=jimeng|wan|openai|minimax|kling。"
        "火山优先 Agent Plan 绑定 Key（套餐模型 ID 如 doubao-seedream-5-0-pro / doubao-seedance-2.5）；"
        "自定义按量 Key 走 /api/v3 时需用官方带日期快照 ID（如 doubao-seedream-5-0-pro-260628）。"
        "万相：wan2.7-* 走新协议（生图 multimodal sync / 视频 media[]）；"
        "wan2.6-* 仍可用旧协议（text2image / img_url）做兼容。"
    )
