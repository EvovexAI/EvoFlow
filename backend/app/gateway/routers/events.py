"""SSE (Server-Sent Events) router for real-time collaboration events."""

import asyncio
import json
import logging
import os
from collections import defaultdict
from typing import Any

from fastapi import APIRouter, Header, HTTPException, Request, WebSocket
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from evoflow.authz.http_guard import require_task_visible, require_thread_visible
from evoflow.collab.storage import find_main_task, get_project_storage
from evoflow.runtime.long_run_limits import LONG_RUN_STREAM_READ_SECONDS
from evoflow.timeutil import utc_now_iso_z

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/events", tags=["events"])

# How long to wait for a collaboration event before emitting a ping.
# Default matches the long-run stream read limit so idle sessions don't get
# spammed with pings every 30 s.  Can be overridden via env var.
_EVENT_QUEUE_TIMEOUT = int(
    os.getenv("EVOFLOW_EVENT_QUEUE_TIMEOUT", LONG_RUN_STREAM_READ_SECONDS)
)


def _log_stream_debug(thread_id: str, phase: str, details: dict | None = None) -> None:
    """调试日志（不落盘，仅标准 logger）。"""
    if details:
        logger.debug("[stream_debug] thread=%s phase=%s details=%s", thread_id, phase, details)
    else:
        logger.debug("[stream_debug] thread=%s phase=%s", thread_id, phase)


# Observers keyed by thread_id - unified stream identifier
_thread_observers: dict[str, list[asyncio.Queue]] = defaultdict(list)
_thread_observer_lock = asyncio.Lock()
# Bound per-subscriber backlog so a slow SSE client cannot grow Gateway RSS unboundedly.
_SSE_QUEUE_MAXSIZE = max(16, int(os.getenv("EVOFLOW_SSE_QUEUE_MAXSIZE", "256") or 256))


def _enqueue_sse(queue: asyncio.Queue, payload: str) -> None:
    """Non-blocking put; drop oldest when the subscriber is behind."""
    try:
        queue.put_nowait(payload)
        return
    except asyncio.QueueFull:
        pass
    try:
        queue.get_nowait()
    except asyncio.QueueEmpty:
        pass
    try:
        queue.put_nowait(payload)
    except asyncio.QueueFull:
        pass


class EventBroadcaster:
    """Singleton event broadcaster for collaboration events."""

    _instance = None

    @classmethod
    def get_instance(cls):
        if cls._instance is None:
            cls._instance = EventBroadcaster()
        return cls._instance

    async def broadcast(self, thread_id: str, event_type: str, data: dict[str, Any]) -> None:
        """Broadcast an event to all SSE subscribers for this thread."""
        event = {
            "type": event_type,
            "data": data,
            "timestamp": utc_now_iso_z(),
        }

        async with _thread_observer_lock:
            queues = list(_thread_observers.get(thread_id, []))

        if str(event_type or "").startswith("task:"):
            try:
                from evoflow.collab.subtask_stream_trace import stream_info

                sub = str((data or {}).get("collab_subtask_id") or (data or {}).get("collabSubtaskId") or "").strip()
                stream_info(
                    "sse_broadcast main=%s type=%s observers=%s sub=%s inner_type=%s",
                    thread_id,
                    event_type,
                    len(queues),
                    sub or "-",
                    str((data or {}).get("type") or "").strip() or "-",
                )
            except Exception:
                pass
        _log_stream_debug(thread_id, "broadcast_called", {"event_type": event_type, "observer_count": len(queues), "data_preview": str(data)[:200]})

        # 调试日志：记录广播事件（高频事件仅在 debug 级别输出）
        if event_type == "lead_agent:chunk":
            _log_stream_debug(thread_id, "broadcast_lead_agent_chunk", {"observer_count": len(queues)})

        for queue in queues:
            try:
                _enqueue_sse(queue, json.dumps(event))
            except Exception as e:
                logger.warning("Failed to send event to observer: %s", e)

    def add_thread_observer(self, thread_id: str, queue: asyncio.Queue) -> None:
        """Add an observer for a thread."""
        _thread_observers[thread_id].append(queue)

    def remove_thread_observer(self, thread_id: str, queue: asyncio.Queue) -> None:
        """Remove a thread observer."""
        if thread_id in _thread_observers:
            try:
                _thread_observers[thread_id].remove(queue)
            except ValueError:
                pass
            if not _thread_observers[thread_id]:
                _thread_observers.pop(thread_id, None)


