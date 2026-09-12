"""Unified background process management (preferred over ``terminal`` for long jobs)."""

from __future__ import annotations

import logging
import os
import subprocess
import threading
import time
import uuid
from collections import defaultdict, deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Annotated, Any, Literal

from langchain.tools import ToolRuntime, tool
from langgraph.typing import ContextT
from pydantic import Field

from evoflow.tools.host_direct.workspace_path_guard import resolve_tool_workdir
from evoflow.tools.minimal_schema import PROCESS_TOOL_DESCRIPTION
from evoflow.utils.subprocess_platform import (
    detect_shell,
    prepare_shell_command,
    prepare_shell_env,
    subprocess_hide_window_kwargs,
    subprocess_text_io_kwargs,
)

logger = logging.getLogger(__name__)

_MAX_OUTPUT_LINES = 500
_FINISHED_TTL_SECONDS = 1800
_MAX_PROCESSES_PER_THREAD = 16

ProcessAction = Literal["start", "log", "wait", "kill"]


@dataclass
class ProcessSession:
    """A tracked process with output buffering."""

    id: str
    command: str
    thread_id: str
    process: subprocess.Popen
    stdout_buf: deque[str] = field(default_factory=lambda: deque(maxlen=_MAX_OUTPUT_LINES))
    stderr_buf: deque[str] = field(default_factory=lambda: deque(maxlen=_MAX_OUTPUT_LINES))
    start_time: float = field(default_factory=time.time)
    exited: bool = False
    exit_code: int | None = None
    killed: bool = False
    _reader_threads: list[threading.Thread] = field(default_factory=list)
    _lock: threading.Lock = field(default_factory=threading.Lock)

    def is_alive(self) -> bool:
        if self.exited or self.killed:
            return False
        return self.process.poll() is None

    def update_status(self) -> None:
        with self._lock:
            if self.exited:
                return
            code = self.process.poll()
            if code is not None:
                self.exited = True
                self.exit_code = code


_process_registry: dict[str, dict[str, ProcessSession]] = {}
_registry_lock = threading.Lock()
_wait_timeout_streak: dict[str, int] = defaultdict(int)
_finished_records: dict[str, dict[str, Any]] = {}
_finished_records_lock = threading.Lock()


def _get_thread_id(runtime: ToolRuntime[ContextT, Any]) -> str:
    ctx = getattr(runtime, "context", None) or {}
    tid = ctx.get("thread_id") if ctx else None
    if tid:
        return str(tid)
    return "__default__"


def _get_thread_registry(thread_id: str) -> dict[str, ProcessSession]:
    with _registry_lock:
        return _process_registry.setdefault(thread_id, {})


def register_process_session(session: ProcessSession, thread_id: str = "__terminal__") -> None:
    """Register a tracked process (e.g. from ``terminal`` background mode)."""
    reg = _get_thread_registry(thread_id)
    reg[session.id] = session


def _save_finished_record(session: ProcessSession) -> None:
    """Cache the last output of a finished process so log/wait can return it after pruning."""
    session.update_status()
    record: dict[str, Any] = {
        "session_id": session.id,
        "command": session.command,
        "exit_code": session.exit_code,
        "exited": True,
        "killed": session.killed,
        "stdout": list(session.stdout_buf),
        "stderr": list(session.stderr_buf),
        "start_time": session.start_time,
    }
    with _finished_records_lock:
        _finished_records[session.id] = record
        # Prune old finished records to avoid unbounded growth
        if len(_finished_records) > 100:
            oldest = sorted(_finished_records.items(), key=lambda x: x[1].get("start_time", 0))
            for key, _ in oldest[: len(_finished_records) - 100]:
                _finished_records.pop(key, None)


def _get_finished_record(session_id: str) -> dict[str, Any] | None:
    with _finished_records_lock:
        return _finished_records.get(session_id)


def _format_finished_record(record: dict[str, Any], *, tail: int = 50) -> str:
    parts = [
        f"Status: finished (process exited, session pruned)",
        f"Command: {record.get('command', '')}",
        f"Exit code: {record.get('exit_code', '?')}",
    ]
    stdout_lines = record.get("stdout", [])[-tail:]
    stderr_lines = record.get("stderr", [])[-tail:]
    if stdout_lines:
        parts.append("[stdout]\n" + "\n".join(stdout_lines))
    if stderr_lines:
        parts.append("[stderr]\n" + "\n".join(stderr_lines))
    return "\n\n".join(parts)


def _find_session(session_id: str, thread_id: str) -> ProcessSession | None:
    reg = _get_thread_registry(thread_id)
    session = reg.get(session_id)
    if session:
        return session
    with _registry_lock:
        for bucket in _process_registry.values():
            session = bucket.get(session_id)
            if session:
                return session
    return None


