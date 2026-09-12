"""Map aspect_ratio strings to provider-specific image size parameters."""

from __future__ import annotations

import math
import re

# Seedream 5.0 Lite: each side ≥ 512px, total pixels ≥ 3,686,400 (e.g. 2560x1440).
MIN_JIMENG_PIXELS = 3_686_400
MIN_JIMENG_SIDE = 512

_JIMENG_IMAGE_SIZE_BY_RATIO: dict[str, str] = {
    "16:9": "2560x1440",
    "9:16": "1440x2560",
    "1:1": "1920x1920",
    "4:3": "2560x1920",
    "3:4": "1920x2560",
}

_JIMENG_IMAGE_SIZE_4K_BY_RATIO: dict[str, str] = {
    "16:9": "3840x2160",
    "9:16": "2160x3840",
    "1:1": "3840x3840",
    "4:3": "3840x2880",
    "3:4": "2880x3840",
}

_JIMENG_IMAGE_SIZE_1080_BY_RATIO: dict[str, str] = {
    "16:9": "1920x1080",
    "9:16": "1080x1920",
    "1:1": "1080x1080",
    "4:3": "1920x1440",
    "3:4": "1440x1920",
}

_WAN_IMAGE_SIZE_BY_RATIO: dict[str, str] = {
    "16:9": "1280*720",
    "9:16": "720*1280",
    "1:1": "1024*1024",
    "4:3": "1024*768",
    "3:4": "768*1024",
}

_WXH_RE = re.compile(r"^(\d+)\s*[x*×]\s*(\d+)$", re.IGNORECASE)


def normalize_aspect_ratio_key(aspect_ratio: str) -> str:
    raw = str(aspect_ratio or "16:9").strip().replace(" ", "").replace("/", ":")
    return raw or "16:9"


def _parse_wxh(size: str) -> tuple[int, int] | None:
    s = str(size or "").strip()
    if not s:
        return None
    upper = s.upper()
    if upper == "2K":
        return 2048, 2048
    if upper == "4K":
        return 4096, 4096
    m = _WXH_RE.match(s)
    if not m:
        return None
    return int(m.group(1)), int(m.group(2))


def _scale_wxh_to_min_pixels(width: int, height: int) -> str:
    w, h = max(MIN_JIMENG_SIDE, width), max(MIN_JIMENG_SIDE, height)
    if w * h >= MIN_JIMENG_PIXELS:
        return f"{w}x{h}"
    factor = math.sqrt(MIN_JIMENG_PIXELS / (w * h)) * 1.01
    w = max(MIN_JIMENG_SIDE, round(w * factor))
    h = max(MIN_JIMENG_SIDE, round(h * factor))
    while w * h < MIN_JIMENG_PIXELS:
        w += 2
        h = max(MIN_JIMENG_SIDE, round(h * MIN_JIMENG_PIXELS / max(w * h, 1)))
    return f"{w}x{h}"


def wan_image_size(aspect_ratio: str, *, default: str = "1024*1024") -> str:
    return _WAN_IMAGE_SIZE_BY_RATIO.get(normalize_aspect_ratio_key(aspect_ratio), default)


def jimeng_image_size(aspect_ratio: str, *, default: str = "2560x1440") -> str:
    key = normalize_aspect_ratio_key(aspect_ratio)
    mapped = _JIMENG_IMAGE_SIZE_BY_RATIO.get(key)
    if mapped:
        return mapped
    parsed = _parse_wxh(key)
    if parsed:
        return _scale_wxh_to_min_pixels(*parsed)
    return default


def jimeng_image_size_for_quality(aspect_ratio: str, quality: str = "standard") -> str:
    """Map output quality tier to Seedream WxH (meets minimum pixel count)."""
    key = normalize_aspect_ratio_key(aspect_ratio)
    q = str(quality or "standard").strip().lower()
    if q in {"4k", "uhd", "2160p", "ultra"}:
        mapped = _JIMENG_IMAGE_SIZE_4K_BY_RATIO.get(key)
    elif q in {"1080p", "fhd", "hd"}:
        mapped = _JIMENG_IMAGE_SIZE_1080_BY_RATIO.get(key)
    else:
        mapped = _JIMENG_IMAGE_SIZE_BY_RATIO.get(key)
    if mapped:
        return _scale_wxh_to_min_pixels(*_parse_wxh(mapped) or (2560, 1440))
    return jimeng_image_size(aspect_ratio)


def jimeng_video_resolution_for_quality(quality: str = "standard") -> str:
    q = str(quality or "standard").strip().lower()
    if q in {"4k", "uhd", "2160p", "ultra"}:
        return "4k"
    if q in {"1080p", "fhd", "hd"}:
        return "1080p"
    if q in {"720p"}:
        return "720p"
    return "1080p"


def ensure_jimeng_image_size(size: str | None, *, aspect_ratio: str = "16:9") -> str:
    """Return WxH that satisfies Seedream 5.0 Lite minimum pixel count."""
    candidate = str(size or "").strip() or jimeng_image_size(aspect_ratio)
    parsed = _parse_wxh(candidate)
    if parsed is None:
        return jimeng_image_size(aspect_ratio)
    return _scale_wxh_to_min_pixels(*parsed)
