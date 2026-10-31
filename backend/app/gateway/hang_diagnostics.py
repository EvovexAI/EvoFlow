from __future__ import annotations

import asyncio
import faulthandler
import json
import logging
import os
import sys
import threading
import time
import traceback
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from app.gateway.logging_setup import resolve_gateway_logs_dir

logger = logging.getLogger(__name__)

_last_loop_beat = time.monotonic()
_watchdog_stop = threading.Event()
_watchdog_thread: threading.Thread | None = None
_monitor_task: asyncio.Task | None = None
_last_dump_at = 0.0
_dump_lock = threading.Lock()
_listen_socket_broken = False
_listen_socket_broken_at: str | None = None

# Registry of in-flight HTTP requests inside the Gateway ASGI app.
# Populated by GatewayRequestLoggingMiddleware (see app.gateway.middleware).
# Used by hang_diagnostics to surface: "during this hang, which REST endpoints
# were stuck waiting in the event-loop?" — exactly the symptom the user reported
# ("流式对话期间其他接口全卡死").
_inflight_requests_lock = threading.Lock()
_inflight_requests: dict[int, dict[str, Any]] = {}

_SLOW_REQUEST_LOG_THRESHOLD_S = 3.0
_SLOW_REQUEST_DUMP_THRESHOLD_S = 5.0
# Dedicated daily file — grep ``[SLOW]`` in ``logs/gateway-slow-YYYY-MM-DD.log``.
# Populated independently of hang JSON dumps so "前端访问后端慢" is one path to check.
_last_slow_request_log: dict[str, float] = {}  # throttled warn lines
_slow_file_lock = threading.Lock()


def _flag_enabled(name: str, default: str = "1") -> bool:
    value = (os.getenv(name, default) or "").strip().lower()
    return value not in {"0", "false", "no", "off", "disabled"}


def _float_env(name: str, default: float, *, minimum: float) -> float:
    raw = (os.getenv(name) or "").strip()
    if not raw:
        return default
    try:
        return max(minimum, float(raw))
    except ValueError:
        return default


def diagnostics_enabled() -> bool:
    return _flag_enabled("EVOFLOW_GATEWAY_HANG_DIAGNOSTICS", "1")


def register_inflight_request(
    *,
    scope_id: int,
    method: str,
    path: str,
    query: str | None,
    lane: str | None = None,
) -> None:
    """Middleware call when it accepts a new HTTP request; tracked for hang dumps."""
    with _inflight_requests_lock:
        entry: dict[str, Any] = {
            "method": method,
            "path": path,
            "query": query,
            "started_mono": time.monotonic(),
            "started_wall": datetime.now(UTC).isoformat(),
        }
        if lane:
            entry["lane"] = str(lane)
        _inflight_requests[scope_id] = entry


def update_inflight_request(scope_id: int, **fields: Any) -> None:
    with _inflight_requests_lock:
        entry = _inflight_requests.get(scope_id)
        if entry is not None:
            entry.update(fields)


def unregister_inflight_request(scope_id: int) -> dict[str, Any] | None:
    with _inflight_requests_lock:
        return _inflight_requests.pop(scope_id, None)


def snapshot_inflight_requests() -> dict[str, Any]:
    """Snapshot of all in-flight requests, oldest first; includes wait time."""
    now = time.monotonic()
    with _inflight_requests_lock:
        items = []
        for scope_id, entry in _inflight_requests.items():
            wait = now - entry.get("started_mono", now)
            items.append({"scope_id": scope_id, **entry, "wait_seconds": round(wait, 3)})
    items.sort(key=lambda d: d["started_mono"])
    by_lane: dict[str, int] = {}
    for d in items:
        key = str(d.get("lane") or "unknown")
        by_lane[key] = by_lane.get(key, 0) + 1
    return {
        "count": len(items),
        "by_lane": by_lane,
        "long_waiting": [d for d in items if d["wait_seconds"] >= _SLOW_REQUEST_LOG_THRESHOLD_S],
        "all": items,
    }


def _slow_request_summary_lines() -> list[str]:
    now = time.monotonic()
    snap = snapshot_inflight_requests()
    long_waiting = snap["long_waiting"]
    if not long_waiting:
        return []
    lines = [f"[slow-requests] currently waiting >={_SLOW_REQUEST_LOG_THRESHOLD_S:.1f}s count={len(long_waiting)}"]
    for d in long_waiting[:8]:
        lane = d.get("lane") or "?"
        lines.append(
            f"  - [{lane}] {d['method']:6s} {d['path']} wait={d['wait_seconds']:.2f}s started={d['started_wall']}"
        )
    if len(long_waiting) > 8:
        lines.append(f"  ... and {len(long_waiting) - 8} more")
    return lines


