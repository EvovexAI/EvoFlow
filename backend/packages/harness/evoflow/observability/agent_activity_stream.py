"""Push live agent phase hints into the active LangGraph ``runs/stream`` (custom channel)."""

from __future__ import annotations

import logging
import os
import threading
from typing import Any

logger = logging.getLogger(__name__)

# panel-stream 控制面事件：无 live runs/stream 的后台 run（proactive 值班等）
# 用它把步骤进度广播给已订阅该 thread 的前端。
PANEL_ACTIVITY_EVENT = "panel:activity"

_last_detail_by_thread: dict[str, str] = {}
_lock = threading.Lock()


def _detail_changed(thread_id: str, detail: str) -> bool:
    tid = str(thread_id or "").strip()
    d = str(detail or "").strip()
    if not tid or not d:
        return False
    with _lock:
        if _last_detail_by_thread.get(tid) == d:
            return False
        _last_detail_by_thread[tid] = d
        return True


def clear_agent_activity(thread_id: str) -> None:
    tid = str(thread_id or "").strip()
    if not tid:
        return
    with _lock:
        _last_detail_by_thread.pop(tid, None)


def _payload(
    *,
    kind: str,
    detail: str,
    tool_name: str | None = None,
    tool_calls: list[dict[str, Any]] | None = None,
    attempt: int | None = None,
    max_attempts: int | None = None,
    wait_s: float | None = None,
    reason: str | None = None,
) -> dict[str, Any]:
    out: dict[str, Any] = {
        "type": "agent_activity",
        "kind": str(kind or "system").strip() or "system",
        "detail": str(detail or "").strip(),
    }
    if tool_name:
        out["tool_name"] = str(tool_name).strip()
    if tool_calls:
        out["tool_calls"] = [c for c in tool_calls if isinstance(c, dict)]
    # Structured retry fields for V4 control.apiRetry (no detail scraping).
    if attempt is not None:
        try:
            out["attempt"] = int(attempt)
        except (TypeError, ValueError):
            pass
    if max_attempts is not None:
        try:
            out["max_attempts"] = int(max_attempts)
        except (TypeError, ValueError):
            pass
    if wait_s is not None:
        try:
            out["wait_s"] = float(wait_s)
        except (TypeError, ValueError):
            pass
    if reason is not None and str(reason).strip():
        out["reason"] = str(reason).strip()
    return out


def _try_stream_writer(payload: dict[str, Any]) -> bool:
    try:
        from langgraph.config import get_stream_writer

        writer = get_stream_writer()
    except Exception:
        return False
    if not writer:
        return False
    try:
        writer(payload)
        return True
    except Exception:
        logger.debug("agent_activity stream_writer failed", exc_info=True)
        return False


def _schedule_http_inject(thread_id: str, payload: dict[str, Any]) -> None:
    async def _go() -> None:
        secret = (os.getenv("INTERNAL_EVENTS_SECRET") or "").strip()
        if not secret:
            return
        base = (os.getenv("EVOFLOW_GATEWAY_URL") or "http://127.0.0.1:8001").rstrip("/")
        url = f"{base}/api/events/internal/inject-evf"
        try:
            import httpx

            async with httpx.AsyncClient(timeout=3.0) as client:
                await client.post(
                    url,
                    json={"thread_id": thread_id, "payload": payload},
                    headers={"X-Internal-Events-Secret": secret},
                )
        except Exception:
            logger.debug("agent_activity http inject failed thread=%s", thread_id, exc_info=True)

    # NEVER create_task on the LangGraph job loop — make_lead/set_live_progress runs
    # inside astream_state; those httpx tasks then starve the 1.4s ready→metadata gap.
    try:
        from evoflow.subagents.detached_poll_scheduler import schedule_detached_poll

        schedule_detached_poll(_go(), name="agent_activity_inject")
    except Exception:
        logger.debug("agent_activity inject schedule failed", exc_info=True)


async def _relay_panel_activity_http(thread_id: str, payload: dict[str, Any]) -> None:
    """Off-process fallback: relay ``panel:activity`` through the gateway internal broadcast."""
    secret = (os.getenv("INTERNAL_EVENTS_SECRET") or "").strip()
    if not secret:
        return
    base = (os.getenv("EVOFLOW_GATEWAY_URL") or "http://127.0.0.1:8001").rstrip("/")
    url = f"{base}/api/events/internal/broadcast"
    try:
        import httpx

        async with httpx.AsyncClient(timeout=3.0) as client:
            await client.post(
                url,
                json={
                    "event_type": PANEL_ACTIVITY_EVENT,
                    "thread_id": thread_id,
                    "data": payload,
                },
                headers={"X-Internal-Events-Secret": secret},
            )
    except Exception:
        logger.debug("agent_activity panel relay failed thread=%s", thread_id, exc_info=True)


