"""Per-run wall-clock tracing: pre-model phases, gateway stream, and end-to-end segments."""

from __future__ import annotations

import atexit
import logging
import os
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor, wait
from contextvars import ContextVar
from pathlib import Path
from typing import Any

from evoflow.timeutil import beijing_now_iso

logger = logging.getLogger(__name__)

LOG_BASENAME = "run_latency_trace.jsonl"

_SHARED_TRACE_LOCK = threading.Lock()
_SHARED_TRACE_PATH: Path | None = None


def _shared_trace_log_path() -> Path:
    global _SHARED_TRACE_PATH
    if _SHARED_TRACE_PATH is not None:
        return _SHARED_TRACE_PATH
    # Try repo root logs/ dir (works for both Gateway and LangGraph dev processes).
    for base in [Path.cwd(), Path.cwd().parent]:
        candidate = base / "logs"
        if candidate.is_dir():
            _SHARED_TRACE_PATH = candidate / "stream-trace.log"
            return _SHARED_TRACE_PATH
    # Fallback: write next to this module.
    _SHARED_TRACE_PATH = Path(__file__).resolve().parent.parent.parent.parent.parent / "logs" / "stream-trace.log"
    return _SHARED_TRACE_PATH


def _append_shared_trace_log(line: str) -> None:
    path = _shared_trace_log_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    with _SHARED_TRACE_LOCK:
        with path.open("a", encoding="utf-8") as f:
            f.write(line + "\n")

_cycle: ContextVar[dict[str, Any] | None] = ContextVar("evoflow_run_latency_cycle", default=None)
# LangGraph may run before_model / wrap_model_call in contexts where ContextVar
# does not propagate — keep a thread-keyed mirror so pre_model_breakdown is not lost.
_cycle_by_thread: dict[str, dict[str, Any]] = {}
_cycle_by_thread_lock = threading.Lock()
_model_call_seq: ContextVar[int | None] = ContextVar("evoflow_model_call_seq", default=None)
_seq_lock = threading.Lock()
_seq_by_thread_run: dict[str, tuple[str, int]] = {}


def bump_model_call_seq(thread_id: str, run_id: str | None = None) -> int:
    """Monotonic model-call index per ``(thread_id, run_id)`` for timing traces.

    Ops table「序号」uses chat transcript ``seq`` via :func:`resolve_obs_chat_message_seq`
    instead of this counter.
    """
    tid = str(thread_id or "").strip() or "unknown"
    rid = str(run_id or "").strip()
    with _seq_lock:
        prev_run, prev_seq = _seq_by_thread_run.get(tid, ("", 0))
        seq = 1 if prev_run != rid else prev_seq + 1
        _seq_by_thread_run[tid] = (rid, seq)
    _model_call_seq.set(seq)
    return seq


def current_model_call_seq() -> int | None:
    """Seq for the active model cycle (set in ``before_model``)."""
    raw = _model_call_seq.get()
    if raw is None:
        return None
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


def resolve_obs_chat_message_seq(
    *,
    thread_id: str | None = None,
    session_key: str | None = None,
) -> int | None:
    """Latest ``evoflow_chat_messages.seq`` for Ops table「序号」column.

    Same number as the chat transcript row id — not the in-run model-call counter.
    """
    sk = str(session_key or "").strip()
    tid = str(thread_id or "").strip()
    if not sk and tid:
        try:
            from evoflow.persistence.session_repositories import find_session_key_by_thread_id

            sk = str(find_session_key_by_thread_id(tid) or "").strip()
        except Exception:
            sk = ""
    if not sk:
        return None
    try:
        from evoflow.persistence.chat_message_repositories import get_session_hydration_watermark

        max_seq, _ = get_session_hydration_watermark(sk)
        n = int(max_seq or 0)
        return n if n > 0 else None
    except Exception:
        return None


def _store_cycle(cycle: dict[str, Any]) -> None:
    _cycle.set(cycle)
    tid = str(cycle.get("thread_id") or "").strip()
    if not tid:
        return
    with _cycle_by_thread_lock:
        _cycle_by_thread[tid] = cycle


def _get_cycle(*, thread_id: str | None = None) -> dict[str, Any] | None:
    cycle = _cycle.get()
    if isinstance(cycle, dict):
        return cycle
    tid = str(thread_id or "").strip()
    if not tid:
        return None
    with _cycle_by_thread_lock:
        hit = _cycle_by_thread.get(tid)
    return hit if isinstance(hit, dict) else None


