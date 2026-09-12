"""LangGraph deployment mode: in-process (desktop default) vs external process."""

from __future__ import annotations

import os
from urllib.parse import urlparse

from evoflow.langgraph_run_config import resolve_langgraph_base_url

_TRUTHY = frozenset({"1", "true", "yes", "on"})
_FALSY = frozenset({"0", "false", "no", "off"})


def _parse_port(raw: str | None, *, default: int | None = None) -> int | None:
    text = str(raw or "").strip()
    if not text:
        return default
    try:
        port = int(text)
    except ValueError:
        return default
    if port <= 0 or port >= 65536:
        return default
    return port


def _gateway_self_base_url() -> str | None:
    """Best-effort Gateway HTTP base (host:port) for in-process LangGraph detection."""
    explicit = (os.getenv("EVOFLOW_GATEWAY_URL") or "").strip().rstrip("/")
    if explicit:
        return explicit
    port = _parse_port(os.getenv("EVOFLOW_GATEWAY_PORT"))
    if port is None:
        port = _parse_port(os.getenv("PORT"))
    if port is None:
        return None
    host = (os.getenv("EVOFLOW_GATEWAY_HOST") or "127.0.0.1").strip() or "127.0.0.1"
    return f"http://{host}:{port}"


def langgraph_url_points_to_gateway_self() -> bool:
    """True when ``EVOFLOW_LANGGRAPH_URL`` targets this Gateway's in-process mount."""
    lg_url = resolve_langgraph_base_url()
    gw_base = _gateway_self_base_url()
    if not gw_base:
        # Packaged desktop sets EVOFLOW_LANGGRAPH_URL=http://127.0.0.1:{port}/api/langgraph
        # without EVOFLOW_GATEWAY_PORT — treat same-host + /api/langgraph suffix as in-process.
        parsed = urlparse(lg_url)
        path = (parsed.path or "").rstrip("/")
        return path.endswith("/api/langgraph") or path == "/api/langgraph"

    lg = urlparse(lg_url)
    gw = urlparse(gw_base if "://" in gw_base else f"http://{gw_base}")
    lg_host = (lg.hostname or "").lower()
    gw_host = (gw.hostname or "").lower()
    if lg_host in {"localhost", "127.0.0.1", "::1"} and gw_host in {"localhost", "127.0.0.1", "::1"}:
        host_match = True
    else:
        host_match = lg_host == gw_host
    lg_port = lg.port or (443 if lg.scheme == "https" else 80)
    gw_port = gw.port or (443 if gw.scheme == "https" else 80)
    if not host_match or lg_port != gw_port:
        return False
    path = (lg.path or "").rstrip("/")
    return path.endswith("/api/langgraph") or path == "/api/langgraph"


def is_external_langgraph_mode() -> bool:
    """External LangGraph process — Gateway proxies HTTP instead of mounting in-process."""
    explicit = (os.getenv("EVOFLOW_LANGGRAPH_EXTERNAL") or "").strip().lower()
    if explicit in _TRUTHY:
        return True
    if explicit in _FALSY:
        return False
    return not langgraph_url_points_to_gateway_self()