broadcaster = EventBroadcaster.get_instance()


async def event_generator(thread_id: str):
    """Generate SSE events for a thread."""
    from evoflow.observability.poll_loop_log import log_poll_loop_end, log_poll_loop_start, log_poll_tick

    queue: asyncio.Queue = asyncio.Queue(maxsize=_SSE_QUEUE_MAXSIZE)

    broadcaster.add_thread_observer(thread_id, queue)
    try:
        from evoflow.collab.subtask_stream_trace import stream_info

        async with _thread_observer_lock:
            obs = len(_thread_observers.get(thread_id, []))
        stream_info("sse_subscribe main=%s observers=%s", thread_id, obs)
    except Exception:
        pass

    try:
        yield "event: connected\ndata: {}\n\n"

        log_poll_loop_start("task_events_sse", task_id=thread_id)

        while True:
            log_poll_tick("task_events_sse", key=thread_id, interval_s=60.0)
            try:
                event_data = await asyncio.wait_for(queue.get(), timeout=_EVENT_QUEUE_TIMEOUT)
                yield f"data: {event_data}\n\n"
            except TimeoutError:
                yield "event: ping\ndata: {}\n\n"
            except (BrokenPipeError, ConnectionResetError, OSError):
                # Client disconnected, exit gracefully
                break
    except asyncio.CancelledError:
        pass
    except Exception as e:
        logger.debug("Event generator error for task %s: %s", thread_id, e)
    finally:
        log_poll_loop_end("task_events_sse", task_id=thread_id)
        broadcaster.remove_thread_observer(thread_id, queue)