def _clear_cycle_store(thread_id: str | None = None) -> None:
    cycle = _cycle.get()
    tid = str(thread_id or "").strip()
    if not tid and isinstance(cycle, dict):
        tid = str(cycle.get("thread_id") or "").strip()
    _cycle.set(None)
    if tid:
        with _cycle_by_thread_lock:
            _cycle_by_thread.pop(tid, None)


# Per-thread live progress tracking (for console visibility).
_live_progress: dict[str, str] = {}
_live_progress_ts: dict[str, int] = {}
_live_progress_lock = threading.Lock()


def _activity_kind_for_progress(progress: str) -> str:
    p = str(progress or "").strip()
    if not p:
        return "system"
    if "工具" in p or p.startswith("执行 "):
        return "tools"
    # 「准备中」≠ 已打模型；勿映射成 model，否则 UI 会误显示成生成态。
    if "准备" in p:
        return "pre_model"
    if "生成" in p or "模型" in p or "大模型" in p:
        return "model"
    if "思考" in p or "推理" in p:
        return "thinking"
    if p.startswith("正在执行 "):
        return "middleware"
    return "system"


def set_live_progress(thread_id: str, progress: str) -> None:
    """Set human-readable progress string for a thread (LangGraph internal phase)."""
    tid = str(thread_id or "").strip()
    if not tid:
        return
    p = str(progress).strip()
    with _live_progress_lock:
        _live_progress[tid] = p
        _live_progress_ts[tid] = int(time.time() * 1000)
    try:
        from evoflow.observability.agent_activity_stream import emit_agent_activity

        kind = _activity_kind_for_progress(p)
        emit_agent_activity(tid, kind=kind, detail=p, force=kind in {"model", "tools", "middleware"})
    except Exception:
        logger.debug("set_live_progress activity emit skipped thread=%s", tid, exc_info=True)


def get_live_progress(thread_id: str) -> str | None:
    """Get current progress string for a thread (called by Gateway heartbeat)."""
    tid = str(thread_id or "").strip()
    if not tid:
        return None
    with _live_progress_lock:
        return _live_progress.get(tid)


def get_live_progress_ts(thread_id: str) -> int | None:
    """Get the wall-clock ms when the current progress string was set."""
    tid = str(thread_id or "").strip()
    if not tid:
        return None
    with _live_progress_lock:
        return _live_progress_ts.get(tid)


def clear_live_progress(thread_id: str) -> None:
    """Remove progress entry for a thread (cleaned up after stream ends)."""
    tid = str(thread_id or "").strip()
    if not tid:
        return
    with _live_progress_lock:
        _live_progress.pop(tid, None)
        _live_progress_ts.pop(tid, None)
    try:
        from evoflow.observability.agent_activity_stream import clear_agent_activity

        clear_agent_activity(tid)
    except Exception:
        pass

_executor: ThreadPoolExecutor | None = None
_executor_lock = threading.Lock()
_pending_lock = threading.Lock()
_pending_futures: list[Future[None]] = []
_MAX_TRACKED_PENDING = 512


def _sync_writes_enabled() -> bool:
    """Force synchronous persistence (tests / debugging)."""
    v = (os.environ.get("EVOFLOW_RUN_LATENCY_SYNC") or "").strip().lower()
    return v in ("1", "true", "yes", "on")


def _get_executor() -> ThreadPoolExecutor:
    global _executor
    with _executor_lock:
        if _executor is None:
            _executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="run-latency-")
        return _executor


def _shutdown_executor() -> None:
    global _executor
    with _executor_lock:
        if _executor is not None:
            try:
                flush_run_latency_trace_pending(timeout=1.5)
            except Exception:
                pass
            _executor.shutdown(wait=False, cancel_futures=False)
            _executor = None


atexit.register(_shutdown_executor)


def flush_run_latency_trace_pending(*, timeout: float = 2.0) -> None:
    """Wait for background writes (tests or graceful shutdown)."""
    with _pending_lock:
        futures = [f for f in _pending_futures if not f.done()]
    if not futures:
        return
    done, not_done = wait(futures, timeout=timeout)
    for fut in done:
        try:
            fut.result()
        except Exception:
            pass
    if not_done:
        logger.debug("run_latency_trace: %s pending writes after %.1fs", len(not_done), timeout)


def _now_wall_ms() -> int:
    return int(time.time() * 1000)


