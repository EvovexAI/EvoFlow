"""Resolve Gateway proactive HTTP base for CLI / LangGraph tool callers.

Packaged desktop uses a dynamic Gateway port (e.g. 8382) with split LangGraph
on another port. Callers inside the LangGraph process must hit Gateway via
``EVOFLOW_GATEWAY_URL``, not the legacy ``127.0.0.1:8070`` default.
"""

from __future__ import annotations

import os

_DEFAULT_PROACTIVE = "http://127.0.0.1:8070/api/proactive"


def resolve_proactive_api_base() -> str:
    """Return ``…/api/proactive`` for employees.dispatch / approvals HTTP.

    Priority:
    1. ``EVOFLOW_PROACTIVE_URL`` (explicit)
    2. ``EVOFLOW_GATEWAY_URL`` + ``/api/proactive`` (packaged / split process)
    3. ``EVOFLOW_GATEWAY_PORT`` (+ optional host)
    4. Derive from ``EVOFLOW_LANGGRAPH_URL`` when it ends with ``/api/langgraph``
       (in-process mount on the same Gateway host)
    5. Legacy ``http://127.0.0.1:8070/api/proactive``
    """
    env = (os.getenv("EVOFLOW_PROACTIVE_URL") or "").strip()
    if env:
        return env.rstrip("/")

    gw = (os.getenv("EVOFLOW_GATEWAY_URL") or "").strip().rstrip("/")
    if gw:
        if gw.endswith("/api/proactive"):
            return gw
        if gw.endswith("/api/langgraph"):
            return gw[: -len("/api/langgraph")] + "/api/proactive"
        return f"{gw}/api/proactive"

    port_raw = (os.getenv("EVOFLOW_GATEWAY_PORT") or "").strip()
    if port_raw.isdigit():
        host = (os.getenv("EVOFLOW_GATEWAY_HOST") or "127.0.0.1").strip() or "127.0.0.1"
        return f"http://{host}:{port_raw}/api/proactive"

    lg = (os.getenv("EVOFLOW_LANGGRAPH_URL") or "").strip().rstrip("/")
    if lg.endswith("/api/langgraph"):
        return lg[: -len("/api/langgraph")] + "/api/proactive"
    if lg.endswith("/api/proactive"):
        return lg
    # Bare LG URL (e.g. http://127.0.0.1:8384) is the Agent Runtime host —
    # proactive APIs live on Gateway, not on LangGraph. Do not append
    # /api/proactive there.

    return _DEFAULT_PROACTIVE
