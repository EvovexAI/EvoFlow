from __future__ import annotations

import logging
import re
import time
import urllib.request
from collections.abc import Callable
from pathlib import Path
from urllib.parse import urlparse

logger = logging.getLogger(__name__)

_POLL_INTERVAL = 5.0
_TERMINAL = frozenset({"succeeded", "success", "completed", "done", "failed", "error", "cancelled"})


def _is_safe_url(url: str) -> bool:
    try:
        parsed = urlparse(url)
        if parsed.scheme not in ("http", "https"):
            return False
        host = (parsed.hostname or "").lower()
        if host in ("localhost", "127.0.0.1", "0.0.0.0", "::1"):
            return False
        if re.match(r"^10\.", host) or re.match(r"^192\.168\.", host) or re.match(r"^172\.(1[6-9]|2\d|3[01])\.", host):
            return False
        return True
    except Exception:
        return False


def download_url_to_file(url: str, dest: Path, timeout: int = 120) -> None:
    if not _is_safe_url(url):
        raise ValueError(f"URL blocked for security: {url}")
    dest.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": "EvoFlow-Media/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = resp.read()
    dest.write_bytes(data)


def poll_until_done(
    poll_fn: Callable[[], tuple[str, str | None, list[str]]],
    *,
    max_wait_seconds: int = 600,
    interval: float = _POLL_INTERVAL,
) -> tuple[str, str | None, list[str]]:
    """Poll ``poll_fn`` until terminal status. Returns (status, primary_url, all_urls)."""
    deadline = time.monotonic() + max_wait_seconds
    last_status = "processing"
    while time.monotonic() < deadline:
        status, url, urls = poll_fn()
        last_status = status
        st = status.lower()
        if st in _TERMINAL:
            return status, url, urls
        if st in ("succeeded", "success", "completed", "done") or url:
            if url:
                return status, url, urls
        time.sleep(interval)
    return last_status, None, []


def guess_extension(url: str, media_kind: str) -> str:
    path = urlparse(url).path.lower()
    for ext in (".mp4", ".webm", ".mov", ".png", ".jpg", ".jpeg", ".webp", ".mp3", ".wav"):
        if path.endswith(ext):
            return ext.lstrip(".")
    if media_kind == "video":
        return "mp4"
    if media_kind == "audio":
        return "mp3"
    return "png"


def save_media_from_urls(
    urls: list[str],
    outputs_dir: Path,
    *,
    prefix: str,
    media_kind: str,
) -> list[str]:
    saved: list[str] = []
    for i, url in enumerate(urls):
        if not url:
            continue
        ext = guess_extension(url, media_kind)
        name = f"{prefix}_{i}.{ext}" if i else f"{prefix}.{ext}"
        dest = outputs_dir / name
        try:
            download_url_to_file(url, dest)
            saved.append(str(dest.resolve()))
        except Exception as e:
            logger.warning("Failed to download %s: %s", url, e)
    return saved
