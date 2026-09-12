"""Gateway-side live run snapshot persistence (survives browser disconnect)."""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

logger = logging.getLogger(__name__)

_FLUSH_INTERVAL_MS = max(1000, int(float(__import__("os").getenv("EVOFLOW_LIVE_RUN_FLUSH_MS", "3000") or "3000")))
_last_flush_ms: dict[str, float] = {}
_session_key_cache: dict[str, str | None] = {}
_pending_snapshot_tasks: set[asyncio.Task[None]] = set()


def _resolve_session_key(thread_id: str) -> str | None:
    tid = str(thread_id or "").strip()
    if not tid:
        return None
    if tid in _session_key_cache:
        return _session_key_cache[tid]
    sk: str | None = None
    try:
        from evoflow.persistence.session_repositories import find_session_key_by_thread_id

        sk = find_session_key_by_thread_id(tid)
    except Exception:
        logger.debug("live snapshot: resolve session_key failed thread=%s", tid, exc_info=True)
    _session_key_cache[tid] = sk
    return sk


def _resolve_run_id(thread_id: str, run_id: str | None = None) -> str | None:
    rid = str(run_id or "").strip()
    if rid:
        return rid
    try:
        from evoflow.persistence.session_run_state import peek_current_run_id

        return str(peek_current_run_id(thread_id=thread_id) or "").strip() or None
    except Exception:
        return None


def maybe_upsert_gateway_live_snapshot(
    thread_id: str,
    *,
    partial_text: str = "",
    partial_tools: list[dict[str, Any]] | None = None,
    partial_display_segments: list[dict[str, Any]] | None = None,
    run_id: str | None = None,
    status: str = "running",
    force: bool = False,
) -> None:
    tid = str(thread_id or "").strip()
    if not tid:
        return
    now_ms = int(time.time() * 1000)
    if not force and now_ms - _last_flush_ms.get(tid, 0) < _FLUSH_INTERVAL_MS:
        return
    sk = _resolve_session_key(tid)
    rid = _resolve_run_id(tid, run_id)
    if not sk or not rid:
        return
    text = str(partial_text or "")
    tools = partial_tools if isinstance(partial_tools, list) else []
    display_segments = partial_display_segments if isinstance(partial_display_segments, list) else []
    if not text and not tools and not display_segments and not force:
        return
    try:
        from evoflow.persistence import live_run_repositories as live_repo

        existing = live_repo.get_live_run_snapshot(sk)
        if existing:
            existing_at = int(existing.get("lastEventAtMs") or existing.get("last_event_at_ms") or 0)
            if not force and existing_at > now_ms:
                return
        live_repo.upsert_live_run_snapshot(
            sk,
            run_id=rid,
            thread_id=tid,
            status=status,
            partial_text=text,
            partial_tools=tools,
            partial_display_segments=display_segments,
            last_event_at_ms=now_ms,
        )
        _last_flush_ms[tid] = now_ms
    except Exception:
        logger.debug("live snapshot upsert failed thread=%s session=%s", tid, sk, exc_info=True)


def clear_gateway_live_snapshot(thread_id: str | None = None, *, session_key: str | None = None) -> None:
    tid = str(thread_id or "").strip()
    sk = str(session_key or "").strip() or None
    if tid:
        _last_flush_ms.pop(tid, None)
        _session_key_cache.pop(tid, None)
    if not sk and tid:
        sk = _resolve_session_key(tid)
    if not sk:
        return
    try:
        from evoflow.persistence import live_run_repositories as live_repo

        live_repo.delete_live_run_snapshot(sk)
    except Exception:
        logger.debug("live snapshot clear failed session=%s", sk, exc_info=True)