def slow_log_threshold_s() -> float:
    """Seconds above which completed HTTP requests are appended to gateway-slow-*.log."""
    return _float_env("EVOFLOW_GATEWAY_SLOW_LOG_SECONDS", 1.0, minimum=0.2)


def _slow_log_path() -> Path:
    """``~/.evoflow-dev/logs/gateway-slow-YYYY-MM-DD.log`` (or EVOFLOW_LOGS_DIR)."""
    day = datetime.now().strftime("%Y-%m-%d")
    return resolve_gateway_logs_dir() / f"gateway-slow-{day}.log"


def append_gateway_slow_log(
    *,
    kind: str,
    method: str = "",
    path: str = "",
    query: str | None = None,
    duration_s: float | None = None,
    wait_s: float | None = None,
    status_code: int | None = None,
    extra: str = "",
) -> None:
    """Append one line to the dedicated slow-API log (best-effort, never raises).

    ``kind`` examples: ``http_done``, ``inflight``, ``event_loop_lag``, ``stream_block_suspect``.
    """
    try:
        lag = get_event_loop_lag_seconds()
        snap = snapshot_inflight_requests()
        parts = [
            datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            f"[SLOW] kind={kind}",
        ]
        if method:
            parts.append(f"method={method}")
        if path:
            parts.append(f"path={path}")
        if query:
            q = str(query)
            if len(q) > 240:
                q = q[:240] + "…"
            parts.append(f"query={q}")
        if duration_s is not None:
            parts.append(f"duration_ms={round(duration_s * 1000)}")
        if wait_s is not None:
            parts.append(f"wait_ms={round(wait_s * 1000)}")
        if status_code is not None:
            parts.append(f"status={status_code}")
        parts.append(f"lag_s={lag:.3f}")
        parts.append(f"inflight={snap.get('count') or 0}")
        long_waiting = snap.get("long_waiting") or []
        if long_waiting:
            top = long_waiting[0]
            parts.append(
                f"oldest={top.get('method')} {top.get('path')}@{top.get('wait_seconds')}s"
            )
        if extra:
            parts.append(extra)
        line = " ".join(parts) + "\n"
        path_out = _slow_log_path()
        with _slow_file_lock:
            path_out.parent.mkdir(parents=True, exist_ok=True)
            with path_out.open("a", encoding="utf-8") as f:
                f.write(line)
    except Exception:
        logger.debug("append_gateway_slow_log failed", exc_info=True)


def get_event_loop_lag_seconds() -> float:
    """Seconds since the gateway heartbeat task last ran (0 when healthy)."""
    return max(0.0, time.monotonic() - _last_loop_beat)


def is_listen_socket_broken() -> bool:
    """True after Windows accept/WinError 64 or equivalent listen-socket failure."""
    return _listen_socket_broken


def listen_socket_broken_detail() -> str | None:
    return _listen_socket_broken_at


def is_event_loop_overloaded(*, threshold_seconds: float | None = None) -> bool:
    limit = threshold_seconds
    if limit is None:
        limit = _float_env("EVOFLOW_GATEWAY_OVERLOAD_LAG_SECONDS", 8.0, minimum=1.0)
    return get_event_loop_lag_seconds() >= limit


def should_shed_best_effort(*, min_slow: int | None = None, min_wait_s: float | None = None) -> bool:
    """True when best-effort REST (git_status, tree probes) should fail soft.

    Used so a slow workspace git probe cannot queue behind an overloaded loop
    and make every other page look "unreachable". Triggers on event-loop lag
    *or* several non-stream requests already waiting past the slow threshold.
    """
    if is_event_loop_overloaded():
        return True
    need = int(min_slow if min_slow is not None else _float_env("EVOFLOW_GATEWAY_SHED_MIN_SLOW", 2.0, minimum=1.0))
    wait_need = float(
        min_wait_s
        if min_wait_s is not None
        else _float_env("EVOFLOW_GATEWAY_SHED_MIN_WAIT_SECONDS", 5.0, minimum=1.0)
    )
    snap = snapshot_inflight_requests()
    slow = [d for d in snap.get("long_waiting") or [] if float(d.get("wait_seconds") or 0) >= wait_need]
    return len(slow) >= need