@router.get(
    "/tasks/{task_id}/stream",
    summary="Subscribe to task collaboration events",
    description="SSE stream keyed by root/main task id (same id used in supervisor create_task).",
)
async def subscribe_task_events(request: Request, task_id: str):
    """Subscribe to collaboration events for a main task."""
    require_task_visible(request, task_id)
    storage = get_project_storage()
    if find_main_task(storage, task_id) is None:
        raise HTTPException(status_code=404, detail=f"Task '{task_id}' not found")

    return StreamingResponse(
        event_generator(task_id),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


async def emit_task_created(main_task_id: str, task: dict[str, Any]) -> None:
    """Emit a task created event."""
    await broadcaster.broadcast(main_task_id, "task:created", {"task": task})


async def emit_task_started(main_task_id: str, task_id: str, agent_id: str) -> None:
    """Emit a task started event."""
    await broadcaster.broadcast(main_task_id, "task:started", {"task_id": task_id, "agent_id": agent_id})


async def emit_task_progress(main_task_id: str, task_id: str, progress: int, current_step: str = "") -> None:
    """Emit a task progress event (``task_id`` in payload may be main or subtask)."""
    await broadcaster.broadcast(main_task_id, "task:progress", {"task_id": task_id, "progress": progress, "current_step": current_step})


async def emit_task_completed(main_task_id: str, task_id: str, result: Any = None) -> None:
    """Emit a task completed event."""
    await broadcaster.broadcast(main_task_id, "task:completed", {"task_id": task_id, "result": result})


async def emit_task_failed(main_task_id: str, task_id: str, error: str) -> None:
    """Emit a task failed event."""
    await broadcaster.broadcast(main_task_id, "task:failed", {"task_id": task_id, "error": error})


async def emit_task_heartbeat(main_task_id: str, task_id: str, agent_id: str, status: str, progress: int, current_step: str) -> None:
    """Emit a task heartbeat event."""
    await broadcaster.broadcast(
        main_task_id,
        "task:heartbeat",
        {
            "task_id": task_id,
            "agent_id": agent_id,
            "status": status,
            "progress": progress,
            "current_step": current_step,
        },
    )


async def emit_task_memory_updated(main_task_id: str, task_id: str, facts_count: int) -> None:
    """Emit a task detail updated event."""
    await broadcaster.broadcast(main_task_id, "task_detail:updated", {"task_id": task_id, "facts_count": facts_count})


async def emit_project_updated(main_task_id: str, status: str) -> None:
    """Emit a bundle-level update (channel is still the main task id)."""
    await broadcaster.broadcast(main_task_id, "project:updated", {"status": status})


class InternalBroadcastBody(BaseModel):
    """Body for LangGraph → gateway SSE fan-out (separate process)."""

    event_type: str
    data: dict[str, Any] = Field(default_factory=dict)
    thread_id: str = Field(default="", description="LangGraph thread id (session SSE channel key)")
    main_task_id: str = Field(default="", description="Optional main task id (logging only)")


class InternalInjectCustomBody(BaseModel):
    """Inject ``event: custom`` into the live main chat ``runs/stream`` proxy."""

    thread_id: str
    data: dict[str, Any] = Field(default_factory=dict)
    main_task_id: str = Field(default="", description="Optional main task id (logging only)")


class InternalInjectEvfBody(BaseModel):
    """Inject a normalized ``event: evf`` frame into the live ``runs/stream`` proxy."""

    thread_id: str
    payload: dict[str, Any] = Field(default_factory=dict)


@router.post("/internal/broadcast", summary="Internal broadcast", include_in_schema=False)
async def internal_broadcast(
    body: InternalBroadcastBody,
    x_internal_events_secret: str | None = Header(default=None, alias="X-Internal-Events-Secret"),
) -> dict[str, bool]:
    """Relay an event into the in-memory broadcaster (requires ``INTERNAL_EVENTS_SECRET``)."""
    expected = (os.getenv("INTERNAL_EVENTS_SECRET") or "").strip()
    if not expected:
        raise HTTPException(status_code=503, detail="Internal events disabled (set INTERNAL_EVENTS_SECRET).")
    if (x_internal_events_secret or "").strip() != expected:
        raise HTTPException(status_code=401, detail="Invalid internal events secret.")
    channel = str(body.thread_id or body.main_task_id or "").strip()
    if not channel:
        raise HTTPException(status_code=400, detail="thread_id or main_task_id required")
    await broadcaster.broadcast(channel, body.event_type, body.data)
    return {"ok": True}


@router.post("/internal/inject-custom", summary="Internal session stream inject", include_in_schema=False)
async def internal_inject_custom(
    body: InternalInjectCustomBody,
    x_internal_events_secret: str | None = Header(default=None, alias="X-Internal-Events-Secret"),
) -> dict[str, bool]:
    """Inject detached subtask ``custom`` frames into active ``runs/stream`` (requires secret)."""
    expected = (os.getenv("INTERNAL_EVENTS_SECRET") or "").strip()
    if not expected:
        raise HTTPException(status_code=503, detail="Internal events disabled (set INTERNAL_EVENTS_SECRET).")
    if (x_internal_events_secret or "").strip() != expected:
        raise HTTPException(status_code=401, detail="Invalid internal events secret.")
    tid = str(body.thread_id or "").strip()
    if not tid:
        raise HTTPException(status_code=400, detail="thread_id required")
    mid = str(body.main_task_id or "").strip()
    if mid:
        from evoflow.collab.sse_notify import inject_collab_subtask_custom

        ok = await inject_collab_subtask_custom(mid, body.data)
    else:
        from app.gateway.streaming.session_stream_inject import inject_langgraph_custom

        ok = await inject_langgraph_custom(tid, body.data)
        collab_tid = str((body.data or {}).get("collab_task_id") or "").strip()
        if collab_tid and str((body.data or {}).get("type") or "").startswith("task_"):
            try:
                from evoflow.collab.ws_notify import broadcast_subtask_stream_payload

                await broadcast_subtask_stream_payload(collab_tid, body.data)
            except Exception:
                pass
    return {"ok": ok}


@router.post("/internal/inject-evf", summary="Internal evf stream inject", include_in_schema=False)
async def internal_inject_evf(
    body: InternalInjectEvfBody,
    x_internal_events_secret: str | None = Header(default=None, alias="X-Internal-Events-Secret"),
) -> dict[str, bool]:
    """Inject ``event: evf`` activity/progress frames into active ``runs/stream`` (requires secret)."""
    expected = (os.getenv("INTERNAL_EVENTS_SECRET") or "").strip()
    if not expected:
        raise HTTPException(status_code=503, detail="Internal events disabled (set INTERNAL_EVENTS_SECRET).")
    if (x_internal_events_secret or "").strip() != expected:
        raise HTTPException(status_code=401, detail="Invalid internal events secret.")
    tid = str(body.thread_id or "").strip()
    if not tid:
        raise HTTPException(status_code=400, detail="thread_id required")
    from app.gateway.streaming.session_stream_inject import inject_evf_frame

    ok = await inject_evf_frame(tid, body.payload)
    return {"ok": ok}


# ============================================================================
# Stream Status Query API - 供前端查询流状态
# ============================================================================


@router.websocket("/ws/threads/{thread_id}")
async def websocket_thread_collab_stream(websocket: WebSocket, thread_id: str) -> None:
    """WebSocket: collab workflow state, task progress, and agent stream events for one thread."""
    from app.gateway.streaming.collab_ws import run_collab_thread_ws

    try:
        require_thread_visible(websocket, thread_id)  # type: ignore[arg-type]
    except HTTPException:
        await websocket.close(code=1008, reason="forbidden")
        return
    await run_collab_thread_ws(websocket, thread_id)


@router.get(
    "/threads/{thread_id}/panel-stream",
    summary="SSE: LangGraph thread panel notifications",
    description=(
        "Subscribe to ``EventBroadcaster`` events keyed by LangGraph ``thread_id`` "
        "(panel signals such as ``panel:hosted_remote_command``). "
        "Subtask streaming uses the main chat ``runs/stream`` custom channel."
    ),
)
async def subscribe_thread_panel_stream(request: Request, thread_id: str):
    """Panel/control-plane events for a chat thread (not collab main-task id)."""
    tid = str(thread_id or "").strip()
    if not tid:
        raise HTTPException(status_code=400, detail="thread_id is required")
    require_thread_visible(request, tid)
    return StreamingResponse(
        event_generator(tid),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "Content-Encoding": "identity",
            "X-Accel-Buffering": "no",
        },
    )