def _remove_session(session_id: str, thread_id: str) -> ProcessSession | None:
    reg = _get_thread_registry(thread_id)
    session = reg.pop(session_id, None)
    if session:
        return session
    with _registry_lock:
        for bucket in _process_registry.values():
            session = bucket.pop(session_id, None)
            if session:
                return session
    return None


def _prune_finished(thread_id: str) -> None:
    now = time.time()
    with _registry_lock:
        reg = _process_registry.get(thread_id, {})
        to_remove = [sid for sid, s in reg.items() if s.exited and (now - s.start_time) > _FINISHED_TTL_SECONDS]
        for sid in to_remove:
            s = reg.pop(sid, None)
            if s:
                _save_finished_record(s)
                if s.process.poll() is None:
                    try:
                        s.process.kill()
                    except Exception:
                        pass


def _read_output(pipe, buf: deque[str]) -> None:
    try:
        for line in iter(pipe.readline, ""):
            buf.append(line.rstrip("\n"))
    except Exception:
        pass
    finally:
        try:
            pipe.close()
        except Exception:
            pass


def _run_command(command: str, workdir: str | None) -> subprocess.Popen:
    cwd = Path(workdir) if workdir else None
    shell_cmd, shell_args, use_shell = detect_shell()
    env = prepare_shell_env(os.environ.copy())
    if use_shell:
        command = prepare_shell_command(command, os.environ.get("COMSPEC", "cmd.exe"))
    else:
        command = prepare_shell_command(command, shell_cmd)
    popen_kw = {**subprocess_hide_window_kwargs(), **subprocess_text_io_kwargs()}

    if use_shell:
        return subprocess.Popen(
            command,
            shell=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            cwd=cwd,
            env=env,
            **popen_kw,
        )
    full_cmd = [shell_cmd] + shell_args + [command]
    return subprocess.Popen(
        full_cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        cwd=cwd,
        env=env,
        **popen_kw,
    )


def _format_session_status(session: ProcessSession) -> str:
    session.update_status()
    status = "running" if session.is_alive() else "finished"
    uptime = int(time.time() - session.start_time)
    lines = [
        f"Status: {status}",
        f"Command: {session.command}",
        f"Uptime: {uptime}s",
    ]
    if session.exited:
        lines.append(f"Exit code: {session.exit_code}")
    return "\n".join(lines)


def _process_start(
    runtime: ToolRuntime[ContextT, Any],
    command: str,
    *,
    background: bool = True,
    timeout: int = 300,
    workdir: str | None = None,
) -> str:
    thread_id = _get_thread_id(runtime)
    _prune_finished(thread_id)

    reg = _get_thread_registry(thread_id)
    if len(reg) >= _MAX_PROCESSES_PER_THREAD:
        oldest = sorted(
            ((sid, s) for sid, s in reg.items() if s.exited),
            key=lambda x: x[1].start_time,
        )
        for sid, _ in oldest[: len(reg) - _MAX_PROCESSES_PER_THREAD + 1]:
            reg.pop(sid, None)
        if len(reg) >= _MAX_PROCESSES_PER_THREAD:
            return "Error: Too many active processes. Kill some first with process(action='kill', …)."

    cwd_resolved = resolve_tool_workdir(workdir, runtime=runtime)
    if isinstance(cwd_resolved, str):
        return cwd_resolved
    workdir_str = str(cwd_resolved)

    from evoflow.tools.host_direct.skill_command_paths import rewrite_skill_paths_in_command

    command = rewrite_skill_paths_in_command(command)

    try:
        proc = _run_command(command, workdir_str)
    except Exception as e:
        return f"Error: Failed to start process: {e}"

    session_id = f"proc_{uuid.uuid4().hex[:12]}"
    session = ProcessSession(
        id=session_id,
        command=command,
        thread_id=thread_id,
        process=proc,
    )

    if proc.stdout:
        t = threading.Thread(target=_read_output, args=(proc.stdout, session.stdout_buf), daemon=True)
        t.start()
        session._reader_threads.append(t)
    if proc.stderr:
        t = threading.Thread(target=_read_output, args=(proc.stderr, session.stderr_buf), daemon=True)
        t.start()
        session._reader_threads.append(t)

    reg[session_id] = session

    if not background:
        try:
            proc.wait(timeout=timeout)
            session.update_status()
        except subprocess.TimeoutExpired:
            proc.kill()
            session.killed = True
            session.exited = True
            session.exit_code = -1
            reg.pop(session_id, None)
            return f"Process timed out after {timeout}s and was killed.\nCommand: {command}\nSession: {session_id}"

        stdout = "\n".join(session.stdout_buf)
        stderr = "\n".join(session.stderr_buf)
        parts = []
        if stdout:
            parts.append(stdout)
        if stderr:
            parts.append(f"[stderr]\n{stderr}")
        parts.append(f"[exit code: {session.exit_code}]")
        reg.pop(session_id, None)
        return "\n".join(parts)

    return f"Process started in background.\nSession: {session_id}\nCommand: {command}\nPID: {proc.pid}"