def _mark_listen_socket_broken(reason: str) -> None:
    global _listen_socket_broken, _listen_socket_broken_at
    if _listen_socket_broken:
        return
    _listen_socket_broken = True
    _listen_socket_broken_at = reason
    dump_gateway_diagnostics("listen_socket_broken", lag_seconds=round(get_event_loop_lag_seconds(), 3))
    logger.critical(
        "Gateway listen socket is broken (%s). HTTP/API will stop accepting new connections; restart Gateway (close the Gateway window or run restart-dev-stack). Set EVOFLOW_GATEWAY_EXIT_ON_SOCKET_FAILURE=1 to auto-exit the process.",
        reason,
    )
    if _flag_enabled("EVOFLOW_GATEWAY_EXIT_ON_SOCKET_FAILURE", "0"):
        try:
            loop = asyncio.get_running_loop()
            loop.call_later(2.0, lambda: os._exit(1))
        except RuntimeError:
            os._exit(1)


def _is_fatal_listen_socket_context(context: dict[str, Any]) -> bool:
    message = str(context.get("message") or "")
    if "accept failed on a socket" in message.lower():
        return True
    exc = context.get("exception")
    if isinstance(exc, OSError):
        winerror = getattr(exc, "winerror", None)
        if winerror == 64:
            return True
        if "network name is no longer available" in str(exc).lower():
            return True
    return False


def install_gateway_listen_socket_failure_handler(
    loop: asyncio.AbstractEventLoop | None = None,
) -> bool:
    """Detect broken accept sockets (WinError 64) and mark Gateway unhealthy."""
    try:
        target = loop if loop is not None else asyncio.get_running_loop()
    except RuntimeError:
        return False
    previous = target.get_exception_handler()

    def _handler(handler_loop: asyncio.AbstractEventLoop, context: dict[str, Any]) -> None:
        if _is_fatal_listen_socket_context(context):
            exc = context.get("exception")
            detail = str(exc or context.get("message") or "accept failed")
            _mark_listen_socket_broken(detail)
            return
        if previous is not None:
            previous(handler_loop, context)
        else:
            handler_loop.default_exception_handler(context)

    target.set_exception_handler(_handler)
    return True


def _diagnostics_dir() -> Path:
    path = resolve_gateway_logs_dir() / "debug" / "hang-diagnostics"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _timestamp() -> str:
    return datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")


def _active_stream_snapshot() -> dict[str, Any]:
    try:
        from app.gateway.routers.langgraph_proxy import list_active_stream_proxies

        streams = list_active_stream_proxies()
        return {"count": len(streams), "streams": streams}
    except Exception as exc:
        return {"error": f"{type(exc).__name__}: {exc}"}


def _sqlite_snapshot() -> dict[str, Any]:
    """Path-only snapshot — never call get_app_config/get_db here.

    Hang dumps run on the event loop (or contend for the DB lock). Touching
    schema/config from diagnostics previously amplified stalls into multi-minute
    CLOSE_WAIT outages.
    """
    out: dict[str, Any] = {}
    try:
        from evoflow.persistence.db import resolve_evolflow_db_path

        out["evoflow_db_path"] = str(resolve_evolflow_db_path())
    except Exception as exc:
        out["evoflow_db_error"] = f"{type(exc).__name__}: {exc}"
    try:
        from evoflow.config.data_paths import resolve_observability_db_config_path

        # Avoid get_app_config (may open SQLite / run schema under the hang lock).
        out["observability_db_path"] = str(resolve_observability_db_config_path(None))
    except Exception as exc:
        out["observability_db_error"] = f"{type(exc).__name__}: {exc}"
    return out


def _thread_stacks() -> dict[str, Any]:
    frames = sys._current_frames()
    threads = {thread.ident: thread for thread in threading.enumerate()}
    result: dict[str, Any] = {}
    for ident, frame in frames.items():
        thread = threads.get(ident)
        name = thread.name if thread else f"thread-{ident}"
        result[name] = {
            "ident": ident,
            "daemon": bool(thread.daemon) if thread else None,
            "stack": "".join(traceback.format_stack(frame)),
        }
    return result


def _asyncio_tasks_snapshot() -> list[dict[str, Any]]:
    try:
        loop = asyncio.get_running_loop()
        tasks = list(asyncio.all_tasks(loop))
    except RuntimeError:
        return []
    items: list[dict[str, Any]] = []
    for task in tasks:
        coro = task.get_coro()
        stack = []
        for frame in task.get_stack(limit=12):
            stack.append("".join(traceback.format_stack(frame)))
        items.append(
            {
                "name": task.get_name(),
                "done": task.done(),
                "cancelled": task.cancelled(),
                "coro": getattr(coro, "__qualname__", repr(coro)),
                "stack": stack,
            }
        )
    return items


