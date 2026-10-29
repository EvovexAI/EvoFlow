"""Vendor-agnostic media URL / local-path extraction.

Each provider returns success media under different shapes
(``data[].url``, ``output.video_url``, ``content.url``, ``file.download_url``, …).
Callers should still prefer provider-specific fields when known; this module is the
shared fallback so new vendors and gateway quirks still surface a preview path.

Also used by platform preview enrichment and ``evoflow_media_assets`` lookup.
"""

from __future__ import annotations

import re
from typing import Any

# Prefer these keys when walking objects (order matters for primary pick).
_URL_KEYS = (
    "download_url",
    "video_url",
    "image_url",
    "output_video_url",
    "content_url",
    "file_url",
    "result_url",
    "remote_url",
    "url",
    "src",
    "absolute_path",
    "local_path",
    "path",
)

# Containers that often hold media lists / nested payloads.
_NEST_KEYS = (
    "data",
    "output",
    "content",
    "result",
    "task_result",
    "task",
    "file",
    "files",
    "results",
    "videos",
    "images",
    "choices",
    "message",
    "preview",
    "media",
    "urls",
    "local_paths",
)

_HTTP_MEDIA_RE = re.compile(
    r"https?://[^\s\"'<>\\]+?\.(?:png|jpe?g|gif|webp|bmp|mp4|webm|mov|mkv|m4v)"
    r"(?:\?[^\s\"'<>\\]*)?",
    re.IGNORECASE,
)
_HTTP_ANY_RE = re.compile(r"https?://[^\s\"'<>\\]+", re.IGNORECASE)
# Windows drive / UNC / Unix abs — never match inside ``https://`` (``s:`` or ``//``).
_LOCAL_MEDIA_RE = re.compile(
    r"(?:"
    r"(?<![A-Za-z0-9])[A-Za-z]:[\\/]"  # C:\ or C:/
    r"|(?<![A-Za-z0-9:/])/(?!/)"  # /path but not //cdn
    r"|\\\\"  # UNC
    r")"
    r"[^\s\"'<>]+?\.(?:png|jpe?g|gif|webp|bmp|mp4|webm|mov|mkv|m4v)\b",
    re.IGNORECASE,
)
_DATA_URI_RE = re.compile(r"data:(?:image|video)/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+", re.IGNORECASE)

_MAX_WALK_NODES = 400
_MAX_URLS = 16


def is_httpish_media_ref(value: str) -> bool:
    low = value.strip().lower()
    return low.startswith(("http://", "https://", "data:", "file:"))