def _now_mono() -> float:
    return time.perf_counter()


_EVENT_STEP_ORDER: dict[str, int | float] = {
    "gateway_stream_post": 1,
    "gateway_pre_dispatch": 1.5,
    "gateway_upstream_ready": 2,
    "gateway_upstream_processing": 2.5,
    "gateway_waiting_heartbeat": 2.5,
    "run_setup_phase": 2,
    "run_cycle_start": 3,
    "pre_model_breakdown": 3.5,
    "gateway_first_token": 4,
    "page_first_token": 5,
    "gateway_stream_end": 6,
    "page_stream_end": 6,
}

_ZH_EVENT_LABELS: dict[str, str] = {
    "gateway_stream_post": "收到用户流式请求",
    "gateway_pre_dispatch": "分派到 LangGraph",
    "gateway_upstream_ready": "LangGraph 已响应",
    "gateway_upstream_processing": "等待模型调度",
    "gateway_waiting_heartbeat": "调度中",
    "run_setup_phase": "Agent 初始化",
    "run_cycle_start": "开始组装大模型请求",
    "pre_model_breakdown": "即将请求大模型",
    "gateway_first_token": "Gateway 开始流式返回",
    "page_first_token": "前端收到首个流式内容",
    "gateway_stream_end": "Gateway 流式结束",
    "page_stream_end": "前端流式结束",
}


def _zh_run_latency_message(row: dict[str, Any]) -> tuple[str, tuple[Any, ...]] | None:
    event = str(row.get("event") or "")
    thread_id = str(row.get("thread_id") or "-")
    trace_id = str(row.get("trace_id") or "-")
    user_input_ts_ms = row.get("user_input_ts_ms")
    step = _EVENT_STEP_ORDER.get(event)
    step_label = f"Step {step}" if step else ""
    zh_label = _ZH_EVENT_LABELS.get(event)
    elapsed_from_user = _delta_seconds(row.get("ts_ms"), user_input_ts_ms)

    if event == "gateway_stream_post":
        return (
            "【流式链路】%s %s thread=%s trace=%s 耗时=%ss",
            (step_label, zh_label or "收到用户流式请求", thread_id, trace_id, _ms_to_s(row.get("gateway_stream_post_ms"), user_input_ts_ms)),
        )
    if event == "gateway_pre_dispatch":
        return (
            "【流式链路】%s %s thread=%s trace=%s 耗时=%ss",
            (step_label, zh_label or "分派到 LangGraph", thread_id, trace_id, _ms_to_s(row.get("gateway_pre_dispatch_ms"), user_input_ts_ms)),
        )
    if event == "gateway_upstream_ready":
        return (
            "【流式链路】%s %s thread=%s trace=%s 状态=%s 尝试=%s 耗时=%ss",
            (step_label, zh_label or "LangGraph 已响应", thread_id, trace_id, row.get("upstream_status") or "-", row.get("attempt") or "-", _ms_to_s(row.get("gateway_upstream_ready_ms"), user_input_ts_ms)),
        )
    if event == "run_cycle_start":
        return (
            "【流式链路】%s %s thread=%s trace=%s 消息数=%s 第%s次模型调用 累计=%ss",
            (step_label, _ZH_EVENT_LABELS.get(event, "开始组装大模型请求"), thread_id, trace_id, row.get("message_count") or "-", row.get("model_call_seq") or "-", elapsed_from_user),
        )
    if event == "pre_model_breakdown":
        phases = row.get("phases_ms") if isinstance(row.get("phases_ms"), dict) else {}
        top = sorted(phases.items(), key=lambda item: float(item[1] or 0), reverse=True)[:4]
        summary = ", ".join(f"{k}={_ms_to_s(v, None)}" for k, v in top) or "-"
        pre_model_total = row.get("pre_model_total_ms")
        pre_model_total_s = _ms_to_s(pre_model_total, None) if pre_model_total is not None else elapsed_from_user
        return (
            "【流式链路】%s %s thread=%s trace=%s 用户请求到模型调用=%ss 中间件链=%ss 细分=%s",
            (step_label, _ZH_EVENT_LABELS.get(event, "即将请求大模型"), thread_id, trace_id, pre_model_total_s, _ms_to_s(row.get("after_before_model_ms"), None), summary),
        )
    if event == "gateway_first_token":
        return (
            "【流式链路】%s %s thread=%s trace=%s 耗时=%ss 累计=%ss",
            (step_label, zh_label or "Gateway 开始流式返回", thread_id, trace_id, _ms_to_s(row.get("gateway_first_token_ts_ms"), user_input_ts_ms), elapsed_from_user),
        )
    if event == "gateway_upstream_processing":
        return (
            "【流式链路】%s %s thread=%s trace=%s 等待调度=%ss",
            (step_label, zh_label or "等待模型调度", thread_id, trace_id, _ms_to_s(row.get("gateway_upstream_processing_ms"), user_input_ts_ms)),
        )
    if event == "page_first_token":
        return (
            "【流式链路】%s %s thread=%s trace=%s 用户到页面=%ss Gateway到页面=%ss 累计=%ss",
            (step_label, zh_label or "前端收到首个流式内容", thread_id, trace_id, row.get("latency_input_to_page_ms"), row.get("latency_gateway_to_page_ms"), elapsed_from_user),
        )
    if event == "gateway_stream_end":
        return (
            "【流式链路】%s %s thread=%s trace=%s 总耗时=%ss 累计=%ss",
            (step_label, zh_label or "Gateway 流式结束", thread_id, trace_id, _ms_to_s(row.get("gateway_stream_end_ms"), user_input_ts_ms), elapsed_from_user),
        )
    if event == "page_stream_end":
        return (
            "【流式链路】%s %s thread=%s trace=%s 页面总耗时=%ss 累计=%ss",
            (step_label, zh_label or "前端流式结束", thread_id, trace_id, row.get("page_duration_ms"), elapsed_from_user),
        )
    return None