async def _broadcast_panel_activity(thread_id: str, payload: dict[str, Any]) -> None:
    """In-process EventBroadcaster first; off-process falls back to the HTTP relay."""
    try:
        from evoflow.runtime.ports import broadcast_event

        if await broadcast_event(thread_id, PANEL_ACTIVITY_EVENT, payload):
            return
    except Exception:
        logger.debug("agent_activity panel broadcast failed thread=%s", thread_id, exc_info=True)
    await _relay_panel_activity_http(thread_id, payload)


def _schedule_panel_activity_broadcast(thread_id: str, payload: dict[str, Any]) -> None:
    # NEVER create_task on the LangGraph job loop (same rationale as _schedule_http_inject).
    try:
        from evoflow.subagents.detached_poll_scheduler import schedule_detached_poll

        schedule_detached_poll(
            _broadcast_panel_activity(thread_id, payload),
            name="agent_activity_panel_broadcast",
        )
    except Exception:
        logger.debug("agent_activity panel broadcast schedule failed", exc_info=True)


def emit_panel_activity(
    thread_id: str,
    *,
    kind: str,
    detail: str,
    force: bool = False,
) -> None:
    """Broadcast a ``panel:activity`` control-plane event for background runs.

    proactive 值班等无 live ``runs/stream`` 的场景，前端经
    ``/api/events/threads/{tid}/panel-stream`` 收到后驱动 spinner/状态文案。
    """
    tid = str(thread_id or "").strip()
    d = str(detail or "").strip()
    if not tid or not d:
        return
    if not force and not _detail_changed(tid, d):
        return
    _schedule_panel_activity_broadcast(tid, _payload(kind=kind, detail=d))


def build_proactive_phase_detail(phase: str, role_name: str | None) -> str:
    """proactive 执行桥的排队/收尾阶段文案（前端状态条直接展示）。"""
    role = str(role_name or "").strip()
    if phase == "queued":
        return f"任务已接受 · 正在唤醒 {role or '值班 agent'}…"
    if phase == "finished":
        return "本回合执行已结束"
    return str(phase or "").strip()


def emit_agent_activity(
    thread_id: str,
    *,
    kind: str,
    detail: str,
    tool_name: str | None = None,
    tool_calls: list[dict[str, Any]] | None = None,
    force: bool = False,
    attempt: int | None = None,
    max_attempts: int | None = None,
    wait_s: float | None = None,
    reason: str | None = None,
) -> None:
    """Emit a phase hint (model prep / model call / tool execution) into the live SSE stream."""
    tid = str(thread_id or "").strip()
    d = str(detail or "").strip()
    if not tid or not d:
        return
    if not force and not _detail_changed(tid, d):
        return
    payload = _payload(
        kind=kind,
        detail=d,
        tool_name=tool_name,
        tool_calls=tool_calls,
        attempt=attempt,
        max_attempts=max_attempts,
        wait_s=wait_s,
        reason=reason,
    )
    if _try_stream_writer(payload):
        return
    inject: dict[str, Any] = {
        "type": "activity",
        "kind": payload["kind"],
        "detail": d,
    }
    if tool_name:
        inject["tool_name"] = tool_name
    if tool_calls:
        inject["tool_calls"] = [c for c in tool_calls if isinstance(c, dict)]
    for key in ("attempt", "max_attempts", "wait_s", "reason"):
        if key in payload:
            inject[key] = payload[key]
    try:
        from evoflow.runtime.ports import (
            asgi_stream_active,
            middle_layer_covers_thread,
            schedule_inject_evf_frame,
        )

        if middle_layer_covers_thread(tid):
            schedule_inject_evf_frame(tid, inject)
            return
        if asgi_stream_active(tid):
            # live runs/stream 代理在场但没有 middle layer：保留既有 inject-evf 通路。
            _schedule_http_inject(tid, inject)
            return
    except Exception:
        logger.debug("agent_activity direct inject failed thread=%s", tid, exc_info=True)
    # 无 live 流的后台 run（proactive 直连等）：inject-evf 注不进任何流，
    # 改走 panel-stream 控制面广播，前端才能拿到步骤文案。
    _schedule_panel_activity_broadcast(tid, payload)
