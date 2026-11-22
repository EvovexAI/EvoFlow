"""In-process background Bash tasks. ZCode TaskOutput / TaskStop / status panel talk here."""

from __future__ import annotations

import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path

BACKGROUND_BASH_OUTPUT_MAX_BYTES = 8192
# Keep live-run heartbeat / UI activity alive while TaskOutput blocks on a
# long background bash (zombie sweeper defaults to ~90s without heartbeat).
_WAIT_HEARTBEAT_INTERVAL_S = 15.0


@dataclass
class BackgroundBashTask:
    task_id: str
    command: str
    description: str
    output_path: Path
    status: str = "running"  # running | completed | failed | stopped | cancelled
    exit_code: int | None = None
    error: str = ""
    proc: object | None = None
    started_at: float = field(default_factory=time.time)
    ended_at: float | None = None
    tool_call_id: str = ""
    thread_id: str = ""
    session_key: str = ""
    cancellable: bool = True
    notification_sent: bool = False
    # 【self-evolution-bot · 2026-11-22 · 第123轮 · 模型:deepseek-v4.1-flash-1017】
    # 上一次阻塞查询的结束时刻（monotonic）与该查询的静默宽限触发时刻。
    # 用来挡住「刚等满 30s 没结束，立刻再等 30s」——现网封顶后重复查询占比
    # 从 6%（20/362）涨到 34%（26/76），重复部分 646s / 1501s = 43.1%。
    last_wait_ended_mono: float = 0.0
    last_wait_quiet_mono: float = 0.0


_LOCK = threading.Lock()
_TASKS: dict[str, BackgroundBashTask] = {}


def register_task(task: BackgroundBashTask) -> None:
    with _LOCK:
        _TASKS[task.task_id] = task


def get_task(task_id: str) -> BackgroundBashTask | None:
    with _LOCK:
        return _TASKS.get(task_id)


def new_task_id() -> str:
    return uuid.uuid4().hex[:12]


def mark(task: BackgroundBashTask, *, status: str, exit_code: int | None = None, error: str = "") -> None:
    task.status = status
    task.exit_code = exit_code
    if error:
        task.error = error
    if status != "running" and task.ended_at is None:
        task.ended_at = time.time()


def _pulse_wait_alive(task: BackgroundBashTask) -> None:
    """Refresh live-run heartbeat + activity while TaskOutput is blocking.

    Gateway reconcile runs in another process and cannot see in-memory ``_TASKS``.
    Without a SQLite heartbeat / session ``updated_at`` pulse, long media waits
    (TaskOutput timeout up to 10min) get false-cancelled as stale — UI then
    thinks the turn ended while the agent is still working ("不对话了").
    """
    sk = str(task.session_key or "").strip()
    tid = str(task.thread_id or "").strip()
    if sk:
        try:
            from evoflow.persistence.live_run_repositories import update_live_run_heartbeat

            update_live_run_heartbeat(sk, thread_id=tid or None)
        except Exception:
            pass
    if not tid:
        return
    try:
        from evoflow.observability.agent_activity_stream import emit_agent_activity

        elapsed = int(max(0.0, time.time() - float(task.started_at)))
        emit_agent_activity(
            tid,
            kind="tools",
            detail=f"等待后台任务 {task.task_id}（已等 {elapsed}s）",
            tool_name="taskoutput",
            force=True,
        )
    except Exception:
        pass


