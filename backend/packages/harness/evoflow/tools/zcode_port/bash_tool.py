"""Bash tool — ZCode shell execution with embedded-search prelude and background tasks.

Source: ZCode packages/contracts/src/tools/bash.ts
        ZCode packages/core/src/tool/handlers/bash.ts (execution surface used by EvoFlow)
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
import threading
import uuid
from pathlib import Path
from typing import Annotated

from langchain.tools import InjectedToolCallId, ToolRuntime, tool
from langgraph.types import Command

from evoflow.agents.image_staging import command_with_staged_images, stage_image_entry
from evoflow.tools.zcode_port.background import BackgroundBashTask, mark, new_task_id, register_task
from evoflow.tools.zcode_port.capability import resolve_embedded_search_branch_capability
from evoflow.tools.zcode_port.prelude import BASH_DESCRIPTION, BASH_DESCRIPTION_DIRECT, build_embedded_search_prelude

MAX_BASH_TIMEOUT_MS = 600_000
DEFAULT_TIMEOUT_MS = 120_000
# Soft cap when the model omits timeout on short read-only probes (git status/log, ls, …).
# Without this, a hung Git Bash child can sit until the 120s kill path — and on Windows
# that kill path itself used to deadlock in communicate() for minutes.
PROBE_TIMEOUT_MS = int(os.getenv("EVOFLOW_BASH_PROBE_TIMEOUT_MS", "30000"))
# ZCode bash.ts resultBudget: inline cap 30KB; once persisted, model sees a 2KB preview.
MAX_INLINE_BYTES = 30_000
MODEL_PREVIEW_CHARS = 2_000
# ZCode bash-model-content.ts: assistant turns must not block on a foreground shell.
ASSISTANT_BLOCKING_BUDGET_MS = 15_000
# ZCode bash.ts metadata.concurrentSafe = false
_BASH_EXEC_LOCK = threading.Lock()

_TRUE = {"true", "1", "yes", "y", "on"}
_FALSE = {"false", "0", "no", "n", "off"}

# ZCode: working directory persists between Bash calls (per thread).
_PERSISTED_CWD: dict[str, str] = {}
_PERSISTED_CWD_LOCK = threading.Lock()
_PWD_MARKER = "__EVOFLOW_PWD__="

# Compound `cd … && <probe>` still counts as a probe for soft-timeout purposes.
_PROBE_COMMAND_RE = re.compile(
    r"(?is)^\s*(?:(?:cd|Set-Location)\s+[^\n;&|]+(?:\s*&&\s*|\s*;\s*))*"
    r"(?:"
    r"git\s+(?:-C\s+\S+\s+)?(?:status|log|diff|branch|rev-parse|show|remote|tag)\b"
    r"|ls\b|dir\b|pwd\b|echo\b|true\b|false\b|whoami\b|uname\b"
    r")\b"
)


def _semantic_bool(value: object, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)) and value in (0, 1):
        return bool(value)
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in _TRUE:
            return True
        if normalized in _FALSE:
            return False
    return default


def _timeout_was_explicit(value: object) -> bool:
    if value is None or value == "":
        return False
    try:
        int(float(str(value).strip()))
    except ValueError:
        return False
    return True


def _semantic_timeout(value: object) -> int:
    if value is None or value == "":
        return DEFAULT_TIMEOUT_MS
    try:
        parsed = int(float(str(value).strip()))
    except ValueError:
        return DEFAULT_TIMEOUT_MS
    return max(1, min(parsed, MAX_BASH_TIMEOUT_MS))


def _effective_timeout_ms(command: str, timeout_ms: int, *, explicit: bool) -> int:
    if explicit:
        return timeout_ms
    if _PROBE_COMMAND_RE.search(str(command or "").strip()):
        return min(timeout_ms, max(1, PROBE_TIMEOUT_MS))
    return timeout_ms


def _blocking_budget_ms(timeout_ms: int, *, explicit: bool) -> int:
    """Honor an explicit timeout. Otherwise stop blocking the turn at 15s."""
    if explicit:
        return timeout_ms
    return min(timeout_ms, ASSISTANT_BLOCKING_BUDGET_MS)


# ZCode bash-read-file-state.ts: only surface stale reads after a mutating command.
_WRITE_COMMAND_RE = re.compile(
    r"(?i)(?:--write|--fix|--in-place|--auto-correct|\bsed\s+-i\b|"
    r"\brun\s+format\b|\brun\s+fix\b|\b(?:yarn|pnpm)\s+format\b|"
    r"\blint:file\b|\blint:fix\b|\bblack\b|\bisort\b|\bruff\s+format\b|"
    r"\bcargo\s+(?:fmt|fix)\b|\brustfmt\b|\bgo\s+fmt\b|\bterraform\s+fmt\b)"
)


def _utf8_len(text: str) -> int:
    return len((text or "").encode("utf-8", errors="replace"))


def _format_byte_size(nbytes: int) -> str:
    if nbytes < 1024:
        return f"{nbytes} bytes"
    kb = nbytes / 1024
    if kb < 1024:
        return f"{kb:.1f}".replace(".0", "") + "KB"
    return f"{kb / 1024:.1f}".replace(".0", "") + "MB"


def _preview_first(content: str, max_chars: int) -> tuple[str, bool]:
    if len(content) <= max_chars:
        return content, False
    newline = content.rfind("\n", 0, max_chars)
    end = newline if newline > max_chars * 0.5 else max_chars
    return content[:end], True


def _persisted_output_envelope(content: str, path: Path) -> str:
    """ZCode ``<persisted-output>``: full bytes on disk, short preview for the model."""
    preview, has_more = _preview_first(content, MODEL_PREVIEW_CHARS)
    lines = [
        "<persisted-output>",
        f"Output too large ({_format_byte_size(_utf8_len(content))}). Full output saved to: {path}",
        "",
        f"Preview (first {_format_byte_size(MODEL_PREVIEW_CHARS)}):",
        preview,
    ]
    if has_more:
        lines.append("...")
    lines.append("</persisted-output>")
    return "\n".join(lines)


def _model_stream(text: str) -> tuple[str, bool]:
    raw = text or ""
    if _utf8_len(raw) <= MAX_INLINE_BYTES:
        return raw, False
    path = _output_file(new_task_id())
    path.write_text(raw, encoding="utf-8", errors="replace")
    return _persisted_output_envelope(raw, path), True


def _kill_process_tree(pid: int) -> None:
    """Best-effort kill of *pid* and descendants.

    Git Bash spawns ``git.exe`` children. On Windows, ``Popen.kill()`` only stops the
    shell; children keep stdout pipes open and ``communicate()`` hangs past timeout.
    """
    if pid <= 0:
        return
    if sys.platform == "win32":
        try:
            subprocess.run(
                ["taskkill", "/PID", str(pid), "/F", "/T"],
                capture_output=True,
                timeout=8,
                **_no_window(),
            )
        except Exception:
            try:
                os.kill(pid, 9)
            except OSError:
                pass
        return
    try:
        os.killpg(pid, 9)
    except OSError:
        try:
            os.kill(pid, 9)
        except OSError:
            pass


def bash_shell() -> list[str] | None:
    """Prefer a real POSIX bash so the embedded-search function prelude can run.

    The WindowsApps ``bash.exe`` stub is not a shell; Git's ``bin/bash.exe`` is.
    """
    candidates: list[Path] = []
    found = shutil.which("bash")
    if found and "WindowsApps" not in found.replace("/", "\\"):
        candidates.append(Path(found))
    git = shutil.which("git")
    if git:
        git_path = Path(git).resolve()
        candidates.append(git_path.parent.parent / "bin" / "bash.exe")
        candidates.append(git_path.parent / "bash.exe")
    for env_key in ("ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"):
        root = os.environ.get(env_key)
        if not root:
            continue
        base = Path(root) / ("Programs" if env_key == "LOCALAPPDATA" else "")
        candidates.append(base / "Git" / "bin" / "bash.exe")
    for path in candidates:
        if path.is_file():
            return [str(path)]
    return None


def embedded_search_enabled() -> bool:
    return resolve_embedded_search_branch_capability(bash_available=bash_shell() is not None)


def _workspace_root(runtime: ToolRuntime | None) -> str:
    from evoflow.tools.host_direct.workspace_path_guard import resolve_search_workspace_root

    resolved = resolve_search_workspace_root(runtime=runtime)
    if isinstance(resolved, tuple):
        return resolved[0]
    return os.getcwd()


def _cwd(runtime: ToolRuntime | None) -> str:
    tid = _thread_id(runtime)
    if tid:
        with _PERSISTED_CWD_LOCK:
            persisted = _PERSISTED_CWD.get(tid)
        if persisted and Path(persisted).is_dir():
            return persisted
    return _workspace_root(runtime)


def _remember_cwd(thread_id: str, cwd: str) -> None:
    tid = str(thread_id or "").strip()
    path = str(cwd or "").strip()
    if not tid or not path or not Path(path).is_dir():
        return
    with _PERSISTED_CWD_LOCK:
        _PERSISTED_CWD[tid] = path


def _no_window() -> dict:
    if sys.platform == "win32":
        return {"creationflags": subprocess.CREATE_NO_WINDOW}
    return {}


def _popen_kwargs() -> dict:
    """Spawn kwargs that avoid stdin waits and enable process-group kill on timeout."""
    kw: dict = {
        "stdin": subprocess.DEVNULL,
        "stdout": subprocess.PIPE,
        "stderr": subprocess.PIPE,
        "text": True,
        "encoding": "utf-8",
        "errors": "replace",
    }
    if sys.platform == "win32":
        flags = subprocess.CREATE_NO_WINDOW
        if hasattr(subprocess, "CREATE_NEW_PROCESS_GROUP"):
            flags |= subprocess.CREATE_NEW_PROCESS_GROUP
        kw["creationflags"] = flags
    else:
        kw["start_new_session"] = True
    return kw


def _to_posix(path: str) -> str:
    from evoflow.utils.bundled_tools import to_bash_posix_path

    return to_bash_posix_path(path)


def _embedded_runtime_exports() -> tuple[str, str, str, str, bool]:
    """Return (path_exports, find_cmd, grep_cmd, rg_cmd, wrap_find)."""
    try:
        from evoflow.utils.bundled_tools import (
            bundled_bfs_binary,
            bundled_ripgrep_binary,
            bundled_ugrep_binary,
        )
    except Exception:
        return "", "bfs", "ugrep", "rg", sys.platform != "win32"

    path_dirs: list[str] = []
    find_cmd = "bfs"
    grep_cmd = "ugrep"
    rg_cmd = "rg"
    bfs = bundled_bfs_binary()
    ugrep = bundled_ugrep_binary()
    rg = bundled_ripgrep_binary()
    if bfs:
        find_cmd = _to_posix(bfs)
        path_dirs.append(find_cmd.rsplit("/", 1)[0])
    if ugrep:
        grep_cmd = _to_posix(ugrep)
        path_dirs.append(grep_cmd.rsplit("/", 1)[0])
    if rg:
        rg_cmd = _to_posix(rg)
        path_dirs.append(rg_cmd.rsplit("/", 1)[0])
    # ZCode: Windows does not wrap find unless bfs is actually present.
    wrap_find = bool(bfs) if sys.platform == "win32" else True
    exports = ""
    if path_dirs:
        uniq = []
        for d in path_dirs:
            if d and d not in uniq:
                uniq.append(d)
        exports = "export PATH=\"" + ":".join(uniq) + ":$PATH\"\n"
    return exports, find_cmd, grep_cmd, rg_cmd, wrap_find


def _wrap_with_cwd_and_pwd(command: str, cwd: str) -> str:
    """cd into persisted cwd, run command, echo cwd for the next call (ZCode persist)."""
    posix_cwd = _to_posix(cwd)
    return (
        f'cd "{posix_cwd}" || exit 1\n'
        f"{command}\n"
        f'_ef_ec=$?\n'
        f'printf "\\n{_PWD_MARKER}%s\\n" "$(pwd)"\n'
        f"exit $_ef_ec\n"
    )


def _strip_pwd_marker(text: str, thread_id: str) -> str:
    if _PWD_MARKER not in text:
        return text
    lines = text.splitlines()
    kept: list[str] = []
    for line in lines:
        if line.startswith(_PWD_MARKER):
            _remember_cwd(thread_id, line[len(_PWD_MARKER) :])
            continue
        kept.append(line)
    return "\n".join(kept)


# PowerShell cmdlets have no meaning inside Git Bash. Routing them through
# ``bash -lc`` pays a login-shell startup (profile, often several seconds on Windows)
# and then fails to find the cmdlet.
_POWERSHELL_CMDLET_RE = re.compile(
    r"(?i)(?:^|[;&|\n]\s*)(?:"
    r"Select-String|Get-ChildItem|Get-Content|Get-Item|Set-Content|Set-Location|"
    r"Out-File|ForEach-Object|Where-Object|Measure-Object|Test-Path|"
    r"Copy-Item|Move-Item|Remove-Item|New-Item|Invoke-WebRequest|Invoke-RestMethod|"
    r"ConvertFrom-Json|ConvertTo-Json|sls|gci|gc|gi"
    r")\b"
)


def _powershell_executable() -> str:
    found = shutil.which("powershell") or shutil.which("powershell.exe")
    return found or "powershell"


def _powershell_argv(command: str, cwd: str) -> list[str] | None:
    """Run an obvious PowerShell script without Git Bash and without a user profile."""
    if sys.platform != "win32":
        return None
    stripped = command.strip()
    if not stripped or not _POWERSHELL_CMDLET_RE.search(stripped):
        return None
    if re.match(r"(?i)^(powershell|pwsh)(\.exe)?\b", stripped):
        return None
    safe_cwd = cwd.replace("'", "''")
    body = (
        f"Set-Location -LiteralPath '{safe_cwd}'; "
        f"{stripped}; "
        f"Write-Output ('{_PWD_MARKER}' + (Get-Location).Path)"
    )
    return [_powershell_executable(), "-NoProfile", "-NonInteractive", "-Command", body]


def _bash_args(shell: list[str], script: str) -> list[str]:
    # ``-l`` sources .bash_profile / /etc/profile. On Windows Git Bash that startup
    # is the multi-second delay before the command itself runs. The embedded-search
    # functions are already inlined in ``script``, so a login shell is not required.
    return [*shell, "--noprofile", "--norc", "-c", script]


def _script(command: str, *, cwd: str) -> tuple[list[str], str]:
    ps = _powershell_argv(command, cwd)
    if ps is not None:
        return ps, "powershell"
    shell = bash_shell()
    body = _wrap_with_cwd_and_pwd(command, cwd)
    if shell and embedded_search_enabled():
        exports, find_cmd, grep_cmd, rg_cmd, wrap_find = _embedded_runtime_exports()
        prelude = exports + build_embedded_search_prelude(
            find_command=find_cmd,
            grep_command=grep_cmd,
            rg_command=rg_cmd,
            wrap_find=wrap_find,
        )
        return _bash_args(shell, prelude + body), "bash"
    if shell:
        return _bash_args(shell, body), "bash"
    if sys.platform == "win32":
        return ["powershell", "-NoProfile", "-NonInteractive", "-Command", f"Set-Location -LiteralPath '{cwd}'; {command}"], "powershell"
    return ["sh", "-c", body], "sh"


def _emit(kind: str, **kwargs: object) -> None:
    from evoflow.tools.host_direct.terminal_stream import (
        emit_background_work,
        emit_terminal_exit,
        emit_terminal_start,
        emit_terminal_stderr,
        emit_terminal_stdout,
    )

    fn = {
        "start": emit_terminal_start,
        "stdout": emit_terminal_stdout,
        "stderr": emit_terminal_stderr,
        "exit": emit_terminal_exit,
        "background": emit_background_work,
    }[kind]
    try:
        fn(**kwargs)  # type: ignore[arg-type]
    except Exception:
        return


def _thread_id(runtime: ToolRuntime | None) -> str:
    if runtime is None or getattr(runtime, "context", None) is None:
        return ""
    ctx = runtime.context
    return str(ctx.get("thread_id") or "").strip()


def _session_key(runtime: ToolRuntime | None) -> str:
    if runtime is None or getattr(runtime, "context", None) is None:
        return ""
    ctx = runtime.context
    return str(ctx.get("session_key") or "").strip()


def _output_file(task_id: str) -> Path:
    root = Path(os.environ.get("TEMP") or os.environ.get("TMP") or "/tmp") / "evoflow-bash-tasks"
    root.mkdir(parents=True, exist_ok=True)
    return root / f"{task_id}.output"


def _emit_task_notification(task: BackgroundBashTask) -> None:
    if task.notification_sent or not task.thread_id:
        return
    task.notification_sent = True
    from evoflow.tools.zcode_port.notify_continuation import schedule_bash_task_notification_turn
    from evoflow.tools.zcode_port.task_notification import (
        build_bash_task_summary,
        format_local_bash_task_notification,
        normalize_bash_notification_status,
    )

    status = normalize_bash_notification_status(task.status)
    summary = build_bash_task_summary(
        command=task.command,
        description=task.description,
        exit_code=task.exit_code,
        status=status,
    )
    text = format_local_bash_task_notification(
        task_id=task.task_id,
        status=status,
        summary=summary,
        output_file=str(task.output_path),
        tool_use_id=task.tool_call_id or None,
    )
    schedule_bash_task_notification_turn(
        thread_id=task.thread_id,
        session_key=task.session_key,
        notification_text=text,
        task_id=task.task_id,
    )


def _stale_hint_for(command: str) -> str:
    if not _WRITE_COMMAND_RE.search(command or ""):
        return ""
    from evoflow.tools.zcode_port.read_file_state import stale_read_hint

    return stale_read_hint()


def _format_finished(
    *,
    command: str,
    stdout: str,
    stderr: str,
    exit_code: int,
    timed_out: bool,
) -> str:
    out, out_tr = _model_stream(stdout)
    err, err_tr = _model_stream(stderr)
    hint = _stale_hint_for(command)
    hint_block = f"\n{hint}" if hint else ""
    if timed_out:
        return f"status: timed_out\ninterrupted: true\nstdout:\n{out}\nstderr:\n{err}{hint_block}"
    status = "completed" if exit_code == 0 else "failed"
    return (
        f"status: {status}\nexitCode: {exit_code}\ninterrupted: false\n"
        f"stdoutTruncated: {str(out_tr).lower()}\nstderrTruncated: {str(err_tr).lower()}\n"
        f"stdout:\n{out}\nstderr:\n{err}{hint_block}"
    )


def _promote_to_background(
    proc: subprocess.Popen,
    *,
    command: str,
    cwd: str,
    tool_call_id: str,
    description: str,
    thread_id: str,
    session_key: str,
    partial_stdout: str,
    partial_stderr: str,
) -> str:
    """Keep a still-running foreground command alive and return immediately."""
    del cwd
    task_id = new_task_id()
    output_path = _output_file(task_id)
    stream_id = (tool_call_id or "").strip() or task_id
    partial_stdout = _strip_pwd_marker(partial_stdout or "", thread_id)
    chunks = [partial_stdout]
    if partial_stderr:
        chunks.append(f"\n[stderr]\n{partial_stderr}")
    output_path.write_text("".join(chunks), encoding="utf-8", errors="replace")
    task = BackgroundBashTask(
        task_id=task_id,
        command=command,
        description=description or command[:80],
        output_path=output_path,
        proc=proc,
        tool_call_id=stream_id,
        thread_id=thread_id,
        session_key=session_key,
    )
    register_task(task)
    started_ms = int(task.started_at * 1000)
    _emit(
        "background",
        work_id=task_id,
        title=description or command[:80],
        command=command,
        tool_call_id=stream_id,
        status="running",
        started_at_ms=started_ms,
    )

    def _pump() -> None:
        try:
            rest_out, rest_err = proc.communicate()
        except Exception:
            rest_out, rest_err = "", ""
        rest_out = _strip_pwd_marker(rest_out or "", thread_id)
        if rest_out:
            _emit("stdout", invocation_id=stream_id, tool_call_id=stream_id, text=rest_out)
            chunks.append(rest_out)
        if rest_err:
            _emit("stderr", invocation_id=stream_id, tool_call_id=stream_id, text=rest_err)
            chunks.append(f"\n[stderr]\n{rest_err}")
        output_path.write_text("".join(chunks), encoding="utf-8", errors="replace")
        code = proc.returncode if proc.returncode is not None else 0
        if task.status == "running":
            mark(task, status="completed" if code == 0 else "failed", exit_code=code)
        _emit("exit", invocation_id=stream_id, tool_call_id=stream_id, exit_code=code, success=code == 0)
        _emit(
            "background",
            work_id=task_id,
            title=description or command[:80],
            command=command,
            tool_call_id=stream_id,
            status=task.status if task.status != "stopped" else "cancelled",
            started_at_ms=started_ms,
        )
        _emit_task_notification(task)

    threading.Thread(target=_pump, name=f"bash-bg-{task_id}", daemon=True).start()
    seconds = ASSISTANT_BLOCKING_BUDGET_MS // 1000
    return (
        f"status: backgrounded\ninterrupted: false\nbackgroundTaskId: {task_id}\n"
        f"persistedOutputPath: {output_path}\n"
        f"Command exceeded the assistant-mode blocking budget ({seconds}s) and was moved to the "
        f"background with ID: {task_id}. It is still running — you will be notified when it completes. "
        f"Output is being written to: {output_path}. To check interim output, use Read on that file path."
    )


def _run_foreground(
    command: str,
    timeout_ms: int,
    cwd: str,
    tool_call_id: str,
    *,
    thread_id: str = "",
    explicit: bool = False,
    description: str = "",
    session_key: str = "",
) -> str:
    argv, _dialect = _script(command, cwd=cwd)
    invocation = tool_call_id or uuid.uuid4().hex
    blocking_ms = _blocking_budget_ms(timeout_ms, explicit=explicit)
    # CreateProcess requires a Windows path. Git Bash accepts that cwd and converts it.
    _emit("start", invocation_id=invocation, tool_call_id=tool_call_id, command=command)
    try:
        proc = subprocess.Popen(argv, cwd=cwd, **_popen_kwargs())
    except OSError as exc:
        _emit("exit", invocation_id=invocation, tool_call_id=tool_call_id, exit_code=127, success=False)
        return f"status: spawn_error\ninterrupted: false\nstderr:\n{exc}"

    timed_out = False
    stdout = ""
    stderr = ""
    try:
        stdout, stderr = proc.communicate(timeout=blocking_ms / 1000.0)
    except subprocess.TimeoutExpired as exc:
        if blocking_ms < timeout_ms:
            return _promote_to_background(
                proc,
                command=command,
                cwd=cwd,
                tool_call_id=tool_call_id,
                description=description,
                thread_id=thread_id,
                session_key=session_key,
                partial_stdout=exc.stdout if isinstance(exc.stdout, str) else "",
                partial_stderr=exc.stderr if isinstance(exc.stderr, str) else "",
            )
        timed_out = True
        _kill_process_tree(proc.pid)
        try:
            leftover = proc.communicate(timeout=2.0)
            stdout = leftover[0] or ""
            stderr = leftover[1] or ""
        except Exception:
            try:
                proc.kill()
            except OSError:
                pass
            try:
                leftover = proc.communicate(timeout=1.0)
                stdout = leftover[0] or ""
                stderr = leftover[1] or ""
            except Exception:
                stdout, stderr = "", ""

    if timed_out:
        _emit("stdout", invocation_id=invocation, tool_call_id=tool_call_id, text=stdout)
        _emit("stderr", invocation_id=invocation, tool_call_id=tool_call_id, text=stderr)
        _emit("exit", invocation_id=invocation, tool_call_id=tool_call_id, exit_code=124, success=False)
        return _format_finished(command=command, stdout=stdout, stderr=stderr, exit_code=124, timed_out=True)

    stdout = _strip_pwd_marker(stdout or "", thread_id)
    stderr = stderr or ""
    exit_code = proc.returncode if proc.returncode is not None else 0
    _emit("stdout", invocation_id=invocation, tool_call_id=tool_call_id, text=stdout)
    _emit("stderr", invocation_id=invocation, tool_call_id=tool_call_id, text=stderr)
    _emit("exit", invocation_id=invocation, tool_call_id=tool_call_id, exit_code=exit_code, success=exit_code == 0)
    return _format_finished(
        command=command,
        stdout=stdout,
        stderr=stderr,
        exit_code=exit_code,
        timed_out=False,
    )


def _run_background(
    command: str,
    cwd: str,
    tool_call_id: str,
    description: str,
    *,
    thread_id: str = "",
    session_key: str = "",
) -> str:
    argv, _dialect = _script(command, cwd=cwd)
    task_id = new_task_id()
    output_path = _output_file(task_id)
    # Prefer LangChain tool_call_id so chat cards and the status panel share one key;
    # fall back to workId when the host did not inject one.
    stream_id = (tool_call_id or "").strip() or task_id
    invocation = stream_id
    try:
        bg_kw = _popen_kwargs()
        # Merge stderr into stdout for background pump (single reader).
        bg_kw["stderr"] = subprocess.STDOUT
        proc = subprocess.Popen(argv, cwd=cwd, **bg_kw)
    except OSError as exc:
        return f"status: spawn_error\ninterrupted: false\nstderr:\n{exc}"
    task = BackgroundBashTask(
        task_id=task_id,
        command=command,
        description=description,
        output_path=output_path,
        proc=proc,
        tool_call_id=stream_id,
        thread_id=thread_id,
        session_key=session_key,
    )
    register_task(task)
    started_ms = int(task.started_at * 1000)
    _emit("start", invocation_id=invocation, tool_call_id=stream_id, command=command)
    _emit(
        "background",
        work_id=task_id,
        title=description or command[:80],
        command=command,
        tool_call_id=stream_id,
        status="running",
        started_at_ms=started_ms,
    )

    def _pump() -> None:
        chunks: list[str] = []
        assert proc.stdout is not None
        for line in proc.stdout:
            if line.startswith(_PWD_MARKER):
                _strip_pwd_marker(line, thread_id)
                continue
            chunks.append(line)
            _emit("stdout", invocation_id=invocation, tool_call_id=stream_id, text=line)
        code = proc.wait()
        text = _strip_pwd_marker("".join(chunks), thread_id)
        output_path.write_text(text, encoding="utf-8", errors="replace")
        # TaskStop may have already marked cancelled.
        if task.status == "running":
            mark(task, status="completed" if code == 0 else "failed", exit_code=code)
        _emit("exit", invocation_id=invocation, tool_call_id=stream_id, exit_code=code, success=code == 0)
        _emit(
            "background",
            work_id=task_id,
            title=description or command[:80],
            command=command,
            tool_call_id=stream_id,
            status=task.status if task.status != "stopped" else "cancelled",
            started_at_ms=started_ms,
        )
        _emit_task_notification(task)

    threading.Thread(target=_pump, name=f"bash-bg-{task_id}", daemon=True).start()
    return (
        f"status: backgrounded\ninterrupted: false\nbackgroundTaskId: {task_id}\n"
        f"persistedOutputPath: {output_path}\n"
        "Command is running in the background. Prefer Read on persistedOutputPath; "
        "TaskOutput can poll this task_id; TaskStop stops it."
    )


def bash_provider_description() -> str:
    if embedded_search_enabled():
        return BASH_DESCRIPTION
    return BASH_DESCRIPTION_DIRECT


_AGENT_BROWSER_SCREENSHOT_RE = re.compile(
    r"\bagent-browser\b[^;&|]*?\bscreenshot\s+(\"[^\"]+\"|'[^']+'|[^\s;&|]+)",
    re.IGNORECASE,
)
_SCREENSHOT_MIME_BY_SUFFIX = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
}


def _resolve_screenshot_path(raw: str, cwd: str) -> Path | None:
    path_text = str(raw or "").strip().strip("\"'")
    if not path_text:
        return None
    path = Path(path_text).expanduser()
    if not path.is_absolute():
        path = Path(cwd) / path
    try:
        if path.is_file() and path.stat().st_size > 0:
            return path
    except OSError:
        return None
    return None


def _maybe_stage_agent_browser_screenshot(
    runtime: object, command: str, cwd: str, tool_call_id: str, result: str
) -> str | Command:
    """agent-browser screenshot → 像素自动进下一次模型上下文（对齐 ZCode）。

    命中 ``agent-browser … screenshot <path>`` 且文件真实落盘时，把图 stage 成
    ``viewed_images`` auto 条目（path-only），ViewImageMiddleware 在下一次模型
    调用前按 200KB base64 预算压缩注入。文件不存在 / 模型无视觉 / text 路由时
    不 stage，行为与之前完全一致。
    """
    lowered = command.lower()
    if "agent-browser" not in lowered or "screenshot" not in lowered:
        return result
    for raw in _AGENT_BROWSER_SCREENSHOT_RE.findall(command):
        path = _resolve_screenshot_path(raw, cwd)
        if path is None:
            continue
        staged = stage_image_entry(
            runtime=runtime,
            path=str(path),
            mime_type=_SCREENSHOT_MIME_BY_SUFFIX.get(path.suffix.lower(), "image/png"),
            label="browser screenshot",
        )
        if not staged:
            return result
        # 不把磁盘 path 写进工具结果，避免模型抄成「截图文件：@@…png@@」→ [Image blocked]。
        result = (
            f"{result}\n\n[agent-browser screenshot captured — already shown on the tool card "
            f"and staged for your next context; you will see the pixels. "
            f"Do not mention the file path, filename, or @@...png@@ in your reply. "
            f"Do NOT call view_image.]"
        )
        return command_with_staged_images(result, tool_call_id, {staged["path"]: staged})
    return result


@tool("bash", description=BASH_DESCRIPTION, parse_docstring=False)
def bash_tool(
    command: str,
    timeout: int | str | None = None,
    description: str | None = None,
    run_in_background: bool | str | None = None,
    dangerouslyDisableSandbox: bool | str | None = None,
    tool_call_id: Annotated[str, InjectedToolCallId] = "",
    runtime: ToolRuntime = None,
) -> str | Command:
    """Executes a bash command and returns its output.

    timeout: Optional timeout in milliseconds (max 600000).
    description: Clear, concise description of what this command does in active voice.
    run_in_background: Set to true to run this command in the background.
    dangerouslyDisableSandbox: Set this to true to dangerously override sandbox mode and run commands without sandboxing.
    """
    del dangerouslyDisableSandbox  # EvoFlow host-direct already runs on the host; flag is accepted for schema parity.
    cwd = _cwd(runtime)
    try:
        from evoflow.tools.host_direct.skill_command_paths import rewrite_skill_paths_in_command

        command = rewrite_skill_paths_in_command(command)
    except Exception:
        pass
    explicit = _timeout_was_explicit(timeout)
    timeout_ms = _effective_timeout_ms(command, _semantic_timeout(timeout), explicit=explicit)
    tid = _thread_id(runtime)
    sk = _session_key(runtime)
    desc = description or command[:80]
    # ZCode Bash is not concurrent-safe: one shell at a time per process.
    with _BASH_EXEC_LOCK:
        if _semantic_bool(run_in_background):
            return _run_background(command, cwd, tool_call_id, desc, thread_id=tid, session_key=sk)
        result = _run_foreground(
            command,
            timeout_ms,
            cwd,
            tool_call_id,
            thread_id=tid,
            explicit=explicit,
            description=desc,
            session_key=sk,
        )
    return _maybe_stage_agent_browser_screenshot(runtime, command, cwd, tool_call_id, result)
