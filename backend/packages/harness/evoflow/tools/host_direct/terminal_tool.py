"""Terminal Tool — full-featured shell command execution for EvoFlow.

Provides a unified terminal interface inspired by Hermes Agent:
- Foreground command execution with timeout
- Background process management (integrates with process tool)
- PTY mode for interactive CLI tools (Python REPL, vim, etc.)
- Working directory support
- ANSI escape stripping
- Auto shell detection (Windows PowerShell/cmd, Linux bash/zsh/sh)

Design:
  One tool ("terminal") with parameters that control execution mode.
  Background tasks register into the existing process tool registry
  so process(action='log'|'wait'|'kill') can manage them.
"""

import logging
import os
import re
import subprocess
import threading
import time
import uuid
from pathlib import Path
from typing import Annotated

from langchain.tools import InjectedToolCallId, ToolRuntime, tool
from pydantic import Field

from evoflow.tools.host_direct.workspace_path_guard import resolve_tool_workdir
from evoflow.tools.minimal_schema import TERMINAL_TOOL_DESCRIPTION
from evoflow.utils.subprocess_platform import (
    detect_shell,
    prepare_shell_command,
    prepare_shell_env,
    sanitize_child_process_env,
    subprocess_hide_window_kwargs,
    subprocess_text_io_kwargs,
)

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_FOREGROUND_MAX_TIMEOUT = int(os.getenv("TERMINAL_FOREGROUND_MAX_TIMEOUT", "180"))
_DEFAULT_TIMEOUT = int(os.getenv("TERMINAL_DEFAULT_TIMEOUT", "30"))
# Soft cap when model omits timeout on curl without -m/--max-time (avoids hanging probes).
_CURL_PROBE_MAX_TIMEOUT = int(os.getenv("TERMINAL_CURL_MAX_TIMEOUT", "15"))
_MAX_OUTPUT_CHARS = 50_000
_OUTPUT_TRUNCATED_MSG = "\n\n[truncated: output exceeded {max_chars:,} chars; full output at {path}]"

# ---------------------------------------------------------------------------
# PTY helpers (POSIX only)
# ---------------------------------------------------------------------------


def _run_via_pty(command: str, cwd: Path | None, timeout: int) -> str:
    """Run *command* in a pseudo-terminal and return output.

    Uses ``ptyprocess`` on POSIX systems.  Falls back to regular subprocess
    if the package is not installed or on Windows.
    """
    try:
        from ptyprocess import PtyProcess
    except ImportError:
        logger.debug("ptyprocess not available — fallback to subprocess")
        return _run_subprocess(command, cwd, timeout, pty=False)

    shell_path, _args, _ = detect_shell()
    env = sanitize_child_process_env(prepare_shell_env(os.environ.copy()))

    try:
        proc = PtyProcess.spawn(
            [shell_path, "-lic", command] if not os.name == "nt" else [shell_path, "-Command", command],
            cwd=str(cwd) if cwd else None,
            env=env,
            dimensions=(30, 120),
        )
        output: list[str] = []
        deadline = time.monotonic() + timeout

        while time.monotonic() < deadline:
            try:
                # read() is non-blocking with a small timeout
                chunk = proc.read(4096, timeout=0.5)
                if chunk:
                    output.append(chunk)
                if not proc.isalive() and not chunk:
                    break
            except EOFError:
                break
            except Exception:
                break

        try:
            proc.close()
        except Exception:
            pass

        raw = "".join(output)
        exit_code = proc.exitstatus if hasattr(proc, "exitstatus") and proc.exitstatus is not None else 0

    except Exception as e:
        raw = f"[PTY error: {e}]"
        exit_code = -1

    return _format_result(raw, exit_code)


# ---------------------------------------------------------------------------
# Subprocess execution
# ---------------------------------------------------------------------------

# ANSI escape and control character stripping
_ANSI_ESCAPE_RE = re.compile(r"\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*\x07)")
_CONTROL_CHARS_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def _strip_ansi(text: str) -> str:
    text = _ANSI_ESCAPE_RE.sub("", text)
    text = _CONTROL_CHARS_RE.sub("", text)
    return text