def _ms_to_s(raw_ms: Any, user_input_ts_ms: Any | None = None) -> str:
    """Convert ms delta to seconds string.

    If ``user_input_ts_ms`` is None the value is returned as a raw duration.
    If the resulting ms value is absurd (>1e10) treat it as a missing baseline.
    """
    try:
        if raw_ms is None:
            return "-"
        if user_input_ts_ms is not None:
            ms = float(raw_ms) - float(user_input_ts_ms)
        else:
            ms = float(raw_ms)
        if ms > 1e10:
            return "-"
        return f"{ms / 1000.0:.3f}秒"
    except Exception:
        return "-"


def _delta_seconds(now_ms: Any, start_ms: Any) -> str:
    try:
        if now_ms is None or start_ms is None:
            return "-"
        return f"{(float(now_ms) - float(start_ms)) / 1000.0:.3f}秒"
    except Exception:
        return "-"


def _delta(end_ms: Any, start_ms: Any) -> Any:
    try:
        if end_ms is None or start_ms is None:
            return "-"
        return int(end_ms) - int(start_ms)
    except Exception:
        return "-"


def _persist_run_latency_row(row: dict[str, Any]) -> None:
    """SQLite observability + optional console log line (runs off the hot path)."""
    tid = row.get("thread_id")
    try:
        from evoflow.observability.recorder import get_observability_recorder

        get_observability_recorder().record_trace_event(
            thread_id=tid,
            run_id=str(row.get("run_id") or "").strip() or None,
            lane="run_latency",
            occurred_at=str(row["ts"]),
            event=str(row["event"]),
            payload=row,
        )
    except Exception:
        pass
    try:
        zh = _zh_run_latency_message(row)
        verbose = str(os.getenv("EVOFLOW_RUN_LATENCY_VERBOSE", "") or "").strip().lower() in {"1", "true", "yes", "on"}
        raw_bj = beijing_now_iso()
        bj = raw_bj.replace("T", " ").split("+")[0].split(".")[0] if "T" in raw_bj else raw_bj[:19]
        if zh:
            message, args = zh
            formatted = f"{bj} {message}" % args
            logger.info(f"{bj} {message}", *args)
        elif verbose:
            formatted = f"{bj} run_latency event={row['event']} thread_id={tid or '-'}"
            logger.info(
                f"{bj} run_latency event=%s thread_id=%s trace_id=%s keys=%s",
                row["event"],
                tid or "-",
                row.get("trace_id") or "-",
                sorted(k for k in row if k not in {"ts", "ts_ms", "event", "thread_id", "trace_id"}),
            )
        else:
            formatted = f"{bj} run_latency event={row['event']} thread_id={tid or '-'}"
            logger.debug(
                f"{bj} run_latency event=%s thread_id=%s trace_id=%s keys=%s",
                row["event"],
                tid or "-",
                row.get("trace_id") or "-",
                sorted(k for k in row if k not in {"ts", "ts_ms", "event", "thread_id", "trace_id"}),
            )
        try:
            _append_shared_trace_log(formatted)
        except Exception:
            pass
    except Exception:
        pass


