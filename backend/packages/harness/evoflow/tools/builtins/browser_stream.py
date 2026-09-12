"""Resolve agent-browser viewport stream for EvoPanel live browser panel."""

from __future__ import annotations

import json
import logging
import re
import sys
import threading
import time
from typing import Any

from evoflow.tools.builtins.browser_screenshot_store import _safe_thread_segment

logger = logging.getLogger(__name__)

_DEFAULT_SESSION = "evoflow"
_STREAM_PORT_CACHE_TTL_SEC = float(
    __import__("os").getenv("EVOFLOW_BROWSER_STREAM_PORT_CACHE_TTL", "45")
)

_port_cache: dict[str, tuple[int, float]] = {}
_port_cache_lock = threading.Lock()


def browser_session_name(thread_id: str) -> str:
    tid = _safe_thread_segment(str(thread_id or "").strip() or "default")
    if not tid or tid in {"default", "__default__"}:
        return _DEFAULT_SESSION
    return f"{_DEFAULT_SESSION}-{tid}"[:64]


def browser_live_ws_path(thread_id: str) -> str:
    tid = _safe_thread_segment(thread_id)
    return f"/api/threads/{tid}/browser-stream"


def _parse_stream_status(stdout: str, stderr: str = "") -> dict[str, Any]:
    text = "\n".join(part for part in (stdout, stderr) if part).strip()
    if not text:
        return {}
    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict):
            if isinstance(parsed.get("data"), dict):
                return {**parsed, **parsed["data"]}
            return parsed
    except json.JSONDecodeError:
        pass

    out: dict[str, Any] = {}
    port_match = re.search(r"(?:port|listening(?:\s+on)?)\s*[:=]?\s*(\d{2,5})", text, re.I)
    if not port_match:
        port_match = re.search(r"ws://(?:127\.0\.0\.1|localhost):(\d{2,5})", text, re.I)
    if port_match:
        out["port"] = int(port_match.group(1))
    lowered = text.lower()
    if "enabled" in lowered or "listening" in lowered or out.get("port"):
        out["enabled"] = True
    if "disabled" in lowered:
        out["enabled"] = False
    return out


def _extract_stream_port(payload: dict[str, Any]) -> int | None:
    if not isinstance(payload, dict):
        return None

    stack: list[Any] = [payload]
    while stack:
        node = stack.pop()
        if not isinstance(node, dict):
            continue
        for key in ("port", "stream_port", "ws_port", "streamPort", "wsPort"):
            raw = node.get(key)
            if raw is None:
                continue
            try:
                port = int(raw)
            except (TypeError, ValueError):
                continue
            if 1 < port < 65536:
                return port
        for key in ("ws_url", "url", "stream", "stream_url", "data"):
            child = node.get(key)
            if isinstance(child, dict):
                stack.append(child)
            elif isinstance(child, str) and child.strip():
                match = re.search(r":(\d{2,5})(?:/|$)", child)
                if match:
                    return int(match.group(1))
    return None


def _run_stream_cli(session: str, subcommand: list[str]) -> tuple[int, str, str]:
    from evoflow.tools.builtins.browser_tool import _run_agent_browser

    return _run_agent_browser(["--session", session, *subcommand], timeout=8)


def _resolve_port_for_session(session: str) -> int | None:
    for args in (["--json", "stream", "status"], ["stream", "status"]):
        code, out, err = _run_stream_cli(session, args)
        payload = _parse_stream_status(out, err)
        port = _extract_stream_port(payload)
        if port:
            return port
        if code != 0:
            logger.debug("browser stream probe session=%s code=%s err=%s", session, code, err or out)
    return None


def _cache_get(thread_id: str) -> int | None:
    key = _safe_thread_segment(thread_id)
    now = time.time()
    with _port_cache_lock:
        hit = _port_cache.get(key)
        if hit and now - hit[1] < _STREAM_PORT_CACHE_TTL_SEC:
            return hit[0]
    return None


