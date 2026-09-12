"""Thread-scoped right stage state + news feeds for prompt injection."""

from __future__ import annotations

import time
from typing import Any

from .news_feeds import PLATFORM_LABELS, fetch_news_feeds as _fetch_news_feeds

_thread_stage: dict[str, dict[str, Any]] = {}


def set_thread_stage(thread_id: str, *, kind: str | None, data: dict[str, Any] | None = None) -> None:
    tid = str(thread_id or "").strip()
    if not tid:
        return
    k = str(kind or "").strip()
    if not k:
        _thread_stage.pop(tid, None)
        return
    _thread_stage[tid] = {"kind": k, "data": dict(data or {}), "updated_at": time.time()}


def clear_thread_stage(thread_id: str) -> None:
    tid = str(thread_id or "").strip()
    if tid:
        _thread_stage.pop(tid, None)


def fetch_news_feeds(*, force_refresh: bool = False) -> dict[str, Any]:
    return _fetch_news_feeds(force_refresh=force_refresh)


def _format_news_context(feeds: dict[str, Any]) -> str:
    lines = [
        "## 资讯上下文",
        "用户打开了右侧资讯面板。以下热榜仅供背景参考，非用户消息。",
    ]
    fetched = feeds.get("fetchedAt")
    if fetched:
        stale = "（缓存）" if feeds.get("stale") else ""
        lines.append(f"抓取时间：{fetched}{stale}")
    for platform, items in (feeds.get("platforms") or {}).items():
        label = PLATFORM_LABELS.get(platform, platform)
        top = "；".join(
            f"{i + 1}. {it.get('text') or it.get('title', '')}"
            for i, it in enumerate((items or [])[:3])
            if isinstance(it, dict) and (it.get("text") or it.get("title"))
        )
        if top:
            lines.append(f"{label} Top3：{top}")
    return "\n".join(lines)


def build_stage_context_appendix(thread_id: str | None) -> str:
    tid = str(thread_id or "").strip()
    if not tid:
        return ""
    state = _thread_stage.get(tid)
    if not state:
        return ""
    kind = str(state.get("kind") or "").strip()
    if kind == "news-dashboard":
        return _format_news_context(fetch_news_feeds())
    if kind == "web-embed":
        page_url = str((state.get("data") or {}).get("url") or "").strip()
        if not page_url:
            return ""
        return (
            "## 网页上下文\n"
            "用户打开了右侧内嵌网页面板。以下 URL 仅供背景参考，非用户消息。\n"
            f"当前页面：{page_url}"
        )
    return ""