def _enqueue_persist(row: dict[str, Any]) -> None:
    if _sync_writes_enabled():
        _persist_run_latency_row(row)
        return
    fut = _get_executor().submit(_persist_run_latency_row, row)
    with _pending_lock:
        _pending_futures.append(fut)
        if len(_pending_futures) > _MAX_TRACKED_PENDING:
            _pending_futures[:] = [f for f in _pending_futures if not f.done()][-_MAX_TRACKED_PENDING:]


def write_run_latency_event(
    thread_id: str | None,
    event: str,
    payload: dict[str, Any] | None = None,
    *,
    trace_id: str | None = None,
) -> None:
    """Queue one JSONL row; returns immediately without blocking on disk/SQLite."""
    tid = str(thread_id or "").strip() or None
    row: dict[str, Any] = {
        "ts": beijing_now_iso(),
        "ts_ms": _now_wall_ms(),
        "event": str(event or "").strip(),
        "thread_id": tid,
    }
    if trace_id:
        row["trace_id"] = str(trace_id).strip()
    if payload:
        row.update(payload)
    try:
        _enqueue_persist(row)
    except Exception:
        logger.debug("run_latency_trace enqueue failed", exc_info=True)


def begin_model_cycle(
    *,
    thread_id: str,
    trace_id: str | None = None,
    user_input_ts_ms: int | None = None,
    model_call_seq: int | None = None,
    message_count: int | None = None,
) -> None:
    """Mark the start of a lead-agent model cycle (``before_model``)."""
    now_wall = _now_wall_ms()
    cycle = {
        "thread_id": thread_id,
        "trace_id": trace_id or "",
        "user_input_ts_ms": user_input_ts_ms,
        "model_call_seq": model_call_seq,
        "cycle_start_mono": _now_mono(),
        "cycle_start_wall_ms": now_wall,
        "phases_ms": {},
        "wrap_logged": False,
    }
    _store_cycle(cycle)
    set_live_progress(thread_id, "准备中…")

    # Wall-clock total from user request to before_model
    total_from_user_ms = max(0, now_wall - float(user_input_ts_ms)) if user_input_ts_ms else None
    total_from_user_s = f"{total_from_user_ms / 1000.0:.3f}秒" if total_from_user_ms is not None else "-"

    print(f"[AGENT-TIMING] → begin_model_cycle seq={model_call_seq} msg_count={message_count} 请求到模型装配={total_from_user_s}", flush=True)

    write_run_latency_event(
        thread_id,
        "run_cycle_start",
        {
            "user_input_ts_ms": user_input_ts_ms,
            "model_call_seq": model_call_seq,
            "message_count": message_count,
            "cycle_start_wall_ms": cycle["cycle_start_wall_ms"],
        },
        trace_id=trace_id,
    )


def record_run_setup_phase(
    thread_id: str | None,
    phase: str,
    duration_ms: float,
    *,
    trace_id: str | None = None,
    **extra: Any,
) -> None:
    """Per-run setup in ``make_lead_agent`` (before ``before_model`` cycle exists)."""
    tid = str(thread_id or "").strip() or None
    if not tid:
        return
    name = str(phase or "").strip()
    if not name:
        return
    set_live_progress(tid, f"正在执行 {name}")
    write_run_latency_event(
        tid,
        "run_setup_phase",
        {"phase": name, "duration_ms": round(max(0.0, float(duration_ms)), 2), **extra},
        trace_id=trace_id,
    )


def record_phase(phase: str, duration_ms: float, **extra: Any) -> None:
    """Record a named pre-model sub-phase (e.g. apply_prompt_template)."""
    cycle = _get_cycle()
    if not cycle:
        # Fallback: try thread id from configurable when ContextVar was lost mid-run.
        tid, _, _ = read_configurable_trace_fields()
        cycle = _get_cycle(thread_id=tid) if tid else None
    if not cycle:
        return
    name = str(phase or "").strip()
    if not name:
        return
    ms = round(max(0.0, float(duration_ms)), 2)
    phases: dict[str, float] = cycle.setdefault("phases_ms", {})
    phases[name] = phases.get(name, 0.0) + ms
    set_live_progress(str(cycle.get("thread_id") or ""), f"正在执行 {name}")
    write_run_latency_event(
        str(cycle.get("thread_id") or ""),
        "pre_model_phase",
        {"phase": name, "duration_ms": ms, **extra},
        trace_id=str(cycle.get("trace_id") or "") or None,
    )


