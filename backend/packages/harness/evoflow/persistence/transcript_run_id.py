"""Resolve and backfill ``run_id`` on ``evoflow_chat_messages`` rows (user / assistant / tool)."""

from __future__ import annotations

from typing import Any


def run_id_from_langgraph_config() -> str | None:
    try:
        from langgraph.config import get_config

        cfg = get_config()
        conf = cfg.get("configurable") if isinstance(cfg, dict) else {}
        if isinstance(conf, dict):
            r = conf.get("run_id") or conf.get("runId")
            if isinstance(r, str) and r.strip():
                return r.strip()
    except Exception:
        pass
    return None


def resolve_run_id_for_transcript(
    session_key: str,
    *,
    role: str,
    run_id: str | None = None,
    thread_id: str | None = None,
    raw: dict[str, Any] | None = None,
) -> str | None:
    """Bind a row to the active LangGraph run or the user turn that started it."""
    from evoflow.persistence.chat_message_repositories import latest_user_run_id
    from evoflow.persistence.session_run_state import peek_current_run_id

    rid = str(run_id or "").strip()
    if not rid and isinstance(raw, dict):
        rid = str(raw.get("run_id") or raw.get("runId") or "").strip()
    if not rid:
        rid = run_id_from_langgraph_config() or ""
    r = str(role or "").strip().lower()
    if not rid and r in ("user", "assistant", "tool"):
        rid = str(peek_current_run_id(session_key=session_key, thread_id=thread_id) or "").strip()
    if not rid and r in ("assistant", "tool"):
        rid = str(latest_user_run_id(session_key, thread_id=thread_id) or "").strip()
    return rid or None


def enrich_run_ids_in_order(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Turn-based forward-fill: assistant/tool rows inherit the preceding user's run_id."""
    if not rows:
        return rows
    current: str | None = None
    out: list[dict[str, Any]] = []
    for row in rows:
        item = dict(row)
        rid = str(item.get("run_id") or item.get("runId") or "").strip() or None
        role = str(item.get("role") or "").strip().lower()
        if role == "user":
            if rid:
                current = rid
            elif current:
                item["run_id"] = current
        elif rid:
            current = rid
            item["run_id"] = rid
        elif current:
            item["run_id"] = current
        out.append(item)
    return out
