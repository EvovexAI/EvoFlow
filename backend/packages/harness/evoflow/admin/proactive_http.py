"""Resolve Gateway proactive HTTP base for CLI / LangGraph tool callers.

Packaged desktop uses a dynamic Gateway port (e.g. 8382) with split LangGraph
on another port. Callers inside the LangGraph process must hit Gateway via
``EVOFLOW_GATEWAY_URL``, not the legacy ``127.0.0.1:8070`` default.
"""

from __future__ import annotations

import os

from evoflow.gateway_http import resolve_gateway_base_url


def resolve_proactive_api_base() -> str:
    """Return ``…/api/proactive`` for employees.dispatch / approvals HTTP.

    Priority:
    1. ``EVOFLOW_PROACTIVE_URL`` (explicit)
    2. Shared ``resolve_gateway_base_url()`` + ``/api/proactive``
    """
    env = (os.getenv("EVOFLOW_PROACTIVE_URL") or "").strip()
    if env:
        text = env.rstrip("/")
        if text.endswith("/api/proactive"):
            return text
        if text.endswith("/api/langgraph"):
            return text[: -len("/api/langgraph")] + "/api/proactive"
        if text.endswith("/api"):
            return f"{text}/proactive"
        return f"{text}/api/proactive"

    gw = resolve_gateway_base_url(allow_legacy_default=True) or "http://127.0.0.1:8070"
    return f"{gw.rstrip('/')}/api/proactive"
