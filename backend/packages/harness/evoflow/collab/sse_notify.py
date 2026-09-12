"""Push detached collab subtask ``custom`` events into the main chat ``runs/stream``."""

from __future__ import annotations

import asyncio
import logging
import os
from collections.abc import Callable
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

_TASK_CUSTOM_TO_SSE: dict[str, str] = {
    "task_started": "task:started",
    "task_running": "task:running",
    "task_completed": "task:completed",
    "task_failed": "task:failed",
    "task_timed_out": "task:timed_out",
}

_relay_skip_logged = False


def _resolve_lead_thread_id(main_task_id: str) -> str | None:
    """LangGraph lead ``thread_id`` for the session ``runs/stream``."""
    mid = str(main_task_id or "").strip()
    if not mid:
        return None
    try:
        from evoflow.collab.storage import find_main_task, get_project_storage

        row = find_main_task(get_project_storage(), mid)
        if not row:
            return None
        _proj, task = row
        tid = str(task.get("thread_id") or "").strip()
        return tid or None
    except Exception:
        return None


def _internal_events_secret() -> str:
    secret = (os.getenv("INTERNAL_EVENTS_SECRET") or "").strip()
    if secret:
        return secret
    candidates: list[Path] = []
    for p in (os.getenv("EVOFLOW_BACKEND_DIR"), os.getenv("EVOFLOW_REPO_ROOT")):
        if p:
            candidates.append(Path(p))
    here = Path(__file__).resolve()
    candidates.extend([here.parents[4], here.parents[5], Path.cwd()])
    seen: set[Path] = set()
    for root in candidates:
        try:
            root = root.resolve()
        except Exception:
            continue
        if root in seen:
            continue
        seen.add(root)
        env_path = root / ".env"
        if not env_path.is_file():
            continue
        try:
            for line in env_path.read_text(encoding="utf-8", errors="ignore").splitlines():
                if not line.strip().startswith("INTERNAL_EVENTS_SECRET"):
                    continue
                _, _, val = line.partition("=")
                secret = val.strip().strip('"').strip("'")
                if secret:
                    return secret
        except Exception:
            continue
    return ""


def _is_gateway_sse_host() -> bool:
    return (os.getenv("EVOFLOW_GATEWAY_PROCESS") or "").strip().lower() in ("1", "true", "yes")


def _trace_relay_skip(reason: str, main_task_id: str, event_type: str) -> None:
    global _relay_skip_logged
    try:
        from evoflow.collab.subtask_stream_trace import stream_warn

        if not _relay_skip_logged:
            _relay_skip_logged = True
            stream_warn(
                "session_inject_drop reason=%s main=%s type=%s "
                "(no active runs/stream on gateway; set INTERNAL_EVENTS_SECRET for LangGraph relay)",
                reason,
                main_task_id,
                event_type,
            )
        else:
            stream_warn("session_inject_drop reason=%s main=%s type=%s", reason, main_task_id, event_type)
    except Exception:
        pass


def _schedule_gateway_emit(coro) -> None:
    try:
        loop = asyncio.get_running_loop()
        loop.create_task(coro, name="session_stream_inject")
        return
    except RuntimeError:
        pass
    try:
        from evoflow.subagents.detached_poll_scheduler import schedule_detached_poll

        schedule_detached_poll(coro, name="session_stream_inject")
    except Exception:
        logger.debug("session stream inject schedule failed", exc_info=True)


def make_gateway_task_stream_writer(main_task_id: str) -> Callable[[dict[str, Any]], None]:
    """Writer for detached subtasks → main chat ``runs/stream`` ``custom`` frames."""

    mid = str(main_task_id or "").strip()

    def writer(message: dict[str, Any]) -> None:
        if not mid:
            return
        msg_type = str(message.get("type") or "").strip()
        if msg_type not in _TASK_CUSTOM_TO_SSE:
            return
        data: dict[str, Any] = dict(message)
        collab_sid = str(
            message.get("collab_subtask_id") or message.get("collabSubtaskId") or "",
        ).strip()
        if collab_sid:
            data["collab_subtask_id"] = collab_sid
        task_exec = str(message.get("task_exec_id") or message.get("task_id") or "").strip()
        if task_exec and not str(data.get("task_id") or "").startswith("Subtask_"):
            data["task_exec_id"] = task_exec
        if collab_sid:
            data["task_id"] = collab_sid
        else:
            data.setdefault("task_id", mid)

        async def _emit() -> None:
            await inject_collab_subtask_custom(mid, data)

        try:
            from evoflow.collab.subtask_stream_trace import stream_info

            stream_info(
                "gateway_writer_enqueue main=%s msg_type=%s sub=%s exec=%s",
                mid,
                msg_type,
                collab_sid or "-",
                task_exec or "-",
            )
        except Exception:
            pass

        _schedule_gateway_emit(_emit())

    return writer


