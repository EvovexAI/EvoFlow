"""Per-thread logical shell state for ``terminal`` tool reuse.

Tracks cwd across calls in the same chat thread. Each command runs in a fresh
subprocess with the saved cwd restored, so ``cd`` and working directory persist
without a long-lived shell process (avoids Windows PowerShell pipe buffering).
"""

from __future__ import annotations

import logging
import os
import re
import subprocess
import threading
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from evoflow.utils.subprocess_platform import (
    detect_shell,
    prepare_shell_command,
    prepare_shell_env,
    sanitize_child_process_env,
    subprocess_hide_window_kwargs,
    subprocess_text_io_kwargs,
)

logger = logging.getLogger(__name__)

_SESSION_IDLE_TTL = int(os.getenv("TERMINAL_SESSION_IDLE_TTL", "1800"))
_MAX_OUTPUT_CHARS = 50_000
_START_RE = re.compile(r"__EVOFLOW_START__([a-f0-9]+)__\s*")
_END_RE = re.compile(r"__EVOFLOW_END__([a-f0-9]+)__(-?\d+)\s*")
_CWD_RE = re.compile(r"__EVOFLOW_CWD__(.+?)(?:\r?\n|$)")
_ANSI_ESCAPE_RE = re.compile(r"\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*\x07)")
_CONTROL_CHARS_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")

_registry: dict[str, ThreadShellState] = {}
_registry_lock = threading.Lock()

StreamWriter = Callable[[dict[str, Any]], Any]


def _strip_ansi(text: str) -> str:
    text = _ANSI_ESCAPE_RE.sub("", text)
    text = _CONTROL_CHARS_RE.sub("", text)
    return text


def runtime_thread_id(runtime: Any) -> str:
    ctx = getattr(runtime, "context", None) or {}
    tid = ctx.get("thread_id") if isinstance(ctx, dict) else None
    if tid:
        return str(tid)
    cfg = getattr(runtime, "config", None) or {}
    if isinstance(cfg, dict):
        conf = cfg.get("configurable") or {}
        if isinstance(conf, dict) and conf.get("thread_id"):
            return str(conf["thread_id"])
    return "__default__"


def _clean_env() -> dict[str, str]:
    return sanitize_child_process_env(prepare_shell_env(os.environ.copy()))


def _is_powershell(shell_path: str) -> bool:
    base = os.path.basename(shell_path).lower()
    return "powershell" in base or base == "pwsh.exe"


def _is_cmd_exe(shell_path: str) -> bool:
    return os.path.basename(shell_path).lower() == "cmd.exe"


def _powershell_literal(path: str) -> str:
    return "'" + str(path).replace("'", "''") + "'"


def _cmd_literal(path: str) -> str:
    return '"' + str(path).replace('"', '""') + '"'


def _flatten_command(command: str, *, state: ThreadShellState) -> str:
    cmd = str(command or "").strip()
    if state.is_powershell or state.is_cmd:
        return re.sub(r"[\r\n]+", "; ", cmd)
    return cmd


def _strip_protocol_lines(text: str, marker: str) -> str:
    text = re.sub(rf"__EVOFLOW_START__{re.escape(marker)}__\s*", "", text)
    text = re.sub(rf"__EVOFLOW_END__{re.escape(marker)}__-?\d+\s*", "", text)
    text = _CWD_RE.sub("", text)
    return text


def _filter_stream_chunk(chunk: str) -> str:
    clean = _START_RE.sub("", chunk)
    clean = _END_RE.sub("", clean)
    clean = _CWD_RE.sub("", clean)
    return clean


@dataclass
class ThreadShellState:
    thread_id: str
    shell_path: str
    is_powershell: bool
    is_cmd: bool
    cwd: str | None = None
    last_used: float = field(default_factory=time.time)
    lock: threading.Lock = field(default_factory=threading.Lock)

    def touch(self) -> None:
        self.last_used = time.time()


def _format_result(stdout: str, exit_code: int) -> str:
    text = (stdout or "").rstrip()
    if len(text) > _MAX_OUTPUT_CHARS:
        text = text[:_MAX_OUTPUT_CHARS] + f"\n\n[truncated: output exceeded {_MAX_OUTPUT_CHARS:,} chars]"
    parts: list[str] = []
    if text:
        parts.append(text)
    if exit_code != 0:
        parts.append(f"[exit code: {exit_code}]")
    return "\n".join(parts) if parts else ""


