"""Persist browser screenshots for UI display; return compact JSON to the model."""

from __future__ import annotations

import json
import logging
import re
import time
import uuid
from pathlib import Path

from evoflow.config.paths import get_paths

logger = logging.getLogger(__name__)

_MAX_AGE_HOURS = 72
_DIR_NAME = "browser_snapshots"


def _safe_thread_segment(thread_id: str) -> str:
    tid = str(thread_id or "").strip() or "default"
    safe = re.sub(r"[^\w\-.]+", "_", tid)[:120]
    return safe or "default"


def screenshots_dir(thread_id: str) -> Path:
    base = get_paths().base_dir / _DIR_NAME / _safe_thread_segment(thread_id)
    base.mkdir(parents=True, exist_ok=True)
    return base


def _prune_old_files(directory: Path) -> None:
    cutoff = time.time() - (_MAX_AGE_HOURS * 3600)
    try:
        for f in directory.glob("*.png"):
            if f.is_file() and f.stat().st_mtime < cutoff:
                f.unlink(missing_ok=True)
    except OSError:
        pass


def screenshot_api_path(thread_id: str, screenshot_id: str) -> str:
    tid = _safe_thread_segment(thread_id)
    sid = str(screenshot_id or "").strip()
    return f"/api/threads/{tid}/browser-snapshots/{sid}"


def resolve_screenshot_file(thread_id: str, screenshot_id: str) -> Path | None:
    sid = str(screenshot_id or "").strip()
    if not sid or not re.fullmatch(r"[0-9a-f]{12,32}", sid):
        return None
    path = screenshots_dir(thread_id) / f"{sid}.png"
    return path if path.is_file() else None


def save_screenshot_png(
    thread_id: str,
    png_bytes: bytes,
    *,
    page_url: str = "",
    full_page: bool = False,
    width: int | None = None,
    height: int | None = None,
) -> dict[str, str | int | bool]:
    directory = screenshots_dir(thread_id)
    _prune_old_files(directory)
    screenshot_id = uuid.uuid4().hex[:16]
    path = directory / f"{screenshot_id}.png"
    path.write_bytes(png_bytes)
    size_kb = max(1, len(png_bytes) // 1024)
    logger.info(
        "browser screenshot saved thread=%s id=%s bytes=%d path=%s",
        _safe_thread_segment(thread_id),
        screenshot_id,
        len(png_bytes),
        path,
    )
    return {
        "screenshot_id": screenshot_id,
        "image_url": screenshot_api_path(thread_id, screenshot_id),
        "page_url": str(page_url or ""),
        "full_page": bool(full_page),
        "width": int(width or 0),
        "height": int(height or 0),
        "size_kb": size_kb,
    }


_LEGACY_SCREENSHOT_TOOLS = frozenset({"browser_snapshot", "preview_url", "browser_get_images"})


def compact_legacy_screenshot_tool_content(content: str, tool_name: str = "") -> str:
    """Strip inline base64 data URIs from tool results (older runs / external tools)."""
    text = str(content or "")
    if not text.lstrip().startswith("data:image/"):
        return text
    if tool_name and tool_name not in _LEGACY_SCREENSHOT_TOOLS:
        # Still strip huge payloads for any tool returning accidental image data URIs.
        pass
    first_line = text.split("\n", 1)[0]
    if "base64," not in first_line:
        return text
    return "[Screenshot omitted from model context — image is shown in the user UI only. Use browser_snapshot(mode='text') or web_fetch for readable page content.]"


def format_screenshot_tool_result(thread_id: str, meta: dict[str, str | int | bool]) -> str:
    """JSON tool result for the model (no base64)."""
    w, h = int(meta.get("width") or 0), int(meta.get("height") or 0)
    dims = f"{w}x{h}px" if w and h else "unknown size"
    fp = "full page" if meta.get("full_page") else "viewport"
    summary = f"Screenshot captured ({dims}, ~{meta.get('size_kb', 0)}KB, {fp}). The image is shown to the user in the chat UI only and is not included in your context. Use browser_snapshot(mode='text') if you need readable page text."
    page_url = str(meta.get("page_url") or "").strip()
    if page_url:
        summary += f" Page URL: {page_url}"
    payload = {
        "type": "browser_screenshot",
        "summary": summary,
        "screenshot_id": meta["screenshot_id"],
        "image_url": meta["image_url"],
        "page_url": page_url,
        "full_page": bool(meta.get("full_page")),
    }
    return json.dumps(payload, ensure_ascii=False)