def snapshot_from_normalizer_payload(thread_id: str, normalizer: Any) -> dict[str, Any] | None:
    tid = str(thread_id or "").strip()
    if not tid or normalizer is None:
        return None
    partial_text = ""
    partial_display_segments: list[dict[str, Any]] = []
    block_ledger = getattr(normalizer, "block_ledger", None)
    if block_ledger is not None:
        try:
            from evoflow.persistence.chat_message_content import flatten_display_segments_text

            segs = block_ledger.snapshot_display_segments()
            partial_display_segments = segs if isinstance(segs, list) else []
            partial_text = flatten_display_segments_text(segs)
        except Exception:
            partial_text = ""
            partial_display_segments = []
    if not partial_text:
        partial_text = str(getattr(normalizer, "final_text", "") or "").strip()
    if not partial_text and getattr(normalizer, "last_values_messages", None):
        try:
            from app.gateway.sse_ui_normalize import (
                _collect_assistant_texts_after_human,
                _find_last_real_human_idx,
                _merge_turn_assistant_texts,
            )

            messages = list(getattr(normalizer, "last_values_messages", []) or [])
            hidx = _find_last_real_human_idx(messages)
            if hidx >= 0:
                partial_text = _merge_turn_assistant_texts(
                    _collect_assistant_texts_after_human(
                        messages,
                        hidx,
                        str(getattr(normalizer, "prev_turn_prefix", "") or ""),
                    )
                )
        except Exception:
            pass
    tools: list[dict[str, Any]] = []
    emitted = getattr(normalizer, "emitted_tool_call_ids", None) or set()
    if emitted:
        tools = [{"tool_call_id": tid_, "name": tid_} for tid_ in list(emitted)[:32]]
    if not partial_text and not tools and not partial_display_segments:
        return None
    return {
        "thread_id": tid,
        "partial_text": partial_text,
        "partial_tools": tools,
        "partial_display_segments": partial_display_segments,
    }


def snapshot_from_normalizer(thread_id: str, normalizer: Any, *, force: bool = False) -> None:
    payload = snapshot_from_normalizer_payload(thread_id, normalizer)
    if not payload:
        return
    maybe_upsert_gateway_live_snapshot(
        payload["thread_id"],
        partial_text=payload["partial_text"],
        partial_tools=payload["partial_tools"],
        partial_display_segments=payload.get("partial_display_segments"),
        force=force,
    )


def _track_snapshot_task(task: asyncio.Task[None]) -> None:
    _pending_snapshot_tasks.add(task)
    task.add_done_callback(_pending_snapshot_tasks.discard)


def schedule_snapshot_from_normalizer(thread_id: str, normalizer: Any, *, force: bool = False) -> None:
    payload = snapshot_from_normalizer_payload(thread_id, normalizer)
    if not payload:
        return

    # Prefer async offload when a loop is running; otherwise sync upsert.
    # Always close the coro if create_task fails so we never leak
    # "coroutine was never awaited".
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        snapshot_from_normalizer(thread_id, normalizer, force=force)
        return

    async def runner() -> None:
        await asyncio.to_thread(
            maybe_upsert_gateway_live_snapshot,
            payload["thread_id"],
            partial_text=payload["partial_text"],
            partial_tools=payload["partial_tools"],
            partial_display_segments=payload.get("partial_display_segments"),
            force=force,
        )

    coro = runner()
    try:
        task = loop.create_task(coro)
    except Exception:
        coro.close()
        snapshot_from_normalizer(thread_id, normalizer, force=force)
        return
    _track_snapshot_task(task)

async def flush_live_snapshot_from_langgraph_state(
    thread_id: str,
    *,
    langgraph_base_url: str,
    headers: dict[str, str] | None = None,
    run_id: str | None = None,
) -> None:
    """On disconnect, persist latest checkpoint state into live_run."""
    import httpx

    tid = str(thread_id or "").strip()
    if not tid:
        return
    url = f"{langgraph_base_url.rstrip('/')}/threads/{tid}/state"
    try:
        timeout = httpx.Timeout(connect=3.0, read=12.0, write=8.0, pool=10.0)
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.get(url, headers=headers or {})
        if resp.status_code != 200:
            return
        data = resp.json()
    except Exception:
        logger.debug("flush live snapshot: state fetch failed thread=%s", tid, exc_info=True)
        return

    partial_text = ""
    tools: list[dict[str, Any]] = []
    try:
        from app.gateway.sse_ui_normalize import (
            _collect_assistant_texts_after_human,
            _find_last_real_human_idx,
            _merge_turn_assistant_texts,
        )

        values = data.get("values") if isinstance(data, dict) else data
        messages = values.get("messages") if isinstance(values, dict) else None
        if isinstance(messages, list):
            hidx = _find_last_real_human_idx(messages)
            if hidx >= 0:
                partial_text = _merge_turn_assistant_texts(
                    _collect_assistant_texts_after_human(messages, hidx, "")
                )
    except Exception:
        pass

    maybe_upsert_gateway_live_snapshot(
        tid,
        partial_text=partial_text,
        partial_tools=tools,
        run_id=run_id,
        force=True,
    )