def dump_gateway_diagnostics(reason: str, *, lag_seconds: float | None = None) -> Path | None:
    global _last_dump_at
    if not diagnostics_enabled():
        return None
    now = time.monotonic()
    min_interval = _float_env("EVOFLOW_GATEWAY_HANG_DUMP_MIN_INTERVAL_SECONDS", 30.0, minimum=1.0)
    with _dump_lock:
        if now - _last_dump_at < min_interval:
            return None
        _last_dump_at = now
    payload = {
        "reason": reason,
        "lag_seconds": lag_seconds,
        "created_at": datetime.now(UTC).isoformat(),
        "pid": os.getpid(),
        "cwd": str(Path.cwd()),
        "env": {
            "EVOFLOW_GATEWAY_URL": os.getenv("EVOFLOW_GATEWAY_URL"),
            "EVOFLOW_GATEWAY_PORT": os.getenv("EVOFLOW_GATEWAY_PORT"),
            "EVOFLOW_LANGGRAPH_URL": os.getenv("EVOFLOW_LANGGRAPH_URL"),
            "EVOFLOW_LANGGRAPH_PORT": os.getenv("EVOFLOW_LANGGRAPH_PORT"),
        },
        "active_streams": _active_stream_snapshot(),
        "inflight_requests": snapshot_inflight_requests(),
        "sqlite": _sqlite_snapshot(),
        "thread_stacks": _thread_stacks(),
        "asyncio_tasks": _asyncio_tasks_snapshot(),
    }
    path = _diagnostics_dir() / f"gateway-hang-{_timestamp()}-{os.getpid()}.json"
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    try:
        with (_diagnostics_dir() / f"gateway-hang-{_timestamp()}-{os.getpid()}.txt").open("w", encoding="utf-8") as f:
            faulthandler.dump_traceback(file=f, all_threads=True)
    except Exception:
        logger.debug("faulthandler dump failed", exc_info=True)
    logger.warning("Gateway hang diagnostics dumped reason=%s lag=%s path=%s", reason, lag_seconds, path)
    try:
        _reclaim_stale_streams_after_hang(lag_seconds=lag_seconds)
    except Exception:
        logger.debug("post-hang reclaim failed", exc_info=True)
    return path


def _reclaim_stale_streams_after_hang(*, lag_seconds: float | None) -> None:
    """Free never-claimed stream slots after an event-loop stall (HOL / 准备中)."""
    try:
        from app.gateway.routers.langgraph_proxy import reclaim_stale_active_stream_proxies

        reclaim_stale_active_stream_proxies(max_age_s=90.0, require_missing_run_id=True)
        if lag_seconds is not None and float(lag_seconds) >= 12.0:
            reclaim_stale_active_stream_proxies(max_age_s=600.0, require_missing_run_id=False)
    except Exception:
        logger.debug("hang reclaim active streams failed", exc_info=True)

    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    if loop.is_closed():
        return

    async def _kick_reconcile() -> None:
        try:
            from app.gateway.run_status_reconcile import reconcile_stale_session_runs

            stats = await reconcile_stale_session_runs(wait_for_langgraph=False, max_sessions=50)
            if stats.get("cancelled") or stats.get("cleared"):
                logger.warning(
                    "hang-triggered reconcile cancelled=%s cleared=%s scanned=%s",
                    stats.get("cancelled"),
                    stats.get("cleared"),
                    stats.get("scanned"),
                )
        except Exception:
            logger.debug("hang-triggered reconcile failed", exc_info=True)

    try:
        loop.create_task(_kick_reconcile(), name="hang-reclaim-reconcile")
    except Exception:
        logger.debug("schedule hang reconcile failed", exc_info=True)


async def _loop_heartbeat_monitor() -> None:
    global _last_loop_beat
    interval = _float_env("EVOFLOW_GATEWAY_HANG_HEARTBEAT_SECONDS", 0.5, minimum=0.2)
    lag_threshold = _float_env("EVOFLOW_GATEWAY_HANG_LAG_SECONDS", 2.0, minimum=0.5)
    try:
        while True:
            started = time.monotonic()
            await asyncio.sleep(interval)
            now = time.monotonic()
            _last_loop_beat = now
            lag = now - started - interval
            if lag >= lag_threshold:
                dump_gateway_diagnostics("event_loop_lag", lag_seconds=round(lag, 3))
                # Throttled WARNING line so the user can grep gateway-*.log for
                # the exact cause without opening the JSON dump (handy when other
                # REST endpoints stay pending > 3s during a stream).
                key = "event_loop_lag"
                last = _last_slow_request_log.get(key, 0.0)
                if now - last >= 5.0:
                    _last_slow_request_log[key] = now
                    for line in _slow_request_summary_lines() or [f"[event-loop-lag] lag={lag:.3f}s"]:
                        logger.warning(line)
                    append_gateway_slow_log(
                        kind="event_loop_lag",
                        wait_s=lag,
                        extra=f"threshold_s={lag_threshold}",
                    )
    except asyncio.CancelledError:
        raise
    except Exception:
        logger.exception("Gateway hang heartbeat monitor failed")