def _process_log(
    runtime: ToolRuntime[ContextT, Any],
    session_id: str,
    *,
    tail: int = 50,
) -> str:
    thread_id = _get_thread_id(runtime)
    session = _find_session(session_id, thread_id)
    if not session:
        record = _get_finished_record(session_id)
        if record:
            return _format_finished_record(record, tail=tail)
        return f"Error: No process found with session_id='{session_id}'"

    parts = [_format_session_status(session)]
    stdout_lines = list(session.stdout_buf)[-tail:]
    stderr_lines = list(session.stderr_buf)[-tail:]

    if stdout_lines:
        parts.append("[stdout]\n" + "\n".join(stdout_lines))
    if stderr_lines:
        parts.append("[stderr]\n" + "\n".join(stderr_lines))
    if len(parts) == 1:
        parts.append("(no output yet)")
    if session.is_alive():
        parts.append(
            "Tip: process still running — use process(action='wait', ...) to block until "
            "completion instead of polling log repeatedly."
        )
    return "\n\n".join(parts)


def _process_kill(runtime: ToolRuntime[ContextT, Any], session_id: str) -> str:
    thread_id = _get_thread_id(runtime)
    session = _remove_session(session_id, thread_id)
    if not session:
        return f"Error: No process found with session_id='{session_id}'"

    try:
        session.process.kill()
        session.killed = True
        session.exited = True
        session.exit_code = -1
        return f"Killed process {session_id}\nCommand: {session.command}"
    except Exception as e:
        return f"Error killing process: {e}"


def _process_wait(
    runtime: ToolRuntime[ContextT, Any],
    session_id: str,
    *,
    timeout: int = 300,
) -> str:
    thread_id = _get_thread_id(runtime)
    if _wait_timeout_streak.get(thread_id, 0) >= 2:
        return (
            f"Error: process wait blocked — {_wait_timeout_streak[thread_id]} consecutive timeouts "
            f"for this thread. Run process(action='kill', session_id='{session_id}') to stop it, "
            "or let it finish naturally. Avoid polling action='log' repeatedly."
        )
    session = _find_session(session_id, thread_id)
    if not session:
        record = _get_finished_record(session_id)
        if record:
            return _format_finished_record(record)
        return f"Error: No process found with session_id='{session_id}'"

    try:
        session.process.wait(timeout=timeout)
        session.update_status()
        _wait_timeout_streak[thread_id] = 0
    except subprocess.TimeoutExpired:
        _wait_timeout_streak[thread_id] = _wait_timeout_streak.get(thread_id, 0) + 1
        streak = _wait_timeout_streak[thread_id]
        # Return current output so the caller can see progress without polling log
        stdout = "\n".join(session.stdout_buf)
        stderr = "\n".join(session.stderr_buf)
        parts = [f"Timeout: Process still running after {timeout}s (streak {streak})."]
        if stdout:
            parts.append(f"[stdout]\n{stdout}")
        if stderr:
            parts.append(f"[stderr]\n{stderr}")
        if streak >= 2:
            parts.append(
                f"Further wait calls are blocked. Run process(action='kill', "
                f"session_id='{session_id}') to stop, or wait for natural exit."
            )
        else:
            parts.append(
                f"Retry with a larger timeout: process(action='wait', "
                f"session_id='{session_id}', timeout=600)."
            )
        return "\n".join(parts)
    except Exception as e:
        return f"Error waiting for process: {e}"

    stdout = "\n".join(session.stdout_buf)
    stderr = "\n".join(session.stderr_buf)
    parts = []
    if stdout:
        parts.append(stdout)
    if stderr:
        parts.append(f"[stderr]\n{stderr}")
    parts.append(f"[exit code: {session.exit_code}]")
    return "\n".join(parts)


@tool("process", description=PROCESS_TOOL_DESCRIPTION, parse_docstring=False)
def process_tool(
    runtime: ToolRuntime[ContextT, Any],
    action: ProcessAction,
    *,
    command: str | None = None,
    session_id: str | None = None,
    background: bool = True,
    timeout: int = 300,
    tail: int = 50,
    workdir: Annotated[
        str | None,
        Field(
            default=None,
            description="skill:<name> or workspace (start only).",
        ),
    ] = None,
) -> str:
    """Manage background host processes."""
    act = str(action or "").strip().lower()
    if act == "start":
        cmd = str(command or "").strip()
        if not cmd:
            return "Error: command is required for action='start'."
        return _process_start(
            runtime,
            cmd,
            background=background,
            timeout=timeout,
            workdir=workdir,
        )
    sid = str(session_id or "").strip()
    if not sid:
        return f"Error: session_id is required for action='{act}'."
    if act == "log":
        return _process_log(runtime, sid, tail=tail)
    if act == "wait":
        return _process_wait(runtime, sid, timeout=timeout)
    if act == "kill":
        return _process_kill(runtime, sid)
    return f"Error: unknown action '{action}'. Use start|log|wait|kill."