def _format_subprocess_output(stdout: str, stderr: str, exit_code: int) -> str:
    output_parts = []
    if stdout:
        output_parts.append(stdout.rstrip())
    if stderr:
        output_parts.append(f"[stderr]\n{stderr.rstrip()}")
    if exit_code != 0:
        output_parts.append(f"[exit code: {exit_code}]")
    return "\n".join(output_parts) if output_parts else ""


def _pipe_reader(
    pipe,
    *,
    is_stderr: bool,
    invocation_id: str,
    tool_call_id: str,
    stream_writer,
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
            clean = _strip_ansi(chunk)
            if not clean:
                continue
            buf.append(clean)
            if stream_writer and tool_call_id:
                emit(invocation_id=iid, tool_call_id=tool_call_id, text=clean, stream_writer=stream_writer)
    except Exception:
        pass
    finally:
        try:
            pipe.close()
        except Exception:
            pass


def _run_subprocess(
    command: str,
    cwd: Path | None,
    timeout: int,
    pty: bool = False,
    *,
    invocation_id: str = "",
    tool_call_id: str = "",
    stream_writer=None,
) -> str:
    """Execute *command* via subprocess and return formatted result."""
    if pty:
        from evoflow.tools.host_direct.terminal_stream import (
            emit_terminal_exit,
            emit_terminal_start,
            emit_terminal_stdout,
        )

        tc = str(tool_call_id or "").strip()
        iid = str(invocation_id or "").strip()
        if stream_writer and tc:
            emit_terminal_start(invocation_id=iid, tool_call_id=tc, command=command, stream_writer=stream_writer)
        result = _run_via_pty(command, cwd, timeout)
        if stream_writer and tc:
            if result and result.strip():
                emit_terminal_stdout(invocation_id=iid, tool_call_id=tc, text=result, stream_writer=stream_writer)
            exit_code = 0
            if "[exit code:" in result:
                m = re.search(r"\[exit code:\s*(-?\d+)\]", result)
                if m:
                    try:
                        exit_code = int(m.group(1))
                    except ValueError:
                        exit_code = 0
            emit_terminal_exit(
                invocation_id=iid,
                tool_call_id=tc,
                exit_code=exit_code,
                success=exit_code == 0,
                stream_writer=stream_writer,
            )
        return result

    shell_cmd, shell_args, use_shell = detect_shell()
    env = sanitize_child_process_env(prepare_shell_env(os.environ.copy()))
    if use_shell:
        command = prepare_shell_command(command, shell_cmd or "/bin/sh")
    else:
        command = prepare_shell_command(command, shell_cmd)
    run_kw = {**subprocess_hide_window_kwargs(), **subprocess_text_io_kwargs()}

    # Prefer OS sandbox wrapper when execution_security is active; else legacy host spawn.
    sandboxed_argv: list[str] | None = None
    try:
        from evoflow.execution_security.config import (
            is_execution_security_active,
            resolve_execution_security_for_thread,
        )
        from evoflow.execution_security.runner import build_shell_argv, wrap_argv_for_sandbox

        thread_id = None
        if runtime is not None and getattr(runtime, "context", None):
            thread_id = str(runtime.context.get("thread_id") or "").strip() or None
        sec = resolve_execution_security_for_thread(thread_id)
        if is_execution_security_active(sec):
            workdir = Path(cwd) if cwd else Path.cwd()
            wrapped, mode = wrap_argv_for_sandbox(
                build_shell_argv(command),
                command_cwd=workdir,
                policy_cwd=workdir,
                env=env,
                cfg=sec,
            )
            if mode == "sandboxed":
                sandboxed_argv = wrapped
                logger.debug("terminal: sandboxed argv via execution_security (%s)", wrapped[0])
    except Exception:
        logger.debug("terminal: execution_security wrap skipped", exc_info=True)

    tc = str(tool_call_id or "").strip()
    iid = str(invocation_id or "").strip()
    use_stream = bool(stream_writer and tc)

    try:
        if use_stream:
            from evoflow.tools.host_direct.terminal_stream import emit_terminal_exit, emit_terminal_start

            emit_terminal_start(invocation_id=iid, tool_call_id=tc, command=command, stream_writer=stream_writer)
            if sandboxed_argv is not None:
                proc = subprocess.Popen(
                    sandboxed_argv,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    cwd=cwd,
                    env=env,
                    **run_kw,
                )
            elif use_shell:
                proc = subprocess.Popen(
                    command,
                    shell=True,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    cwd=cwd,
                    env=env,
                    **run_kw,
                )
            else:
                full_cmd = [shell_cmd] + shell_args + [command]
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
                    "tool_call_id": tc,
                    "stream_writer": stream_writer,
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
                    "tool_call_id": tc,
                    "stream_writer": stream_writer,
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
                emit_terminal_exit(
                    invocation_id=iid,
                    tool_call_id=tc,
                    exit_code=-1,
                    success=False,
                    stream_writer=stream_writer,
                )
                return f"Error: Command timed out after {timeout} seconds"
            t_out.join(timeout=2)
            t_err.join(timeout=2)
            exit_code = proc.returncode if proc.returncode is not None else 0
            emit_terminal_exit(
                invocation_id=iid,
                tool_call_id=tc,
                exit_code=exit_code,
                stream_writer=stream_writer,
            )
            stdout = _strip_ansi("".join(stdout_buf))
            stderr = _strip_ansi("".join(stderr_buf))
            return _format_subprocess_output(stdout, stderr, exit_code)

        if sandboxed_argv is not None:
            proc = subprocess.run(
                sandboxed_argv,
                capture_output=True,
                text=True,
                timeout=timeout,
                cwd=cwd,
                env=env,
                **run_kw,
            )
        elif use_shell:
            proc = subprocess.run(
                command,
                shell=True,
                capture_output=True,
                text=True,
                timeout=timeout,
                cwd=cwd,
                env=env,
                **run_kw,
            )
        else:
            full_cmd = [shell_cmd] + shell_args + [command]
            proc = subprocess.run(
                full_cmd,
                capture_output=True,
                text=True,
                timeout=timeout,
                cwd=cwd,
                env=env,
                **run_kw,
            )

        stdout = _strip_ansi(proc.stdout or "")
        stderr = _strip_ansi(proc.stderr or "")
        exit_code = proc.returncode if proc.returncode is not None else 0
        return _format_subprocess_output(stdout, stderr, exit_code)

    except subprocess.TimeoutExpired:
        if use_stream:
            from evoflow.tools.host_direct.terminal_stream import emit_terminal_exit

            emit_terminal_exit(
                invocation_id=iid,
                tool_call_id=tc,
                exit_code=-1,
                success=False,
                stream_writer=stream_writer,
            )
        return f"Error: Command timed out after {timeout} seconds"
    except FileNotFoundError:
        if use_stream:
            from evoflow.tools.host_direct.terminal_stream import emit_terminal_exit

            emit_terminal_exit(
                invocation_id=iid,
                tool_call_id=tc,
                exit_code=-1,
                success=False,
                stream_writer=stream_writer,
            )
        return "Error: Shell executable not found"
    except Exception as e:
        if use_stream:
            from evoflow.tools.host_direct.terminal_stream import emit_terminal_exit

            emit_terminal_exit(
                invocation_id=iid,
                tool_call_id=tc,
                exit_code=-1,
                success=False,
                stream_writer=stream_writer,
            )
        return f"Error: executing command: {e}"


def _format_result(raw: str, exit_code: int) -> str:
    """Apply output length limits and add exit code annotation."""
    stripped = _strip_ansi(raw)
    if exit_code != 0 and not stripped.strip().startswith("[exit code:"):
        stripped = stripped.rstrip() + f"\n[exit code: {exit_code}]"
    return stripped if stripped.strip() else ""


# ---------------------------------------------------------------------------
# Background process (integrates with process tool registry)
# ---------------------------------------------------------------------------


def _spawn_background(
    command: str,
    workdir: str | None,
    timeout: int,
    pty: bool,
) -> str:
    """Start a background process and return session ID."""
    from evoflow.tools.builtins.process_tool import (
        ProcessSession,
        _read_output,
        _run_command,
        register_process_session,
    )

    session_id = f"term_{uuid.uuid4().hex[:8]}"

    # Use process_tool's Popen for consistency
    proc = _run_command(command, str(workdir) if workdir else None)

    session = ProcessSession(
        id=session_id,
        command=command,
        thread_id="__terminal__",
        process=proc,
    )
    register_process_session(session, thread_id="__terminal__")

    if proc.stdout:
        t = threading.Thread(target=_read_output, args=(proc.stdout, session.stdout_buf), daemon=True)
        t.start()
        session._reader_threads.append(t)
    if proc.stderr:
        t = threading.Thread(target=_read_output, args=(proc.stderr, session.stderr_buf), daemon=True)
        t.start()
        session._reader_threads.append(t)

    return session_id


# ---------------------------------------------------------------------------
# Dangerous command patterns (safety guard)
# ---------------------------------------------------------------------------

# Long-running jobs: auto background unless caller sets background=True explicitly.
_AUTO_BACKGROUND_PATTERNS: list[re.Pattern] = [
    re.compile(r"\bnpm\s+(ci|install|run\b)", re.I),
    re.compile(r"\bpnpm\s+(install|run\b)", re.I),
    re.compile(r"\byarn\s+(install|build|run\b)", re.I),
    re.compile(r"\bdocker\s+(build|compose|pull|run\b)", re.I),
    re.compile(r"\b(make|cmake|gradle|mvn)\b", re.I),
    re.compile(r"\b(cargo\s+build|go\s+build|uv\s+sync|pip\s+install)\b", re.I),
    re.compile(r"\bpython\s+-m\s+pytest\b", re.I),
    re.compile(r"\bplaywright\s+install\b", re.I),
]

_CURL_WITHOUT_MAX_TIME = re.compile(
    r"\bcurl\b(?!.*(?:--max-time|-m)\s+\d+)",
    re.I | re.DOTALL,
)

# Foreground commands that often exceed a short model-chosen timeout (hints only).
_SLOW_FOREGROUND_PATTERNS: list[tuple[re.Pattern, str]] = [
    (re.compile(r"\bgit\s+add\b.*(-A|--all)\b|\bgit\s+add\s+-A\b", re.I), "git add -A (ensure .gitignore excludes node_modules; try timeout=60–120)"),
    (re.compile(r"\bgit\s+commit\b", re.I), "git commit (use -m \"…\"; GPG/editor prompts need long timeout or process)"),
    (re.compile(r"\bnpx\s+tsc\b|\btsc\b", re.I), "TypeScript compile"),
    (re.compile(r"\bnpm\s+install\b|\bnpm\s+ci\b", re.I), "npm install (prefer process action=start)"),
]

_DANGEROUS_PATTERNS: list[tuple[re.Pattern, str]] = [
    (re.compile(r"^\s*(rm|rmdir|del|deltree|rd)\s+(-rf?\s+)?/?(\*|\.\s*$|/|\\[\\/]?\s*$)"), "destructive_root"),
    (re.compile(r"^\s*(mkfs|fdisk|dd|format)\s"), "destructive_disk"),
    (re.compile(r"^\s*chmod\s+-R?\s*777\s+/"), "permission_risk"),
    (re.compile(r"^\s*shutdown\s+-[rh]?\s*(now|\+0)"), "system_shutdown"),
    (re.compile(r"^\s*reboot\s*$"), "system_reboot"),
    (re.compile(r"^\s*sudo\s+rm\s+-rf\s+/"), "sudo_destructive"),
    (re.compile(r"^\s*>\s*/dev/sd"), "disk_overwrite"),
    (re.compile(r"^\s*curl\s+[^\s]+\s*\|\s*(bash|sh|zsh|python)"), "pipe_curl_to_shell"),
]


def _should_auto_background(command: str, background: bool) -> bool:
    if background:
        return False
    return any(p.search(command) for p in _AUTO_BACKGROUND_PATTERNS)


def _foreground_timeout(command: str, timeout: int, *, explicit_timeout: bool) -> int:
    """Cap foreground wait at env max; optional curl probe cap only when timeout was omitted."""
    capped = min(max(1, int(timeout)), _FOREGROUND_MAX_TIMEOUT)
    if explicit_timeout:
        return capped
    if _CURL_WITHOUT_MAX_TIME.search(command):
        return min(capped, _CURL_PROBE_MAX_TIMEOUT)
    return capped


def _timeout_recovery_hint(command: str, timeout: int, *, explicit_timeout: bool) -> str:
    """Actionable hint after a foreground timeout (process vs raise timeout)."""
    cmd = str(command or "")
    slow_note = next((note for pat, note in _SLOW_FOREGROUND_PATTERNS if pat.search(cmd)), None)
    lines = [
        f"Hint: foreground wait ended after {timeout}s (terminal default when omitted: {_DEFAULT_TIMEOUT}s, max {_FOREGROUND_MAX_TIMEOUT}s).",
    ]
    if slow_note:
        lines.append(f"Slow command detected ({slow_note}).")
    if _should_auto_background(cmd, background=False):
        lines.append(
            "This looks like a long-running job — prefer **process**(action='start', background=True) + "
            "process(action='log'|'wait'|'kill') instead of terminal."
        )
    elif explicit_timeout and timeout < _DEFAULT_TIMEOUT:
        lines.append(
            f"You passed timeout={timeout}; for non-probe commands the platform default is {_DEFAULT_TIMEOUT}s — "
            f"retry with timeout={_DEFAULT_TIMEOUT}–120 or use process(action='start') when runtime is unpredictable."
        )
    else:
        lines.append(
            f"Retry with a larger timeout (e.g. {min(timeout * 2, _FOREGROUND_MAX_TIMEOUT)}) "
            "or use **process**(action='start') for scripts, test suites, dev servers, builds, and installs."
        )
    lines.append("Reserve terminal for quick one-shots: git status, env, curl -m 10, short file ops.")
    return "\n".join(lines)


def _check_dangerous(command: str) -> str | None:
    """Return warning message if *command* looks dangerous, else None."""
    for pattern, danger_id in _DANGEROUS_PATTERNS:
        if pattern.search(command):
            return f"Command blocked by safety guard ({danger_id}):\n{command[:200]}\n\nConfirmed? If YES, prepend 'force:' to your command (e.g. 'force: rm -rf dir/')."
    return None


# ---------------------------------------------------------------------------
# The Tool
# ---------------------------------------------------------------------------

@tool("terminal", description=TERMINAL_TOOL_DESCRIPTION, parse_docstring=False)
def terminal_tool(
    command: str,
    *,
    background: bool = False,
    timeout: int | None = None,
    workdir: Annotated[
        str | None,
        Field(
            default=None,
            description="skill:<name> or workspace cwd.",
        ),
    ] = None,
    pty: bool = False,
    new_session: bool = False,
    tool_call_id: Annotated[str, InjectedToolCallId],
    runtime: ToolRuntime,
) -> str:
    """Execute a shell command on the host."""
    # ── Safety check ──────────────────────────────────────────────────
    effective_command = command
    force_mode = False
    if command.startswith("force:"):
        effective_command = command[len("force:") :].lstrip()
        force_mode = True

    if not force_mode:
        warning = _check_dangerous(effective_command)
        if warning:
            return warning

    from evoflow.exploration.exploration_budget import check_tool_budget, is_unbounded_recurse_command

    if is_unbounded_recurse_command(effective_command):
        return (
            "Error: Unbounded filesystem scan blocked. "
            "Use find(pattern, root='<subdir>') or rg with a scoped path."
        )

    thread_id = None
    if runtime is not None and getattr(runtime, "context", None):
        thread_id = str(runtime.context.get("thread_id") or "").strip() or None
    if thread_id:
        blocked = check_tool_budget(thread_id, "terminal", {"command": effective_command})
        if blocked:
            return blocked

    try:
        from evoflow.community.media_generation.config_helpers import ensure_media_credentials

        ensure_media_credentials()
    except Exception:
        pass

    from evoflow.tools.host_direct.skill_command_paths import rewrite_skill_paths_in_command
    from evoflow.tools.host_direct.terminal_code_search_redirect import try_terminal_code_search_redirect

    code_search_redirect = try_terminal_code_search_redirect(command=effective_command, runtime=runtime)
    if code_search_redirect:
        return code_search_redirect

    effective_command = rewrite_skill_paths_in_command(effective_command)

    # ── Resolve working directory (workspace root or skill:<name>) ─────
    cwd_resolved = resolve_tool_workdir(workdir, runtime=runtime)
    if isinstance(cwd_resolved, str):
        return cwd_resolved
    cwd = cwd_resolved

    explicit_timeout = timeout is not None
    effective_timeout_arg = int(timeout) if explicit_timeout else _DEFAULT_TIMEOUT

    if not background and _should_auto_background(effective_command, background=False):
        return (
            "Error: Long-running command must use process(action='start'), not terminal.\n"
            "Use process(action='start', command=..., background=True) + process(action='log'|'wait'|'kill', session_id=...).\n"
            f"Command: {effective_command[:200]}"
        )

    run_background = bool(background)

    # ── Background mode ────────────────────────────────────────────────
    if run_background:
        bg_timeout = max(effective_timeout_arg, _DEFAULT_TIMEOUT)
        try:
            session_id = _spawn_background(effective_command, str(cwd), bg_timeout, pty)
            prefix = "Background process started.\n"
            return (
                f"{prefix}"
                f"Command: {effective_command}\n"
                f"Session ID: {session_id}\n\n"
                f"Use:\n"
                f'  process(action="log", session_id="{session_id}", tail=50) — status + output\n'
                f'  process(action="wait", session_id="{session_id}", timeout={bg_timeout}) — wait for completion\n'
                f'  process(action="kill", session_id="{session_id}") — terminate'
            )
        except Exception as e:
            return f"Error starting background process: {e}"

    # ── Foreground mode ────────────────────────────────────────────────
    effective_timeout = _foreground_timeout(
        effective_command,
        effective_timeout_arg,
        explicit_timeout=explicit_timeout,
    )
    from evoflow.tools.host_direct.terminal_stream import capture_stream_writer

    stream_writer = capture_stream_writer()
    invocation_id = uuid.uuid4().hex[:12]
    use_persistent = False

    if use_persistent:
        from evoflow.tools.host_direct.terminal_session import run_in_persistent_session

        result = run_in_persistent_session(
            runtime=runtime,
            command=effective_command,
            cwd=cwd,
            timeout=effective_timeout,
            invocation_id=invocation_id,
            tool_call_id=tool_call_id,
            stream_writer=stream_writer,
            new_session=bool(new_session),
            workdir_explicit=workdir is not None,
        )
    else:
        result = _run_subprocess(
            effective_command,
            cwd,
            effective_timeout,
            pty=pty,
            invocation_id=invocation_id,
            tool_call_id=tool_call_id,
            stream_writer=stream_writer,
        )
    if "timed out" in result.lower():
        if (
            _CURL_WITHOUT_MAX_TIME.search(effective_command)
            and not explicit_timeout
            and effective_timeout <= _CURL_PROBE_MAX_TIMEOUT
        ):
            result += (
                "\n\nHint: curl without -m/--max-time may hang on unreachable hosts. "
                "Retry with e.g. `curl -m 10 -I <url>` or use process(action='start') for long-running commands."
            )
        else:
            result += "\n\n" + _timeout_recovery_hint(
                effective_command,
                effective_timeout,
                explicit_timeout=explicit_timeout,
            )
    return result