def wait_task(
    task_id: str,
    timeout_ms: int,
    *,
    idle_grace_ms: int = 0,
) -> BackgroundBashTask | None:
    """【self-evolution-bot · 2026-11-19 · 第67轮 · 模型:deepseek-v4.1-flash-1017】

    ``idle_grace_ms`` > 0 时启用「静默宽限提前返回」：只要任务**已经产出过输出**
    并且连续 ``idle_grace_ms`` 没有新增字节，就认为这一轮该看的已经拿到，立即返回，
    不再空等到 ``timeout_ms`` 满。

    为什么加这个：``taskoutput`` 旧默认是 ``block=True`` + ``timeout=30000``，
    于是每次查询最多被按满 30s。现网 obs 近 7 天 543 次里
    **140 次 ≥30s（平均 137.7s）**、130 次 10~30s，累计约 6.2 小时纯等待，
    是仅次 bash 的最大单点浪费；对话里表现为「正在获取任务输出」假死。

    边界：只在**已经有输出字节**后才用宽限。还没任何输出的任务照旧等满
    ``timeout_ms``，否则会把「刚启动还没打印」误判成「可以返回了」。
    """
    task = get_task(task_id)
    if task is None:
        return None
    deadline = time.time() + max(0, timeout_ms) / 1000.0
    next_pulse = 0.0
    grace_s = max(0, idle_grace_ms) / 1000.0
    last_size = -1
    last_growth_at = time.time()
    while task.status == "running" and time.time() < deadline:
        now = time.time()
        if now >= next_pulse:
            _pulse_wait_alive(task)
            next_pulse = now + _WAIT_HEARTBEAT_INTERVAL_S
        if grace_s > 0:
            size = _output_size(task.output_path)
            if size != last_size:
                last_size = size
                last_growth_at = now
            elif size > 0 and (now - last_growth_at) >= grace_s:
                # 有过输出但已经静默足够久 → 这一轮内容稳定，提前返回
                # 【第123轮】记下静默时刻，供 taskoutput 的冷却判据使用。
                task.last_wait_quiet_mono = time.monotonic()
                task.last_wait_ended_mono = task.last_wait_quiet_mono
                return task
        time.sleep(0.1)
    task.last_wait_ended_mono = time.monotonic()
    return task


def _output_size(path: object) -> int:
    """输出文件当前字节数（拿不到就当 0，不抛）。"""
    try:
        return path.stat().st_size  # type: ignore[union-attr]
    except Exception:
        return 0


def stop_task(task_id: str) -> BackgroundBashTask | None:
    task = get_task(task_id)
    if task is None:
        return None
    proc = task.proc
    if proc is not None and task.status == "running":
        try:
            proc.kill()  # type: ignore[attr-defined]
        except Exception as exc:
            task.error = str(exc)
        mark(task, status="cancelled", exit_code=-1)
        try:
            from evoflow.tools.zcode_port.bash_tool import _emit_task_notification

            _emit_task_notification(task)
        except Exception:
            pass
    return task


def list_tasks(*, running_only: bool = False, thread_id: str | None = None) -> list[BackgroundBashTask]:
    with _LOCK:
        items = list(_TASKS.values())
    if thread_id:
        tid = str(thread_id).strip()
        items = [t for t in items if not t.thread_id or t.thread_id == tid]
    if running_only:
        items = [t for t in items if t.status == "running"]
    items.sort(key=lambda t: t.started_at)
    return items


def task_to_summary(task: BackgroundBashTask) -> dict:
    """ZCode BackgroundWorkSummary-shaped row for the status panel."""
    return {
        "workId": task.task_id,
        "kind": "bash",
        "title": (task.description or task.command or task.task_id)[:200],
        "status": "running" if task.status == "running" else (
            "cancelled" if task.status in {"stopped", "cancelled"} else (
                "failed" if task.status == "failed" else "resultPending"
            )
        ),
        "startedAt": int(task.started_at * 1000),
        "endedAt": int(task.ended_at * 1000) if task.ended_at else None,
        "cancellable": bool(task.cancellable and task.status == "running"),
        "toolCallId": task.tool_call_id or task.task_id,
        "command": task.command,
        "outputPath": str(task.output_path),
        "exitCode": task.exit_code,
    }


def read_output_snapshot(task: BackgroundBashTask) -> dict:
    """ZCode backgroundBashOutput shape (bounded)."""
    text = ""
    truncated = False
    try:
        raw = task.output_path.read_bytes() if task.output_path.is_file() else b""
        if len(raw) > BACKGROUND_BASH_OUTPUT_MAX_BYTES:
            truncated = True
            raw = raw[-BACKGROUND_BASH_OUTPUT_MAX_BYTES:]
        text = raw.decode("utf-8", errors="replace")
    except OSError as exc:
        return {
            "kind": "read_failed",
            "workId": task.task_id,
            "code": str(exc),
        }
    status_map = {
        "running": "running",
        "completed": "completed",
        "failed": "failed",
        "stopped": "cancelled",
        "cancelled": "cancelled",
    }
    return {
        "kind": "output",
        "workId": task.task_id,
        "status": status_map.get(task.status, "completed"),
        "output": text,
        "truncated": truncated,
        "outputPath": str(task.output_path),
    }