@router.get(
    "/threads/{thread_id}/stream-status",
    summary="Get stream status for frontend",
    description="返回流状态信息，供前端决定如何显示（历史回放/实时订阅）",
)
async def get_thread_stream_status(request: Request, thread_id: str) -> dict:
    """获取流状态信息。

    包括：
    - has_active_observers: 是否有活跃的 SSE 订阅者
    - observer_count: 订阅者数量
    - recently_completed: 是否有最近完成的 run（60s 内）
    - recently_completed_run_id: 最近完成 run 的 ID
    - recently_completed_status: 最近完成 run 的状态（success/error）
    """
    require_thread_visible(request, thread_id)

    import httpx
    from datetime import datetime, timezone

    logger.debug("[events.stream_status] query thread_id=%s", thread_id)

    result = {
        "thread_id": thread_id,
        "is_stream_active": False,
        "elapsed_seconds": None,
        "source": "none",
        "recently_completed": False,
        "recently_completed_run_id": None,
        "recently_completed_status": None,
        "run_completed": False,
        "run_completed_run_id": None,
        "run_completed_status": None,
    }

    # 1. 先检查 collab_phase
    try:
        from evoflow.collab.thread_collab import load_thread_collab_state
        from evoflow.config.paths import get_paths

        paths = get_paths()
        collab_state = load_thread_collab_state(paths, thread_id)
        phase = getattr(collab_state, "collab_phase", None)
        phase_str = getattr(phase, "value", phase)
        phase_str = str(phase_str).strip().lower() if phase_str is not None else "idle"

        logger.debug("[events.stream_status] collab_phase=%s thread_id=%s", phase_str, thread_id)

        # 如果phase是executing，说明还在处理中
        if phase_str in {"executing", "running"}:
            result["is_stream_active"] = True
            result["source"] = "collab_phase"
            logger.debug("[events.stream_status] active_by_collab_phase thread_id=%s result=%s", thread_id, result)
            return result
    except Exception as e:
        logger.debug("[events.stream_status] collab_phase_query_failed thread_id=%s err=%s", thread_id, e)

    # 2. 再查询 LangGraph API
    LANGGRAPH_BASE_URL = "http://127.0.0.1:8070/api/langgraph"
    logger.debug("[events.stream_status] query_langgraph thread_id=%s base_url=%s", thread_id, LANGGRAPH_BASE_URL)

    try:
        with httpx.Client(timeout=5.0) as client:
            resp = client.get(f"{LANGGRAPH_BASE_URL}/threads/{thread_id}/runs", params={"limit": 1, "status": "running"})
            logger.debug("[events.stream_status] langgraph_runs status=%s thread_id=%s", resp.status_code, thread_id)
            if resp.status_code == 200:
                runs = resp.json()
                if isinstance(runs, list) and len(runs) > 0:
                    result["is_stream_active"] = True
                    result["source"] = "langgraph_api"
                else:
                    pass
            else:
                logger.debug("[events.stream_status] langgraph_runs_error thread_id=%s body=%s", thread_id, resp.text[:200])
    except Exception as e:
        logger.debug("[events.stream_status] langgraph_query_failed thread_id=%s err=%s", thread_id, e)

    # 3. 补查 recently-completed runs（如果当前没有活跃 run）
    if not result["is_stream_active"]:
        _check_recently_completed(thread_id, result)

    # 4. 查询 DB 中的 run_completed 状态（持久化补偿，不依赖 LangGraph API）
    if not result["run_completed"]:
        try:
            from evoflow.persistence.live_run_repositories import check_run_completed

            completed = check_run_completed(thread_id)
            if completed:
                result["run_completed"] = True
                result["run_completed_run_id"] = completed.get("run_id")
                result["run_completed_status"] = completed.get("status")
                logger.debug(
                    "[events.stream_status] db_run_completed thread_id=%s run_id=%s status=%s",
                    thread_id,
                    completed.get("run_id"),
                    completed.get("status"),
                )
        except Exception as e:
            logger.debug("[events.stream_status] db_check_failed thread_id=%s err=%s", thread_id, e)

    return result