def mark_wrap_model_enter(*, model_call_seq: int | None = None) -> None:
    """Log aggregated pre-model breakdown immediately before the vendor HTTP call."""
    tid_hint, _, _ = read_configurable_trace_fields()
    cycle = _get_cycle(thread_id=tid_hint)
    if not cycle or cycle.get("wrap_logged"):
        return
    cycle["wrap_logged"] = True
    set_live_progress(str(cycle.get("thread_id") or ""), "思考中…")
    after_before_model_ms = round(max(0.0, (_now_mono() - float(cycle["cycle_start_mono"])) * 1000.0), 2)
    phases = dict(cycle.get("phases_ms") or {})
    phases.setdefault("after_before_model_hooks_ms", after_before_model_ms)
    traced_sum = round(sum(v for k, v in phases.items() if k != "after_before_model_hooks_ms"), 2)
    other_ms = round(max(0.0, after_before_model_ms - traced_sum), 2)
    if other_ms > 0.05:
        phases["middleware_wrap_other_ms"] = other_ms
    cycle["phases_ms"] = phases
    top_phases = sorted(phases.items(), key=lambda x: float(x[1] or 0), reverse=True)[:3]
    phases_summary = ", ".join(f"{k}={v:.0f}ms" for k, v in top_phases) if top_phases else "-"

    # Total wall-clock time from user request to cloud API call
    user_ts = cycle.get("user_input_ts_ms")
    pre_model_total_ms = max(
        0.0, _now_wall_ms() - float(user_ts)
    ) if user_ts else None
    pre_model_total_str = f" pre_model_total={pre_model_total_ms:.0f}ms" if pre_model_total_ms is not None else ""

    print(
        f"[AGENT-TIMING] → cloud_api_call seq={model_call_seq or cycle.get('model_call_seq')}"
        f"{pre_model_total_str}"
        f" after_before_model={after_before_model_ms:.0f}ms"
        f" phases=[{phases_summary}]",
        flush=True,
    )
    write_run_latency_event(
        str(cycle.get("thread_id") or ""),
        "pre_model_breakdown",
        {
            "model_call_seq": model_call_seq or cycle.get("model_call_seq"),
            "pre_model_total_ms": pre_model_total_ms,
            "after_before_model_ms": after_before_model_ms,
            "phases_ms": phases,
            "wrap_enter_wall_ms": _now_wall_ms(),
        },
        trace_id=str(cycle.get("trace_id") or "") or None,
    )


def clear_model_cycle() -> None:
    cycle = _get_cycle()
    if cycle:
        clear_live_progress(str(cycle.get("thread_id") or ""))
        _clear_cycle_store(str(cycle.get("thread_id") or ""))
    else:
        tid, _, _ = read_configurable_trace_fields()
        if tid:
            clear_live_progress(tid)
            _clear_cycle_store(tid)
        else:
            _clear_cycle_store()


def current_model_cycle_thread_id() -> str:
    """Thread id for the active ``before_model`` / ``wrap_model_call`` cycle, if any."""
    cycle = _get_cycle()
    if not isinstance(cycle, dict):
        tid, _, _ = read_configurable_trace_fields()
        cycle = _get_cycle(thread_id=tid) if tid else None
    if not isinstance(cycle, dict):
        return ""
    return str(cycle.get("thread_id") or "").strip()


def read_configurable_trace_fields() -> tuple[str, str | None, int | None]:
    """``(thread_id, trace_id, user_input_ts_ms)`` from LangGraph configurable + context."""
    thread_id = ""
    trace_id = ""
    user_input_ts_ms: int | None = None
    try:
        from langgraph.config import get_config

        conf = get_config()
        cfg = conf.get("configurable") if isinstance(conf, dict) else {}
        if isinstance(cfg, dict):
            thread_id = str(cfg.get("thread_id") or "").strip()
            trace_id = str(cfg.get("evf_trace_id") or "").strip()
            raw = cfg.get("evf_user_input_ts_ms")
            try:
                user_input_ts_ms = int(raw) if raw is not None else None
            except (TypeError, ValueError):
                user_input_ts_ms = None
    except Exception:
        pass
    return thread_id, trace_id or None, user_input_ts_ms