def _parse_marked_output(raw: str, marker: str) -> tuple[str, int, str | None]:
    end_pat = re.compile(rf"__EVOFLOW_END__{re.escape(marker)}__(-?\d+)")
    start_pat = re.compile(rf"__EVOFLOW_START__{re.escape(marker)}__\s*")
    m_end = end_pat.search(raw)
    if not m_end:
        body = _strip_protocol_lines(raw, marker)
        return _strip_ansi(body).strip(), 0, None
    body = raw[: m_end.start()]
    body = start_pat.sub("", body, count=1)
    body = _strip_protocol_lines(body, marker)
    cwd_match = _CWD_RE.search(raw)
    new_cwd = cwd_match.group(1).strip() if cwd_match else None
    try:
        exit_code = int(m_end.group(1))
    except ValueError:
        exit_code = 0
    return _strip_ansi(body).strip(), exit_code, new_cwd


def _wrap_command(state: ThreadShellState, command: str, marker: str) -> str:
    cmd = _flatten_command(command, state=state)
    prelude: list[str] = []
    if state.cwd:
        if state.is_powershell:
            prelude.append(f"Set-Location -LiteralPath {_powershell_literal(state.cwd)}")
        elif state.is_cmd:
            prelude.append(f"cd /d {_cmd_literal(state.cwd)}")
        else:
            prelude.append(f"cd {_powershell_literal(state.cwd)}")
    if prelude:
        inner = "; ".join([*prelude, cmd]) if state.is_powershell or state.is_cmd else "\n".join([*prelude, cmd])
    else:
        inner = cmd

    if state.is_powershell:
        inner = prepare_shell_command(inner, state.shell_path)
        return (
            f"Write-Output '__EVOFLOW_START__{marker}__'; "
            f"{inner}; "
            f"Write-Output ('__EVOFLOW_CWD__' + (Get-Location).Path); "
            f"$ec = if ($null -ne $LASTEXITCODE) {{ $LASTEXITCODE }} else {{ 0 }}; "
            f"Write-Output \"__EVOFLOW_END__{marker}__$ec\""
        )
    if state.is_cmd:
        inner = prepare_shell_command(inner, state.shell_path)
        return (
            f"echo __EVOFLOW_START__{marker}__ & {inner} & "
            f"for /f \"delims=\" %%i in ('cd') do echo __EVOFLOW_CWD__%%i & "
            f"echo __EVOFLOW_END__{marker}__%ERRORLEVEL%"
        )
    return (
        f"echo '__EVOFLOW_START__{marker}__'\n"
        f"{inner}\n"
        f"echo \"__EVOFLOW_CWD__$(pwd)\"\n"
        f"ec=$?; echo \"__EVOFLOW_END__{marker}__${{ec}}\"\n"
    )


def _pipe_reader(
    pipe,
    *,
    is_stderr: bool,
    invocation_id: str,
    tool_call_id: str,
    stream_writer: StreamWriter | None,
    buf: list[str],
) -> None:
    from evoflow.tools.host_direct.terminal_stream import emit_terminal_stderr, emit_terminal_stdout

    emit = emit_terminal_stderr if is_stderr else emit_terminal_stdout
    iid = str(invocation_id or "").strip()
    try:
        while True:
            chunk = pipe.read(4096)
            if not chunk:
                break
            text = _strip_ansi(chunk)
            buf.append(text)
            if stream_writer and tool_call_id:
                clean = _filter_stream_chunk(text)
                if clean:
                    emit(invocation_id=iid, tool_call_id=tool_call_id, text=clean, stream_writer=stream_writer)
    except Exception:
        pass
    finally:
        try:
            pipe.close()
        except Exception:
            pass


def _execute_wrapped(
    wrapped: str,
    *,
    cwd: Path | None,
    timeout: int,
    invocation_id: str,
    tool_call_id: str,
    stream_writer: StreamWriter | None,
) -> tuple[str, int]:
    shell_cmd, shell_args, use_shell = detect_shell()
    env = _clean_env()
    run_kw = {**subprocess_hide_window_kwargs(), **subprocess_text_io_kwargs()}
    tc = str(tool_call_id or "").strip()
    iid = str(invocation_id or "").strip()
    use_stream = bool(stream_writer and tc)

    try:
        if use_shell:
            proc = subprocess.Popen(
                wrapped,
                shell=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                cwd=cwd,
                env=env,
                **run_kw,
            )
        else:
            full_cmd = [shell_cmd] + shell_args + [wrapped]
            proc = subprocess.Popen(
                full_cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                cwd=cwd,
                env=env,
                **run_kw,
            )

        stdout_buf: list[str] = []
        stderr_buf: list[str] = []
        t_out = threading.Thread(
            target=_pipe_reader,
            args=(proc.stdout,),
            kwargs={
                "is_stderr": False,
                "invocation_id": iid,
                "tool_call_id": tc if use_stream else "",
                "stream_writer": stream_writer if use_stream else None,
                "buf": stdout_buf,
            },
            daemon=True,
        )
        t_err = threading.Thread(
            target=_pipe_reader,
            args=(proc.stderr,),
            kwargs={
                "is_stderr": True,
                "invocation_id": iid,
                "tool_call_id": tc if use_stream else "",
                "stream_writer": stream_writer if use_stream else None,
                "buf": stderr_buf,
            },
            daemon=True,
        )
        t_out.start()
        t_err.start()
        try:
            proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            proc.kill()
            t_out.join(timeout=1)
            t_err.join(timeout=1)
            raise TimeoutError(f"Command timed out after {timeout} seconds")
        t_out.join(timeout=2)
        t_err.join(timeout=2)
        exit_code = proc.returncode if proc.returncode is not None else 0
        raw = _strip_ansi("".join(stdout_buf))
        err = _strip_ansi("".join(stderr_buf))
        if err:
            raw = raw + ("\n" if raw else "") + f"[stderr]\n{err.rstrip()}"
        return raw, exit_code
    except TimeoutError:
        raise
    except FileNotFoundError:
        raise RuntimeError("Shell executable not found") from None
    except Exception as exc:
        raise RuntimeError(f"executing command: {exc}") from exc


