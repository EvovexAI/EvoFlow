"""Single source of truth for the Gateway HTTP base URL.

Packaged desktop binds a **per-profile** port (8100..8999), not the legacy
dev default ``:8070``. Split LangGraph / node-repl / proactive HTTP callers
must hit the same host:port the Tauri UI uses — otherwise the browser bridge
probes a dead 8070 and the embed never comes up.

Resolution order (first hit wins):
  1. ``EVOFLOW_GATEWAY_URL`` (Tauri / operator always sets this on children)
  2. ``EVOFLOW_GATEWAY_PORT`` (+ optional ``EVOFLOW_GATEWAY_HOST``)
  3. ``EVOFLOW_LANGGRAPH_URL`` when it ends with ``/api/langgraph`` (in-process)
  4. Profile ``backend-runtime.json`` ``baseUrl`` / ``port`` (packaged cold start)
  5. Legacy ``http://127.0.0.1:8070`` (isolated bat / plain uvicorn)
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from urllib.parse import urlparse

_LEGACY_DEFAULT = "http://127.0.0.1:8070"


def _normalize_base(raw: str) -> str:
    text = (raw or "").strip().rstrip("/")
    if not text:
        return ""
    # Strip known Gateway path suffixes so callers can append their own.
    for suffix in ("/api/langgraph", "/api/proactive", "/api"):
        if text.endswith(suffix):
            text = text[: -len(suffix)].rstrip("/")
            break
    if "://" not in text:
        text = f"http://{text}"
    return text.rstrip("/")


def _from_langgraph_url(lg: str) -> str | None:
    text = (lg or "").strip().rstrip("/")
    if not text:
        return None
    if text.endswith("/api/langgraph"):
        return _normalize_base(text[: -len("/api/langgraph")])
    # Bare LG URL (split process) is NOT the Gateway — refuse.
    return None


def _runtime_state_candidates() -> list[Path]:
    """Profile-scoped runtime files Tauri writes for the active Gateway."""
    out: list[Path] = []
    home = (os.getenv("EVOFLOW_HOME") or "").strip()
    if home:
        out.append(Path(home) / "backend-runtime.json")
    config = (os.getenv("EVOFLOW_CONFIG_DIR") or "").strip()
    profile = (os.getenv("EVOFLOW_PROFILE") or "").strip()
    if config and profile:
        out.append(Path(config) / "profiles" / profile / "backend-runtime.json")
    if config:
        out.append(Path(config) / "backend-runtime.json")
    return out


def _from_backend_runtime() -> str | None:
    for path in _runtime_state_candidates():
        try:
            if not path.is_file():
                continue
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError, TypeError, ValueError):
            continue
        if not isinstance(data, dict):
            continue
        base = _normalize_base(str(data.get("baseUrl") or ""))
        if base:
            return base
        port = data.get("port")
        try:
            p = int(port)
        except (TypeError, ValueError):
            continue
        if 1 < p < 65536:
            return f"http://127.0.0.1:{p}"
    return None


def resolve_gateway_base_url(*, allow_legacy_default: bool = True) -> str | None:
    """Return ``http://host:port`` for the Control Plane Gateway, or None/legacy.

    When ``allow_legacy_default`` is False, returns ``None`` if unresolved
    (useful for probes that must not invent :8070).
    """
    explicit = _normalize_base(os.getenv("EVOFLOW_GATEWAY_URL") or "")
    if explicit:
        return explicit

    port_raw = (os.getenv("EVOFLOW_GATEWAY_PORT") or os.getenv("PORT") or "").strip()
    if port_raw.isdigit():
        port = int(port_raw)
        if 1 < port < 65536:
            host = (os.getenv("EVOFLOW_GATEWAY_HOST") or "127.0.0.1").strip() or "127.0.0.1"
            if host in ("0.0.0.0", "::", "*"):
                host = "127.0.0.1"
            return f"http://{host}:{port}"

    from_lg = _from_langgraph_url(os.getenv("EVOFLOW_LANGGRAPH_URL") or "")
    if from_lg:
        return from_lg

    from_runtime = _from_backend_runtime()
    if from_runtime:
        return from_runtime

    if allow_legacy_default:
        return _LEGACY_DEFAULT
    return None


def gateway_port_from_base(base: str | None) -> int | None:
    """Extract TCP port from a Gateway base URL."""
    text = _normalize_base(base or "")
    if not text:
        return None
    try:
        parsed = urlparse(text if "://" in text else f"http://{text}")
    except Exception:
        return None
    if parsed.port:
        return int(parsed.port)
    if parsed.scheme == "https":
        return 443
    if parsed.scheme == "http":
        return 80
    return None
