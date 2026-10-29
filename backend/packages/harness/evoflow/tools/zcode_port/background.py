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
    """Refresh live-run heartbeat + activity while TaskOutput is blocking."""
    sk = str(task.session_key or "").strip()
    if sk:
        try:
            from evoflow.persistence.live_run_repositories import update_live_run_heartbeat

            update_live_run_heartbeat(sk)
        except Exception:
            pass
    tid = str(task.thread_id or "").strip()
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


def wait_task(task_id: str, timeout_ms: int) -> BackgroundBashTask | None:
    task = get_task(task_id)
    if task is None:
        return None
    deadline = time.time() + max(0, timeout_ms) / 1000.0
    next_pulse = 0.0
    while task.status == "running" and time.time() < deadline:
        now = time.time()
        if now >= next_pulse:
            _pulse_wait_alive(task)
            next_pulse = now + _WAIT_HEARTBEAT_INTERVAL_S
        time.sleep(0.1)
    return task


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