def _prune_idle_sessions() -> None:
    now = time.time()
    with _registry_lock:
        stale = [tid for tid, s in _registry.items() if now - s.last_used > _SESSION_IDLE_TTL]
        for tid in stale:
            _registry.pop(tid, None)


def close_session(thread_id: str) -> None:
    with _registry_lock:
        _registry.pop(thread_id, None)


def reset_session(thread_id: str) -> None:
    close_session(thread_id)


def _new_state(thread_id: str, *, cwd: Path | None) -> ThreadShellState:
    shell_path, _, _ = detect_shell()
    return ThreadShellState(
        thread_id=thread_id,
        shell_path=shell_path,
        is_powershell=_is_powershell(shell_path),
        is_cmd=_is_cmd_exe(shell_path),
        cwd=str(cwd.resolve()) if cwd else None,
    )


def _get_or_create_state(
    thread_id: str,
    *,
    cwd: Path | None,
    new_session: bool,
    workdir_explicit: bool,
) -> ThreadShellState:
    _prune_idle_sessions()
    if new_session:
        close_session(thread_id)

    with _registry_lock:
        existing = _registry.get(thread_id)
        if existing:
            existing.touch()
            state = existing
        else:
            state = _new_state(thread_id, cwd=cwd)
            _registry[thread_id] = state

    if new_session:
        state.cwd = str(cwd.resolve()) if cwd else None
    elif workdir_explicit and cwd:
        state.cwd = str(cwd.resolve())
    elif state.cwd is None and cwd:
        state.cwd = str(cwd.resolve())

    return state


def run_in_persistent_session(
    *,
    runtime: Any,
    command: str,
    cwd: Path | None,
    timeout: int,
    invocation_id: str = "",
    tool_call_id: str,
    stream_writer: StreamWriter | None,
    new_session: bool = False,
    workdir_explicit: bool = False,
) -> str:
    from evoflow.tools.host_direct.terminal_stream import (
        emit_terminal_exit,
        emit_terminal_start,
        emit_terminal_stderr,
    )

    thread_id = runtime_thread_id(runtime)
    marker = uuid.uuid4().hex[:12]
    tc = str(tool_call_id or "").strip()
    iid = str(invocation_id or "").strip()

    state = _get_or_create_state(
        thread_id,
        cwd=cwd,
        new_session=new_session,
        workdir_explicit=workdir_explicit,
    )

    wrapped = _wrap_command(state, command, marker)
    popen_cwd = Path(state.cwd) if state.cwd else cwd

    with state.lock:
        state.touch()
        if stream_writer and tc:
            emit_terminal_start(invocation_id=iid, tool_call_id=tc, command=command, stream_writer=stream_writer)
        try:
            raw, _proc_code = _execute_wrapped(
                wrapped,
                cwd=popen_cwd,
                timeout=timeout,
                invocation_id=iid,
                tool_call_id=tool_call_id,
                stream_writer=stream_writer,
            )
        except TimeoutError as exc:
            close_session(thread_id)
            msg = f"Error: {exc}"
            if stream_writer and tc:
                emit_terminal_exit(invocation_id=iid, tool_call_id=tc, exit_code=-1, success=False, stream_writer=stream_writer)
            return msg
        except RuntimeError as exc:
            close_session(thread_id)
            msg = f"Error: {exc}"
            if stream_writer and tc:
                emit_terminal_stderr(tool_call_id=tc, text=msg + "\n", stream_writer=stream_writer)
                emit_terminal_exit(tool_call_id=tc, exit_code=-1, success=False, stream_writer=stream_writer)
            return msg

    body, exit_code, new_cwd = _parse_marked_output(raw, marker)
    if new_cwd:
        state.cwd = new_cwd
    if stream_writer and tc:
        emit_terminal_exit(tool_call_id=tc, exit_code=exit_code, stream_writer=stream_writer)
    return _format_result(body, exit_code)