def _watchdog_loop() -> None:
    threshold = _float_env("EVOFLOW_GATEWAY_HANG_STALL_SECONDS", 5.0, minimum=2.0)
    poll = min(1.0, max(0.5, threshold / 5.0))
    last_slow_log = 0.0
    last_dump_for_slow = 0.0
    while not _watchdog_stop.wait(poll):
        lag = time.monotonic() - _last_loop_beat
        now = time.monotonic()
        if lag >= threshold:
            dump_gateway_diagnostics("event_loop_stall", lag_seconds=round(lag, 3))
        # Slow-request detector: REST endpoints waiting > 5s in the event loop
        # while a stream is in flight is the exact symptom the user reported.
        # Throttled so we don't spam logs; one dump per minute at most.
        slow_snap = snapshot_inflight_requests()
        long_waiting = slow_snap["long_waiting"]
        if long_waiting and now - last_slow_log >= 5.0:
            last_slow_log = now
            worst = max(d["wait_seconds"] for d in long_waiting)
            if worst >= _SLOW_REQUEST_DUMP_THRESHOLD_S and now - last_dump_for_slow >= 60.0:
                last_dump_for_slow = now
                dump_gateway_diagnostics(
                    "slow_inflight_requests",
                    lag_seconds=round(worst, 3),
                )
            for line in _slow_request_summary_lines():
                logger.warning(line)
            for d in long_waiting[:6]:
                append_gateway_slow_log(
                    kind="inflight",
                    method=str(d.get("method") or ""),
                    path=str(d.get("path") or ""),
                    query=str(d.get("query") or "") or None,
                    wait_s=float(d.get("wait_seconds") or 0),
                )
            if should_shed_best_effort():
                logger.warning(
                    "[best-effort-shed] active — git_status/git_ignored_paths will fail soft "
                    "until lag/slow REST clears (avoids other pages looking unreachable)"
                )


def start_gateway_hang_diagnostics() -> Callable[[], None]:
    global _watchdog_thread, _monitor_task, _last_loop_beat
    if not diagnostics_enabled():
        logger.info("Gateway hang diagnostics disabled (EVOFLOW_GATEWAY_HANG_DIAGNOSTICS=0)")
        return lambda: None
    _last_loop_beat = time.monotonic()
    try:
        _monitor_task = asyncio.create_task(_loop_heartbeat_monitor(), name="gateway-hang-heartbeat")
    except RuntimeError:
        _monitor_task = None
    _watchdog_stop.clear()
    if _watchdog_thread is None or not _watchdog_thread.is_alive():
        _watchdog_thread = threading.Thread(target=_watchdog_loop, name="gateway-hang-watchdog", daemon=True)
        _watchdog_thread.start()
    logger.info(
        "Gateway hang diagnostics enabled heartbeat=%ss lag_threshold=%ss stall_threshold=%ss slow_request_warn=%ss slow_request_dump=%ss dir=%s",
        _float_env("EVOFLOW_GATEWAY_HANG_HEARTBEAT_SECONDS", 0.5, minimum=0.2),
        _float_env("EVOFLOW_GATEWAY_HANG_LAG_SECONDS", 2.0, minimum=0.5),
        _float_env("EVOFLOW_GATEWAY_HANG_STALL_SECONDS", 5.0, minimum=2.0),
        _SLOW_REQUEST_LOG_THRESHOLD_S,
        _SLOW_REQUEST_DUMP_THRESHOLD_S,
        _diagnostics_dir(),
    )

    def stop() -> None:
        global _monitor_task
        _watchdog_stop.set()
        task = _monitor_task
        _monitor_task = None
        if task and not task.done():
            task.cancel()

    return stop


__all__ = [
    "append_gateway_slow_log",
    "dump_gateway_diagnostics",
    "get_event_loop_lag_seconds",
    "slow_log_threshold_s",
    "install_gateway_listen_socket_failure_handler",
    "is_event_loop_overloaded",
    "is_listen_socket_broken",
    "listen_socket_broken_detail",
    "register_inflight_request",
    "should_shed_best_effort",
    "snapshot_inflight_requests",
    "start_gateway_hang_diagnostics",
    "unregister_inflight_request",
    "update_inflight_request",
]
