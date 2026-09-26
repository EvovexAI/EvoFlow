"""Publish KB injection citations to the live ``runs/stream`` SSE channel.

The KbInjectionMiddleware injects a knowledge-context ``HumanMessage`` before the
LLM call. The citations metadata (per-document title/path/score/snippet) was,
until now, only available inside LangGraph state — invisible to the live UI.

This module lets the middleware *also* push a ``kb_citations`` EVF event onto the
thread's inject queue right when the search completes. The middle layer's
already-running pump then forwards it to the browser as the very first SSE
frame the user sees — before any model token — so the chat panel can render
inline ``[1][2]`` anchors (Perplexity / Cursor style).

Wire format::

    event: evf
    data: {"type":"kb_citations","data":{"query":...,"agent_code":...,
            "citations":[{"index":1,"title":...,"path":...,"vault_id":...,
                          "score":...,"snippet_excerpt":"..."}, ...]}}

See ``app.gateway.streaming.session_stream_inject`` for the EVF framing.
"""

from __future__ import annotations

import json
import logging
from typing import Any

logger = logging.getLogger(__name__)

_KB_CITATIONS_TYPE = "kb_citations"

# Snippet cap — UI hover-card shows ~ 240 chars; bigger would clog messages.
_CITATION_SNIPPET_CHARS = 240


def _truncate(value: str | None, n: int) -> str:
    if not value:
        return ""
    text = str(value).strip()
    if len(text) <= n:
        return text
    return text[: max(0, n - 1)].rstrip() + "…"


def _build_citation(index: int, raw: dict[str, Any]) -> dict[str, Any]:
    """Shape one search result for the UI hover-card and inline marker."""
    title = str(raw.get("title") or raw.get("file_name") or raw.get("path") or "").strip()
    path = str(raw.get("path") or raw.get("file_name") or "").strip()
    snippet = str(raw.get("snippet") or raw.get("content") or "").strip()
    score = raw.get("score")
    vault_id = str(raw.get("vaultId") or raw.get("dataset_id") or "").strip()
    doc_id = str(raw.get("id") or raw.get("chunk_id") or "").strip()
    return {
        "index": int(index),
        "title": title or "(untitled)",
        "path": path,
        "vault_id": vault_id,
        "doc_id": doc_id,
        "score": round(float(score), 3) if score is not None else None,
        "snippet_excerpt": _truncate(snippet, _CITATION_SNIPPET_CHARS),
    }


def build_kb_citations_payload(
    *,
    query: str,
    agent_code: str | None,
    results: list[dict[str, Any]],
) -> dict[str, Any]:
    """Build the EVF ``kb_citations`` payload from raw search results.

    Public so tests and ad-hoc publishers can use it. ``results`` must already be
    pre-sorted by score descending and pre-truncated to ``top_k``.
    """
    citations = [_build_citation(idx + 1, r) for idx, r in enumerate(results) if isinstance(r, dict)]
    return {
        "type": _KB_CITATIONS_TYPE,
        "data": {
            "query": str(query or ""),
            "agent_code": str(agent_code or "").strip() or None,
            "count": len(citations),
            "citations": citations,
        },
    }


def publish_kb_citations(
    *,
    thread_id: str | None,
    query: str,
    agent_code: str | None,
    results: list[dict[str, Any]],
) -> bool:
    """Push a ``kb_citations`` EVF event onto the thread's inject queue.

    Returns ``True`` when the frame was queued. ``False`` is not an error — the
    thread simply isn't being streamed (e.g. proactive background run) and the
    citations will arrive with the persisted message instead. Never raises.
    """
    try:
        tid = str(thread_id or "").strip()
        if not tid:
            logger.debug("KbCitationsPublish: skip — no thread_id (proactive run?)")
            return False
        payload = build_kb_citations_payload(
            query=query, agent_code=agent_code, results=results,
        )
        # Lazy import — keep middleware ergonomic to import even when
        # session_stream_inject isn't initialized (e.g. background workers).
        from app.gateway.streaming.session_stream_inject import inject_evf_frame

        # inject_evf_frame is async; in sync paths we run a one-shot loop.
        import asyncio

        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = None
        if loop is not None:
            loop.create_task(inject_evf_frame(tid, payload))
        else:
            asyncio.run(inject_evf_frame(tid, payload))
        logger.debug(
            "KbCitationsPublish: queued thread=%s query=%r count=%d",
            tid, str(query or "")[:60], payload["data"]["count"],
        )
        return True
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("KbCitationsPublish: failed thread=%s err=%s", thread_id, exc)
        return False


def encode_kb_citations_payload(payload: dict[str, Any]) -> bytes:
    """Helper for tests / debug — encode an EVF ``kb_citations`` frame.

    Wire bytes are produced by ``session_stream_inject.format_evf_direct_frame``
    at the middleware layer; this local encoder mirrors the JSON content shape
    so unit tests don't need the ASGI gate.
    """
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    return f"event: evf\ndata: {body}\n\n".encode("utf-8")
