"""Browser live-view metadata for EvoPanel.

ZCode parity: there is no separate screencast and no persistent Chromium —
the user looks at the panel's embedded WebView2 directly, and the agent
drives that same page through :mod:`evoflow.tools.builtins.browser_engine`.
This module only composes the lightweight metadata payload that accompanies
``browser(action='open')`` results so the panel can bind the right thread and
describe the current live-view mode.
"""

from __future__ import annotations

import logging
import os

from evoflow.tools.builtins.browser_screenshot_store import _safe_thread_segment

logger = logging.getLogger(__name__)

_DEFAULT_SESSION = "evoflow"


def browser_session_name(thread_id: str) -> str:
    tid = _safe_thread_segment(str(thread_id or "").strip() or "default")
    if not tid or tid in {"default", "__default__"}:
        return _DEFAULT_SESSION
    return f"{_DEFAULT_SESSION}-{tid}"[:64]


def browser_live_ws_path(thread_id: str) -> str:
    tid = _safe_thread_segment(thread_id)
    return f"/api/threads/{tid}/browser-stream"


def _engine_screencast_active(thread_id: str) -> bool:
    """True when the engine has agent state (refs) for this thread.

    Kept for the metadata mode report: the engine no longer owns a screencast
    server, so this only signals that the agent has bound the panel's page.
    """
    try:
        from evoflow.tools.builtins.browser_engine import browser_engine_enabled, get_browser_engine

        if not browser_engine_enabled():
            return False
        return get_browser_engine().has_session(thread_id)
    except Exception:
        return False


def browser_headed_enabled() -> bool:
    """Legacy desktop-default flag: True when no external CDP is configured.

    Only meaningful for describing historical modes in metadata; the engine
    itself always renders inside EvoPanel.
    """
    raw = str(os.getenv("EVOFLOW_BROWSER_HEADED", "")).strip().lower()
    if raw in ("1", "true", "yes"):
        return True
    if raw in ("0", "false", "no"):
        return False
    # 默认无头：浏览器"住"在 EvoPanel 侧栏里（画布 + 点击/滚轮穿透），
    # 不再向桌面弹出独立 Chrome 窗口。想要外窗（人机共用模式）显式设
    # EVOFLOW_BROWSER_HEADED=1。
    return False


def browser_cdp_url() -> str:
    return str(os.getenv("EVOFLOW_BROWSER_CDP_URL", "")).strip()


def build_browser_live_metadata(
    thread_id: str,
    *,
    page_url: str = "",
    preview_image_url: str = "",
) -> dict[str, str]:
    """Lightweight metadata only — the panel resolves the live view itself."""
    from evoflow.tools.builtins.browser_embed_cdp import get_thread_cdp_url

    page = str(page_url or "").strip()
    cdp = browser_cdp_url()
    embed_cdp = get_thread_cdp_url(thread_id)
    engine_active = _engine_screencast_active(thread_id)
    headed = browser_headed_enabled()
    logger.info(
        "browser_live_meta thread=%s page=%s engine_active=%s embed_cdp=%s cdp=%s headed=%s",
        thread_id,
        page[:80],
        engine_active,
        bool(embed_cdp),
        bool(cdp),
        headed,
    )
    if embed_cdp:
        mode = "embed"
        summary = "Browser embedded in EvoPanel. You and the agent share this WebView."
    elif engine_active:
        mode = "evopanel"
        if cdp:
            summary = "Connected to your Chrome via CDP. The right-side EvoPanel view mirrors it."
        else:
            summary = "Browser runs inside EvoPanel. Watch the right-side panel for the live view."
    elif cdp:
        mode = "cdp"
        summary = "Connected to your Chrome. Use that browser window — you and the agent share it."
    elif headed:
        mode = "headed"
        summary = "Chrome opened on your desktop. Use that window directly — you and the agent share it."
    else:
        mode = "headless"
        summary = "Browser opened. Live preview connects when the side panel opens."
    if page and mode != "headless":
        summary = f"{summary} ({page})"
    elif page:
        summary = f"Browser opened: {page}. Live preview connects when the side panel opens."
    meta: dict[str, str] = {
        "type": "browser_live",
        "thread_id": thread_id,
        "stream_ws": browser_live_ws_path(thread_id),
        "page_url": page,
        "summary": summary,
        "session": browser_session_name(thread_id),
        "mode": mode,
        "headed": "true" if embed_cdp or (headed and not engine_active) or bool(cdp) else "false",
        "embed": "true" if embed_cdp else "false",
    }
    preview = str(preview_image_url or "").strip()
    if preview:
        meta["preview_image_url"] = preview
    logger.info(
        "browser_live_meta RESULT thread=%s mode=%s summary=%s",
        thread_id,
        meta["mode"],
        meta["summary"],
    )
    return meta