def _check_recently_completed(thread_id: str, result: dict) -> None:
    """补查最近完成的 run（60s 窗口）。

    查询 success 和 error 状态的 run，如果有在时间窗口内完成的，标记到 result 中。
    """
    import os
    from datetime import datetime, timezone

    LANGGRAPH_BASE_URL = "http://127.0.0.1:8070/api/langgraph"
    window_s = int(os.getenv("EVOFLOW_RECENTLY_COMPLETED_WINDOW_S", "60"))

    now = datetime.now(timezone.utc)

    for status in ("success", "error"):
        try:
            with httpx.Client(timeout=5.0) as client:
                resp = client.get(
                    f"{LANGGRAPH_BASE_URL}/threads/{thread_id}/runs",
                    params={"limit": 1, "status": status},
                )
                if resp.status_code != 200:
                    continue
                runs = resp.json()
                if not isinstance(runs, list) or len(runs) == 0:
                    continue

                run = runs[0]
                end_time_str = run.get("end_time") or run.get("updated_at")
                if not end_time_str:
                    continue

                # 解析时间（处理 Z 后缀）
                end_time_str = end_time_str.replace("Z", "+00:00")
                try:
                    end_time = datetime.fromisoformat(end_time_str)
                    # 确保时区感知
                    if end_time.tzinfo is None:
                        end_time = end_time.replace(tzinfo=timezone.utc)
                except (ValueError, TypeError):
                    continue

                elapsed = (now - end_time).total_seconds()
                if 0 <= elapsed <= window_s:
                    run_id = run.get("run_id") or run.get("id")
                    result["recently_completed"] = True
                    result["recently_completed_run_id"] = str(run_id) if run_id else None
                    result["recently_completed_status"] = status
                    logger.debug(
                        "[events.stream_status] recently_completed thread_id=%s run_id=%s status=%s elapsed=%.1fs",
                        thread_id,
                        run_id,
                        status,
                        elapsed,
                    )
                    return  # 找到最近的即可
        except Exception as e:
            logger.debug(
                "[events.stream_status] recently_completed_query_failed thread_id=%s status=%s err=%s",
                thread_id,
                status,
                e,
            )