def is_local_media_path(value: str) -> bool:
    """True for filesystem / workspace paths — not URL fragments like ``s://…`` / ``//cdn``."""
    s = value.strip()
    if not s or is_httpish_media_ref(s):
        return False
    low = s.lower().replace("\\", "/")
    # Protocol-relative or mangled https leftovers
    if low.startswith("//") or low.startswith("s://"):
        return False
    exts = (".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".mp4", ".webm", ".mov", ".mkv", ".m4v")
    if re.match(r"^[a-z]:/", low):
        return any(low.endswith(ext) for ext in exts)
    if low.startswith("/"):
        return any(low.endswith(ext) for ext in exts)
    if "outputs/" in low and any(low.endswith(ext) for ext in (".png", ".jpg", ".jpeg", ".webp", ".mp4", ".webm", ".mov")):
        return True
    return False


def _looks_like_media_ref(value: str) -> bool:
    s = value.strip()
    if not s or len(s) < 4:
        return False
    if is_httpish_media_ref(s):
        # CDN links often omit extension (signed OSS / Ark); accept http(s).
        return True
    return is_local_media_path(s)


def _push(out: list[str], seen: set[str], value: str) -> None:
    s = value.strip()
    if not s or s in seen or not _looks_like_media_ref(s):
        return
    # Skip obvious non-media API endpoints mistaken for urls
    low = s.lower()
    if low.startswith("http") and any(
        frag in low
        for frag in (
            "/video_generation",
            "/images/generations",
            "/v1/videos/",
            "/query/",
            "/tasks?",
        )
    ):
        # Still allow if it clearly has a media extension or query content blob
        if not re.search(r"\.(png|jpe?g|gif|webp|mp4|webm|mov|mkv|m4v)(\?|$)", low):
            if "/content" not in low and "download" not in low:
                return
    seen.add(s)
    out.append(s)


def _walk(node: Any, out: list[str], seen: set[str], *, depth: int, budget: list[int]) -> None:
    if budget[0] <= 0 or len(out) >= _MAX_URLS or depth > 10:
        return
    budget[0] -= 1

    if isinstance(node, str):
        if _looks_like_media_ref(node):
            _push(out, seen, node)
        return

    if isinstance(node, list):
        for item in node:
            _walk(item, out, seen, depth=depth + 1, budget=budget)
            if len(out) >= _MAX_URLS:
                return
        return

    if not isinstance(node, dict):
        return

    # Key-priority pass first (stable primary URL)
    for key in _URL_KEYS:
        if key not in node:
            continue
        val = node[key]
        if isinstance(val, str):
            _push(out, seen, val)
        elif isinstance(val, list):
            for item in val:
                if isinstance(item, str):
                    _push(out, seen, item)
                elif isinstance(item, dict):
                    for k in _URL_KEYS:
                        if isinstance(item.get(k), str):
                            _push(out, seen, str(item[k]))

    for key in _NEST_KEYS:
        if key not in node:
            continue
        _walk(node[key], out, seen, depth=depth + 1, budget=budget)
        if len(out) >= _MAX_URLS:
            return

    # Remaining values (shallow) — catch vendor-specific aliases
    for key, val in node.items():
        if key in _URL_KEYS or key in _NEST_KEYS:
            continue
        if isinstance(val, (dict, list)):
            _walk(val, out, seen, depth=depth + 1, budget=budget)
        elif isinstance(val, str) and ("url" in key.lower() or "path" in key.lower()):
            _push(out, seen, val)
        if len(out) >= _MAX_URLS:
            return


def extract_media_urls_from_text(text: str) -> list[str]:
    """Regex fallback for free-form / mangled vendor payloads."""
    if not text or not isinstance(text, str):
        return []
    out: list[str] = []
    seen: set[str] = set()
    for pattern in (_DATA_URI_RE, _HTTP_MEDIA_RE, _LOCAL_MEDIA_RE):
        for m in pattern.finditer(text):
            _push(out, seen, m.group(0).rstrip(".,);]}"))
            if len(out) >= _MAX_URLS:
                return out
    # Signed CDN without extension: only when no media-ext hits yet
    if not out:
        for m in _HTTP_ANY_RE.finditer(text):
            cand = m.group(0).rstrip(".,);]}")
            low = cand.lower()
            if any(
                h in low
                for h in (
                    "tos-",
                    "volces.com",
                    "byteimg",
                    "cdn.",
                    "oss-",
                    "aliyuncs",
                    "minimax",
                    "dashscope",
                    "openai",
                    "filesystem.site",
                    "ark.cn-",
                )
            ):
                _push(out, seen, cand)
            if len(out) >= _MAX_URLS:
                break
    return out


def extract_media_urls(payload: Any, *, also_scan_text: bool = True) -> list[str]:
    """Collect media http(s)/data/local refs from arbitrary vendor JSON.

    Returns de-duplicated list, first item is the best primary guess.
    """
    out: list[str] = []
    seen: set[str] = set()
    budget = [_MAX_WALK_NODES]
    _walk(payload, out, seen, depth=0, budget=budget)

    if also_scan_text and len(out) < _MAX_URLS:
        try:
            import json

            text = payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False)
        except Exception:
            text = str(payload)
        for u in extract_media_urls_from_text(text):
            _push(out, seen, u)
            if len(out) >= _MAX_URLS:
                break
    return out


def primary_media_url(payload: Any) -> str | None:
    urls = extract_media_urls(payload)
    return urls[0] if urls else None


def guess_media_kind(url_or_path: str, *, default: str = "image") -> str:
    low = (url_or_path or "").lower().split("?", 1)[0]
    if low.endswith((".mp4", ".webm", ".mov", ".mkv", ".m4v")) or low.startswith("data:video/"):
        return "video"
    if low.endswith((".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp")) or low.startswith("data:image/"):
        return "image"
    return default
