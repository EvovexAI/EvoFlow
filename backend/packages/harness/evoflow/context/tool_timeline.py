"""Unified tool-call timeline for agents (observability SQLite + JSONL fallback)."""

from __future__ import annotations

import logging
import re
from typing import Any

logger = logging.getLogger(__name__)

_PERSISTED_PATH_RE = re.compile(r"Full output:\s*(\S+)", re.IGNORECASE)


def _extract_persisted_path(output_text: str | None) -> str | None:
    if not output_text:
        return None
    m = _PERSISTED_PATH_RE.search(str(output_text))
    return m.group(1).strip() if m else None


def search_tool_timeline(
    thread_id: str,
    *,
    query: str | None = None,
    tool_name: str | None = None,
    status: str | None = None,
    limit: int = 20,
) -> dict[str, Any]:
    """Search recent tool invocations for a thread (newest first)."""
    tid = str(thread_id or "").strip()
    if not tid:
        return {"ok": False, "reason": "thread_id required", "items": []}

    items: list[dict[str, Any]] = []
    source = "none"
    try:
        from evoflow.observability import queries as obs_queries

        st = obs_queries.observability_status()
        if st.get("enabled"):
            page = obs_queries.list_tool_invocations(
                thread_id=tid,
                tool_name=tool_name,
                status=status,
                page_size=min(100, max(1, limit * 3)),
            )
            raw = page.get("items") if isinstance(page, dict) else []
            if isinstance(raw, list):
                items = [dict(x) for x in raw if isinstance(x, dict)]
                source = "observability"
    except Exception as e:
        logger.debug("tool_timeline observability query failed: %s", e)

    if not items:
        source = "none"

    q = str(query or "").strip().lower()
    if q:
        filtered: list[dict[str, Any]] = []
        for row in items:
            blob = " ".join(
                [
                    str(row.get("tool_name") or ""),
                    str(row.get("output_text") or ""),
                    str(row.get("input_json") or ""),
                    str(row.get("error_message") or ""),
                ]
            ).lower()
            if q in blob:
                filtered.append(row)
        items = filtered

    if tool_name and source == "observability":
        tn = tool_name.strip().lower()
        items = [r for r in items if str(r.get("tool_name") or "").lower() == tn]
    if status:
        st_f = status.strip().lower()
        items = [r for r in items if str(r.get("status") or "").lower() == st_f]

    for row in items:
        if not row.get("persisted_output_path"):
            row["persisted_output_path"] = _extract_persisted_path(str(row.get("output_text") or ""))

    items = items[: max(1, min(100, limit))]
    return {
        "ok": True,
        "thread_id": tid,
        "source": source,
        "query": query,
        "count": len(items),
        "items": items,
    }


def format_tool_timeline_for_agent(data: dict[str, Any]) -> str:
    if not data.get("ok"):
        return f"Tool timeline error: {data.get('reason', 'unknown')}"
    items = data.get("items") or []
    if not items:
        q = data.get("query")
        return f"No tool timeline entries found{f' for query {q!r}' if q else ''}."
    lines = [f"Tool timeline ({data.get('source', '?')}, {len(items)} entries, newest first):", ""]
    for i, row in enumerate(items, 1):
        name = row.get("tool_name") or "?"
        st = row.get("status") or "?"
        ended = row.get("ended_at") or row.get("started_at") or ""
        dur = row.get("duration_ms")
        dur_s = f" {dur:.0f}ms" if isinstance(dur, (int, float)) else ""
        lines.append(f"{i}. [{ended}] {name} ({st}{dur_s}) id={row.get('tool_call_id', '')}")
        out_prev = str(row.get("output_text") or "").replace("\n", " ")[:240]
        if out_prev:
            lines.append(f"   output: {out_prev}")
        path = row.get("persisted_output_path")
        if path:
            lines.append(f"   persisted: {path}")
    return "\n".join(lines)