# ============================================================================
# 诊断 API - 用于排查任务流数据问题
# ============================================================================


@router.get(
    "/tasks/{task_id}/stream-diagnostics",
    summary="Get stream diagnostics for debugging",
    description="返回任务流数据的诊断信息，包括文件存储和内存广播状态",
)
async def get_stream_diagnostics(request: Request, task_id: str) -> dict:
    """获取任务流数据的诊断信息。

    包括：
    - 输出文件是否存在及条目数
    - 当前内存中的观察者数量
    - 最近的历史记录（用于验证回放功能）
    """
    require_task_visible(request, task_id)
    from .streaming import get_task_output_file_path, read_task_output

    result = {
        "task_id": task_id,
        "timestamp": utc_now_iso_z(),
        "file_storage": None,
        "memory_broadcast": None,
        "recent_history": [],
    }

    # 1. 检查文件存储
    file_path = get_task_output_file_path(task_id)
    if file_path:
        try:
            with open(file_path, encoding="utf-8") as f:
                lines = f.readlines()
                result["file_storage"] = {
                    "exists": True,
                    "path": str(file_path),
                    "total_entries": len(lines),
                    "size_bytes": file_path.stat().st_size,
                }
                # 统计 lead_agent_chunk 数量
                lead_agent_chunks = sum(1 for line in lines if '"type": "lead_agent_chunk"' in line)
                result["file_storage"]["lead_agent_chunks"] = lead_agent_chunks
        except Exception as e:
            result["file_storage"] = {"exists": True, "error": str(e)}
    else:
        result["file_storage"] = {"exists": False}

    # 2. 检查内存广播状态
    async with _thread_observer_lock:
        queues = _thread_observers.get(task_id, [])
        result["memory_broadcast"] = {
            "observer_count": len(queues),
            "task_has_observers": task_id in _thread_observers,
            "total_observed_tasks": len(_thread_observers),
        }

    # 3. 读取最近的历史记录（最多10条）
    try:
        history = read_task_output(task_id, offset=0, limit=10)
        result["recent_history"] = [
            {
                "type": entry.get("type"),
                "timestamp": entry.get("_timestamp"),
                "has_chunk": "chunk" in entry,
                "preview": str(entry.get("chunk", {}))[:100] if "chunk" in entry else None,
            }
            for entry in history[-10:]  # 只显示最后10条
        ]
        result["history_total_available"] = len(history)
    except Exception as e:
        result["history_error"] = str(e)

    return result