async def inject_collab_subtask_custom(main_task_id: str, data: dict[str, Any]) -> bool:
    """Inject ``task_*`` custom payload into the lead session ``runs/stream``."""
    mid = str(main_task_id or "").strip()
    try:
        from evoflow.collab.ws_notify import broadcast_subtask_stream_payload

        await broadcast_subtask_stream_payload(mid, data)
    except Exception:
        logger.debug("subtask stream ws broadcast failed", exc_info=True)

    thread_id = _resolve_lead_thread_id(mid)
    if not thread_id:
        _trace_relay_skip("no_lead_thread_id", mid, str(data.get("type") or ""))
        return False

    if _is_gateway_sse_host():
        try:
            from app.gateway.streaming.session_stream_inject import inject_langgraph_custom

            if await inject_langgraph_custom(thread_id, data):
                return True
        except ImportError:
            pass

    secret = _internal_events_secret()
    if not secret:
        _trace_relay_skip("no_INTERNAL_EVENTS_SECRET", mid, str(data.get("type") or ""))
        return False

    base = (os.getenv("EVOFLOW_GATEWAY_URL") or "http://127.0.0.1:8001").rstrip("/")
    url = f"{base}/api/events/internal/inject-custom"
    try:
        import httpx

        async with httpx.AsyncClient(timeout=3.0) as client:
            resp = await client.post(
                url,
                json={"thread_id": thread_id, "main_task_id": mid, "data": data},
                headers={"X-Internal-Events-Secret": secret},
            )
            if resp.status_code >= 400:
                _trace_relay_skip(f"http_{resp.status_code}", mid, str(data.get("type") or ""))
                return False
            try:
                return bool(resp.json().get("ok"))
            except Exception:
                return True
    except Exception:
        _trace_relay_skip("http_error", mid, str(data.get("type") or ""))
        return False


async def broadcast_collab_subtask_stream(
    main_task_id: str,
    event_type: str,
    *,
    subtask_id: str,
    **extra: Any,
) -> None:
    from evoflow.collab.dag_trace import dag_info, dag_warning

    sid = str(subtask_id or "").strip()
    mid = str(main_task_id or "").strip()
    if not mid or not sid:
        dag_warning("sse_skip event=%s main=%r sub=%r", event_type, main_task_id, subtask_id)
        return
    inner_type = {
        "task:started": "task_started",
        "task:running": "task_running",
        "task:completed": "task_completed",
        "task:failed": "task_failed",
        "task:timed_out": "task_timed_out",
    }.get(str(event_type or "").strip(), str(event_type or "").replace(":", "_"))
    payload: dict[str, Any] = {"type": inner_type, "task_id": sid, "collab_subtask_id": sid, **extra}
    dag_info("session_inject_emit main=%s sub=%s event=%s", mid, sid, event_type)
    await inject_collab_subtask_custom(mid, payload)


def schedule_collab_subtask_stream(
    main_task_id: str,
    event_type: str,
    *,
    subtask_id: str,
    **extra: Any,
) -> None:
    async def _go() -> None:
        await broadcast_collab_subtask_stream(main_task_id, event_type, subtask_id=subtask_id, **extra)

    _schedule_gateway_emit(_go())


async def broadcast_collab_peer_event(main_task_id: str, event_type: str, data: dict[str, Any]) -> None:
    await broadcast_collab_task_event(main_task_id, event_type, dict(data))


async def broadcast_collab_task_event(main_task_id: str, event_type: str, data: dict[str, Any]) -> bool:
    """Legacy name — routes into main chat ``runs/stream`` (not task/panel SSE)."""
    payload = dict(data)
    inner = str(payload.get("type") or "").strip()
    if not inner.startswith("task_"):
        mapped = {
            "task:started": "task_started",
            "task:running": "task_running",
            "task:completed": "task_completed",
            "task:failed": "task_failed",
            "task:timed_out": "task_timed_out",
        }.get(str(event_type or "").strip())
        if mapped:
            payload["type"] = mapped
    return await inject_collab_subtask_custom(main_task_id, payload)


async def _broadcast_tool_approval_pending_sse(
    thread_id: str,
    *,
    tool_call_id: str,
    tool_name: str,
    summary: str,
    risk: str,
) -> bool:
    """Broadcast ``tool_approval:pending`` to panel SSE subscribers for a thread.

    Direct call when same-process (gateway host); HTTP relay otherwise.
    """
    tid = str(thread_id or "").strip()
    if not tid:
        return False
    data = {
        "tool_call_id": tool_call_id,
        "tool_name": tool_name,
        "summary": summary,
        "risk": risk,
    }
    if _is_gateway_sse_host():
        try:
            from app.gateway.routers.events import EventBroadcaster

            await EventBroadcaster.get_instance().broadcast(tid, "tool_approval:pending", data)
            return True
        except Exception:
            logger.debug("tool_approval SSE direct broadcast failed", exc_info=True)
            return False
    secret = _internal_events_secret()
    if not secret:
        logger.debug("tool_approval SSE relay skipped (no INTERNAL_EVENTS_SECRET)")
        return False
    base = (os.getenv("EVOFLOW_GATEWAY_URL") or "http://127.0.0.1:8001").rstrip("/")
    url = f"{base}/api/events/internal/broadcast"
    try:
        import httpx

        async with httpx.AsyncClient(timeout=3.0) as client:
            resp = await client.post(
                url,
                json={"event_type": "tool_approval:pending", "thread_id": tid, "data": data},
                headers={"X-Internal-Events-Secret": secret},
            )
            return resp.status_code < 400
    except Exception:
        logger.debug("tool_approval SSE HTTP relay failed", exc_info=True)
        return False


def schedule_tool_approval_pending_sse(
    thread_id: str,
    *,
    tool_call_id: str,
    tool_name: str,
    summary: str,
    risk: str,
) -> None:
    """Fire-and-forget: push a ``tool_approval:pending`` panel SSE event.

    Uses ``_schedule_gateway_emit`` so it works in both sync and async contexts.
    """
    async def _go() -> None:
        await _broadcast_tool_approval_pending_sse(
            thread_id,
            tool_call_id=tool_call_id,
            tool_name=tool_name,
            summary=summary,
            risk=risk,
        )

    _schedule_gateway_emit(_go())
