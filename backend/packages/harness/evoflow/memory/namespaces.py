"""Memory namespace id helpers."""

from __future__ import annotations


def user_ns(user_id: str = "default") -> str:
    return f"user:{(user_id or 'default').strip() or 'default'}"


def agent_ns(agent_code: str | None) -> str:
    code = (agent_code or "").strip()
    if not code:
        return user_ns("default")
    return f"agent:{code}"


def workspace_ns(workspace_key: str) -> str:
    key = (workspace_key or "").strip()
    if not key:
        raise ValueError("workspace_key required")
    # Accept raw path hash keys like ws-xxx or full workspace id.
    if key.startswith("workspace:"):
        return key
    return f"workspace:{key}"


def person_ns(agent_code: str) -> str:
    code = (agent_code or "").strip().lower()
    if not code:
        raise ValueError("agent_code required")
    return f"person:{code}"


def parse_namespace(ns_id: str) -> tuple[str, str]:
    raw = (ns_id or "").strip()
    if ":" not in raw:
        return "user", raw or "default"
    kind, _, owner = raw.partition(":")
    return kind.strip(), owner.strip()