def _cache_put(thread_id: str, port: int) -> None:
    key = _safe_thread_segment(thread_id)
    with _port_cache_lock:
        _port_cache[key] = (port, time.time())


def invalidate_browser_stream_cache(thread_id: str) -> None:
    key = _safe_thread_segment(thread_id)
    with _port_cache_lock:
        _port_cache.pop(key, None)


def restart_browser_stream(thread_id: str) -> int | None:
    """Restart screencast after viewport changes so live frames use the full layout size."""
    invalidate_browser_stream_cache(thread_id)
    session = browser_session_name(thread_id)
    _run_stream_cli(session, ["stream", "disable"])
    code, out, err = _run_stream_cli(session, ["stream", "enable"])
    if code != 0:
        logger.debug("browser stream restart failed session=%s: %s", session, err or out)
    payload = _parse_stream_status(out, err)
    port = _extract_stream_port(payload) or resolve_browser_stream_port(thread_id)
    if port:
        _cache_put(thread_id, port)
        logger.info("browser stream restarted session=%s port=%s", session, port)
    return port


def resolve_browser_stream_port(thread_id: str) -> int | None:
    cached = _cache_get(thread_id)
    if cached:
        return cached

    from evoflow.tools.builtins.browser_live_frame import resolve_browser_thread_candidates

    sessions: list[str] = []
    for tid in resolve_browser_thread_candidates(thread_id):
        name = browser_session_name(tid)
        if name not in sessions:
            sessions.append(name)

    for session in sessions:
        port = _resolve_port_for_session(session)
        if port:
            _cache_put(thread_id, port)
            logger.info("browser stream resolved session=%s port=%s", session, port)
            return port
    return None


def ensure_browser_stream_port(thread_id: str) -> int | None:
    port = resolve_browser_stream_port(thread_id)
    if port:
        return port

    session = browser_session_name(thread_id)
    code, out, err = _run_stream_cli(session, ["stream", "enable"])
    if code != 0:
        logger.debug("browser stream enable failed session=%s: %s", session, err or out)
    enabled_payload = _parse_stream_status(out, err)
    port = _extract_stream_port(enabled_payload) or resolve_browser_stream_port(thread_id)
    if port:
        _cache_put(thread_id, port)
    return port


def browser_headed_enabled() -> bool:
    """Desktop default: visible Chrome window shared between agent and user."""
    raw = str(__import__("os").getenv("EVOFLOW_BROWSER_HEADED", "")).strip().lower()
    if raw in ("1", "true", "yes"):
        return True
    if raw in ("0", "false", "no"):
        return False
    return sys.platform in ("win32", "darwin")


def browser_cdp_url() -> str:
    return str(__import__("os").getenv("EVOFLOW_BROWSER_CDP_URL", "")).strip()


def build_browser_live_metadata(
    thread_id: str,
    *,
    page_url: str = "",
    preview_image_url: str = "",
) -> dict[str, str]:
    """Lightweight metadata only — no subprocess probes (port resolved lazily on WS connect)."""
    from evoflow.tools.builtins.browser_embed_cdp import get_thread_cdp_url

    page = str(page_url or "").strip()
    cdp = browser_cdp_url()
    embed_cdp = get_thread_cdp_url(thread_id)
    headed = browser_headed_enabled()
    if embed_cdp:
        mode = "embed"
        summary = "Browser embedded in EvoPanel. You and the agent share this WebView."
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
        "stream_ws": browser_live_ws_path(thread_id),
        "page_url": page,
        "summary": summary,
        "session": browser_session_name(thread_id),
        "mode": mode,
        "headed": "true" if embed_cdp or headed or bool(cdp) else "false",
        "embed": "true" if embed_cdp else "false",
    }
    preview = str(preview_image_url or "").strip()
    if preview:
        meta["preview_image_url"] = preview
    return meta
