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
import time
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
# EvoFlow multi-agent reality (2026-11-07 prod data): an explicit timeout let
# builds (`pnpm install`, `npm run build`) park the thread channel in the
# foreground for up to 10 minutes — parallel tool calls of the same turn queued
# behind it, and 42% of >10s bash rows in observability were pure queue wait.
# An explicit timeout therefore only buys foreground time up to this ceiling;
# beyond it the command is promoted to background and the turn continues on the
# completion notification.
FOREGROUND_BLOCKING_CEILING_MS = int(os.getenv("EVOFLOW_BASH_FOREGROUND_CEILING_MS", "60000"))
# ZCode bash.ts metadata.concurrentSafe = false
#
# Execution channels are PER-THREAD + a process-wide concurrency cap.
# History: the original single process-global lock (ZCode interactive model:
# one user, one assistant, sequential commands) serialized EVERY bash call —
# in EvoFlow's multi-agent process a main conversation holding an explicit-
# timeout `sleep 50` parked the only slot and blocked all parallel workflow
# workers (observed 2026-10-25: trivial worker `ls` queued 40–55s behind
# main-chat sleeps). Commands are independent Popen processes and CWD
# persistence is already keyed per thread, so per-thread locks plus a
# semaphore cap restore parallelism safely.
_EXEC_LOCKS: dict[str, threading.Lock] = {}
_EXEC_LOCKS_GUARD = threading.Lock()
_EXEC_LOCKS_MAX = 1024


def _bash_max_concurrent() -> int:
    # 4, not 8: prod data (2026-11-07) showed 5+ concurrent builds/install
    # saturating the desktop (git status 0.07s idle → 28s under load, Defender
    # + node_modules IO amplification). Builds beyond the cap queue briefly
    # instead of degrading every other agent's shell.
    raw = (os.getenv("EVOFLOW_BASH_MAX_CONCURRENT") or "4").strip()
    try:
        return max(1, int(raw))
    except ValueError:
        return 4


_BASH_CONCURRENCY = threading.Semaphore(_bash_max_concurrent())


class _bash_concurrency_slot:
    """Process-wide cap on simultaneously running bash processes."""

    def __enter__(self) -> "_bash_concurrency_slot":
        _BASH_CONCURRENCY.acquire()
        return self

    def __exit__(self, *_exc) -> bool:
        _BASH_CONCURRENCY.release()
        return False


def _exec_lock_for(thread_key: str) -> threading.Lock:
    """Per-thread bash execution lock.

    Parallel agents (main chat / workflow workers / subagents) each get their
    own channel; within one thread commands still run one at a time.
    """
    key = str(thread_key or "").strip() or "_default"
    with _EXEC_LOCKS_GUARD:
        lock = _EXEC_LOCKS.get(key)
        if lock is None:
            if len(_EXEC_LOCKS) >= _EXEC_LOCKS_MAX:
                # Trim idle entries only — evicting a HELD lock would fork the
                # channel into two locks and break mutual exclusion.
                for k in list(_EXEC_LOCKS):
                    if len(_EXEC_LOCKS) < _EXEC_LOCKS_MAX:
                        break
                    candidate = _EXEC_LOCKS.get(k)
                    if candidate is not None and not candidate.locked():
                        _EXEC_LOCKS.pop(k, None)
            lock = threading.Lock()
            _EXEC_LOCKS[key] = lock
        return lock


# Pure-wait guard: agents "waiting for progress" used to run
# `sleep 50 && echo waited`, parking an execution channel for ~a minute each.
# Waiting should rely on completion notifications, not sleeps.
_PURE_WAIT_SLEEP_RE = re.compile(r"(?i)\bsleep\s+([0-9]+(?:\.[0-9]+)?)")
_PURE_WAIT_FILLER_RE = re.compile(r"(?i)\b(?:echo\s+(?:\"[^\"]*\"|'[^']*'|[^;&|]+)|true)\b")
# ``sleep N; tail/cat …output`` looks like "real work" but is still progress polling
# (2026-11-10 prod: sleep 45/50 + tail evoflow-bash-tasks pulled bash p90 to ~12s).
_PROGRESS_POLL_READ_RE = re.compile(
    r"(?i)\b(?:tail|head|cat|less|more|wc)\b(?:\s+(?:-[a-zA-Z0-9]+|--\S+))*\s+\S+"
)
_PURE_WAIT_MAX_SECONDS = 10.0
# Hard cap: even with trailing work, a single sleep above this is banned.
# 20s (was 60s): long waits must use run_in_background + completion notify /
# ``gh run watch`` / taskoutput — not park the foreground channel.
_MAX_SINGLE_SLEEP_SECONDS = 20.0


def _pure_wait_guard(command: str) -> str | None:
    """Reject pure-wait / long-sleep disguised waits.

    Returns a rejection message, or ``None`` when the command should execute.
    - Total sleep >10s with no real work (echo/true/tail/cat filler) → reject
    - Any single ``sleep N`` with N>20 → reject even if followed by real work
    """
    cmd = str(command or "").strip()
    if not cmd or "sleep" not in cmd.lower():
        return None
    total = 0.0
    max_one = 0.0
    for m in _PURE_WAIT_SLEEP_RE.finditer(cmd):
        try:
            sec = float(m.group(1))
        except ValueError:
            return None
        total += sec
        if sec > max_one:
            max_one = sec
    if max_one > _MAX_SINGLE_SLEEP_SECONDS:
        return (
            "status: rejected\ninterrupted: false\n"
            f"该命令含过长 sleep（单次 {max_one:.0f}s > {_MAX_SINGLE_SLEEP_SECONDS:.0f}s），已拒绝执行。"
            "长等待请用 `run_in_background=true`（完成会推送通知），"
            "盯 CI / Actions 用 `gh run watch <RUN_ID> --exit-status`（可后台）；"
            "禁止 `sleep 45/60/300 && …` 或 `sleep …; tail …output` 占住前台。"
        )
    if total <= _PURE_WAIT_MAX_SECONDS:
        return None
    residue = _PURE_WAIT_SLEEP_RE.sub(" ", cmd)
    residue = _PURE_WAIT_FILLER_RE.sub(" ", residue)
    residue = _PROGRESS_POLL_READ_RE.sub(" ", residue)
    for ch in ("&&", "||", ";", "|", "(", ")", "\n"):
        residue = residue.replace(ch, " ")
    if residue.strip():
        return None  # real work beyond waiting — let it run
    return (
        "status: rejected\ninterrupted: false\n"
        f"该命令是纯等待/进度轮询（sleep 合计 {total:.0f}s），已拒绝执行。"
        "等待后台任务请依赖完成通知，或 `taskoutput(block=false)` / Read 其 output 文件；"
        "不要用 `sleep …; tail/cat …` 轮询。短时重试请把总 sleep 控制在 10 秒内。"
    )

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


def _blocking_budget_ms(timeout_ms: int, *, explicit: bool, promotable: bool = True) -> int:
    """Foreground blocking budget before the command is backgrounded.

    - Implicit timeout: ZCode assistant budget (15s).
    - Explicit timeout: honored, but foreground time is capped at
      ``FOREGROUND_BLOCKING_CEILING_MS`` — longer commands keep running in the
      background instead of parking the thread channel.
    - Not promotable (LibreOffice risk): keep the full explicit timeout —
      backgrounding leaves orphan soffice holding file locks. The implicit
      15s budget still applies (it previously soft-landed as timeout+kill).
    """
    if not explicit:
        return min(timeout_ms, ASSISTANT_BLOCKING_BUDGET_MS)
    if not promotable:
        return timeout_ms
    return min(timeout_ms, FOREGROUND_BLOCKING_CEILING_MS)


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


# LibreOffice ``soffice`` often detaches from the bash→python parent on Windows.
# Killing only the tool PID leaves orphan soffice.bin holding the .xlsx lock and
# blocking the next turn — look like "runtime stopped".
_LIBREOFFICE_RISK_RE = re.compile(
    r"(?i)(?:\bsoffice(?:\.bin|\.exe|\.com)?\b|\blibreoffice\b|"
    r"xlsx\.py\s+(?:recalc|chart-verify)|RecalculateAndSave)"
)

# tool_call_id / invocation → live Popen + command (so middleware timeout can hard-kill).
_ACTIVE_BASH_PROCS: dict[str, tuple[subprocess.Popen, str]] = {}
_ACTIVE_BASH_PROCS_LOCK = threading.Lock()


def _is_libreoffice_risk_command(command: str) -> bool:
    return bool(_LIBREOFFICE_RISK_RE.search(str(command or "")))


def _kill_libreoffice_orphans() -> None:
    """Force-kill detached LibreOffice processes (Windows + Unix best-effort)."""
    if sys.platform == "win32":
        for name in ("soffice.bin", "soffice.exe", "soffice.com"):
            try:
                subprocess.run(
                    ["taskkill", "/F", "/IM", name],
                    capture_output=True,
                    timeout=8,
                    **_no_window(),
                )
            except Exception:
                pass
        return
    for name in ("soffice.bin", "soffice", "libreoffice"):
        try:
            subprocess.run(["pkill", "-9", "-f", name], capture_output=True, timeout=5)
        except Exception:
            pass


def _register_active_bash(key: str, proc: subprocess.Popen, command: str = "") -> None:
    kid = str(key or "").strip()
    if not kid:
        return
    with _ACTIVE_BASH_PROCS_LOCK:
        _ACTIVE_BASH_PROCS[kid] = (proc, str(command or ""))


def _unregister_active_bash(key: str, proc: subprocess.Popen | None = None) -> None:
    kid = str(key or "").strip()
    if not kid:
        return
    with _ACTIVE_BASH_PROCS_LOCK:
        cur = _ACTIVE_BASH_PROCS.get(kid)
        if cur is None:
            return
        if proc is not None and cur[0] is not proc:
            return
        _ACTIVE_BASH_PROCS.pop(kid, None)


def force_kill_active_bash(
    *,
    reason: str = "",
    tool_call_id: str | None = None,
    sweep_libreoffice: bool | None = None,
) -> int:
    """Hard-kill live bash pops (and LibreOffice orphans when the command was LO-risk).

    Returns number of process trees signalled. LibreOffice orphan sweep defaults to
    only when a killed command matched soffice/xlsx recalc — avoids nuking a user's
    open Calc window on unrelated bash timeouts.
    """
    del reason  # logged by caller
    killed = 0
    lo_sweep = False
    with _ACTIVE_BASH_PROCS_LOCK:
        if tool_call_id:
            items = [(tool_call_id, _ACTIVE_BASH_PROCS.get(str(tool_call_id)))]
        else:
            items = list(_ACTIVE_BASH_PROCS.items())
    for key, entry in items:
        if entry is None:
            continue
        proc, command = entry
        if _is_libreoffice_risk_command(command):
            lo_sweep = True
        try:
            if proc.poll() is None and proc.pid:
                _kill_process_tree(int(proc.pid), also_libreoffice=False)
                killed += 1
        except Exception:
            pass
        try:
            from evoflow.tools.zcode_port.warm_bash import invalidate_warm_for_proc

            invalidate_warm_for_proc(proc, kill_tree=lambda pid: _kill_process_tree(pid))
        except Exception:
            pass
        _unregister_active_bash(str(key), proc)
    if sweep_libreoffice is None:
        sweep_libreoffice = lo_sweep
    if sweep_libreoffice:
        _kill_libreoffice_orphans()
    return killed


def _kill_process_tree(pid: int, *, also_libreoffice: bool = False) -> None:
    """Best-effort kill of *pid* and descendants.

    Git Bash spawns ``git.exe`` children. On Windows, ``Popen.kill()`` only stops the
    shell; children keep stdout pipes open and ``communicate()`` hangs past timeout.
    LibreOffice additionally detaches — pass ``also_libreoffice=True`` on tool timeout.
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
        if also_libreoffice:
            _kill_libreoffice_orphans()
        return
    try:
        os.killpg(pid, 9)
    except OSError:
        try:
            os.kill(pid, 9)
        except OSError:
            pass
    if also_libreoffice:
        _kill_libreoffice_orphans()


def _is_windows_wsl_or_store_bash(path: Path | str) -> bool:
    """True for WSL / Store stubs that are not a real POSIX shell.

    ``C:\\Windows\\System32\\bash.exe`` launches WSL; the WindowsApps copy is a
    Store stub. Both surface as ``bash`` on PATH and break when WSL is missing
    or needs ``wsl --update``. ZCode never accepts them — only Git Bash.
    """
    normalized = str(path).replace("/", "\\").lower()
    if "windowsapps" in normalized:
        return True
    # System32 / SysWOW64 bash.exe → wsl.exe launcher (not Git Bash).
    if normalized.endswith("\\bash.exe") and (
        "\\system32\\" in normalized or "\\syswow64\\" in normalized
    ):
        return True
    return False


def _windows_git_bash_candidates() -> list[Path]:
    """Mirror ZCode ``resolveWindowsGitBashShell``: known Git installs + git.exe.

    Never consult ``PATH`` for bare ``bash`` — that picks up the WSL shim.
    """
    candidates: list[Path] = []
    # ZCode fixed paths + user-scoped Git (Scoop / per-user installer).
    for env_key in ("ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"):
        root = os.environ.get(env_key)
        if not root:
            continue
        base = Path(root) / ("Programs" if env_key == "LOCALAPPDATA" else "")
        candidates.append(base / "Git" / "bin" / "bash.exe")
    git = shutil.which("git")
    if git:
        git_dir = Path(git).resolve().parent
        # git.exe in .../Git/cmd → .../Git/bin/bash.exe
        candidates.append(git_dir.parent / "bin" / "bash.exe")
        # git.exe already next to bash (rare portable layouts)
        candidates.append(git_dir / "bash.exe")
        # .../Git/mingw64/bin/git.exe → .../Git/bin/bash.exe
        candidates.append(git_dir.parent.parent / "bin" / "bash.exe")
    return candidates


def bash_shell() -> list[str] | None:
    """Prefer a real POSIX bash so the embedded-search function prelude can run.

    On Windows this matches ZCode: only Git Bash. WSL/Store ``bash.exe`` stubs
    are rejected so a broken WSL install falls through to PowerShell in
    ``_script`` instead of failing every ``echo``.
    """
    if sys.platform == "win32":
        seen: set[str] = set()
        for path in _windows_git_bash_candidates():
            key = str(path).replace("/", "\\").lower()
            if key in seen:
                continue
            seen.add(key)
            if _is_windows_wsl_or_store_bash(path):
                continue
            if path.is_file():
                return [str(path)]
        return None

    found = shutil.which("bash")
    if found:
        return [found]
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


# find/grep/rg (and wrappers) are the only reason to pay the embedded-search prelude.
_SEARCH_TOOL_RE = re.compile(
    r"(?i)(?:^|[\s;|&`$(){}])(?:find|grep|egrep|fgrep|rg|ugrep|bfs)\b"
)


def _needs_search_prelude(command: str) -> bool:
    return bool(_SEARCH_TOOL_RE.search(str(command or "")))


def _embedded_prelude_text() -> str:
    if not embedded_search_enabled():
        return ""
    exports, find_cmd, grep_cmd, rg_cmd, wrap_find = _embedded_runtime_exports()
    return exports + build_embedded_search_prelude(
        find_command=find_cmd,
        grep_command=grep_cmd,
        rg_command=rg_cmd,
        wrap_find=wrap_find,
    )


def _script(command: str, *, cwd: str) -> tuple[list[str], str]:
    ps = _powershell_argv(command, cwd)
    if ps is not None:
        return ps, "powershell"
    shell = bash_shell()
    body = _wrap_with_cwd_and_pwd(command, cwd)
    if shell and embedded_search_enabled() and _needs_search_prelude(command):
        return _bash_args(shell, _embedded_prelude_text() + body), "bash"
    if shell:
        return _bash_args(shell, body), "bash"
    if sys.platform == "win32":
        # No Git Bash (or only WSL stubs) → native PowerShell, same as ZCode
        # legacy-shell fallback: keep Agent usable without requiring WSL.
        safe_cwd = cwd.replace("'", "''")
        return [
            _powershell_executable(),
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            f"Set-Location -LiteralPath '{safe_cwd}'; {command}",
        ], "powershell"
    return ["sh", "-c", body], "sh"


def _warm_bash_eligible(
    command: str,
    *,
    run_in_background: bool = False,
) -> bool:
    """Warm shell is bash-only; LO / explicit background stay on the cold Popen path."""
    from evoflow.tools.zcode_port.warm_bash import warm_enabled

    if not warm_enabled():
        return False
    if run_in_background:
        return False
    if _is_libreoffice_risk_command(command):
        return False
    if _POWERSHELL_CMDLET_RE.search(str(command or "").strip()):
        return False
    return bash_shell() is not None


def _note_bash_timing(tool_call_id: str, **fields: object) -> None:
    """Attach bash path breakdown for observability (queue vs exec vs warm/cold)."""
    if not tool_call_id:
        return
    try:
        from evoflow.observability.tool_timing import note_tool_exec_detail

        detail = {"kind": "bash", **fields}
        note_tool_exec_detail(tool_call_id, detail)
        exec_ms = float(fields.get("exec_ms") or 0)
        path = str(fields.get("path") or "")
        dialect = str(fields.get("dialect") or "")
        # Surface only outliers in process logs — routine ~30ms warm hits stay quiet.
        if exec_ms >= 2000 or path == "cold" and exec_ms >= 500 and dialect == "powershell":
            import logging

            logging.getLogger(__name__).info(
                "bash timing path=%s dialect=%s warm_reused=%s exec_ms=%.0f cmd=%s",
                path,
                dialect,
                fields.get("warm_reused"),
                exec_ms,
                str(fields.get("command_preview") or "")[:80],
            )
    except Exception:
        return


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
    blocking_ms: int,
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
    seconds = max(1, int(blocking_ms) // 1000)
    return (
        f"status: backgrounded\ninterrupted: false\nbackgroundTaskId: {task_id}\n"
        f"persistedOutputPath: {output_path}\n"
        f"Command exceeded the assistant-mode blocking budget ({seconds}s) and was moved to the "
        f"background with ID: {task_id}. It is still running — you will be notified when it completes. "
        f"Output is being written to: {output_path}. To check interim output, use Read on that file path."
    )


def _promote_warm_to_background(
    session,
    *,
    command: str,
    tool_call_id: str,
    description: str,
    thread_id: str,
    session_key: str,
    partial: str,
    blocking_ms: int,
    remaining_timeout_s: float,
) -> str:
    """Keep a soft-budget-timed-out warm command alive via marker drain."""
    from evoflow.tools.zcode_port.warm_bash import continue_drain, last_cwd

    task_id = new_task_id()
    output_path = _output_file(task_id)
    stream_id = (tool_call_id or "").strip() or task_id
    chunks = [partial or ""]
    output_path.write_text(chunks[0], encoding="utf-8", errors="replace")
    task = BackgroundBashTask(
        task_id=task_id,
        command=command,
        description=description or command[:80],
        output_path=output_path,
        proc=session.proc,
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
        rest, code, timed_out = continue_drain(
            session, timeout_s=max(1.0, remaining_timeout_s)
        )
        if rest:
            _emit("stdout", invocation_id=stream_id, tool_call_id=stream_id, text=rest)
            chunks.append(rest)
        output_path.write_text("".join(chunks), encoding="utf-8", errors="replace")
        remembered = last_cwd(session)
        if remembered:
            _remember_cwd(thread_id, remembered)
        if timed_out or code is None:
            try:
                _kill_process_tree(int(session.proc.pid or 0))
            except Exception:
                pass
            session.close(kill_tree=lambda pid: _kill_process_tree(pid))
            code = 124
        else:
            # Detached warm shells are not returned to the pool — close stdin only.
            try:
                if session.proc.stdin:
                    session.proc.stdin.close()
            except Exception:
                pass
            try:
                _kill_process_tree(int(session.proc.pid or 0))
            except Exception:
                pass
            session._broken = True
        if task.status == "running":
            mark(task, status="completed" if code == 0 else "failed", exit_code=code)
        _emit(
            "exit",
            invocation_id=stream_id,
            tool_call_id=stream_id,
            exit_code=code,
            success=code == 0,
        )
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

    threading.Thread(target=_pump, name=f"bash-warm-bg-{task_id}", daemon=True).start()
    seconds = max(1, int(blocking_ms) // 1000)
    return (
        f"status: backgrounded\ninterrupted: false\nbackgroundTaskId: {task_id}\n"
        f"persistedOutputPath: {output_path}\n"
        f"Command exceeded the assistant-mode blocking budget ({seconds}s) and was moved to the "
        f"background with ID: {task_id}. It is still running — you will be notified when it completes. "
        f"Output is being written to: {output_path}. To check interim output, use Read on that file path."
    )


def _run_foreground_warm(
    command: str,
    timeout_ms: int,
    cwd: str,
    tool_call_id: str,
    *,
    thread_id: str,
    explicit: bool,
    description: str,
    session_key: str,
) -> str | None:
    """Reuse a per-thread bash process. Returns ``None`` to fall back to cold spawn."""
    from evoflow.tools.zcode_port import warm_bash as _wb
    from evoflow.tools.zcode_port.warm_bash import run_in_warm_bash

    shell = bash_shell()
    if not shell:
        return None
    warm_key = (thread_id or session_key or tool_call_id or "_default").strip() or "_default"
    lo_risk = _is_libreoffice_risk_command(command)
    blocking_ms = _blocking_budget_ms(timeout_ms, explicit=explicit, promotable=not lo_risk)
    invocation = tool_call_id or uuid.uuid4().hex
    # Warm sessions load the search prelude once at spawn so later find/grep work
    # without re-paying cold start; cold path still skips prelude when unused.
    prelude = _embedded_prelude_text() if embedded_search_enabled() else ""
    _emit("start", invocation_id=invocation, tool_call_id=tool_call_id, command=command)
    exec_t0 = time.perf_counter()
    probe = _PROBE_COMMAND_RE.search(str(command or "").strip()) is not None

    def _timing(*, path: str, warm_reused: bool) -> None:
        _note_bash_timing(
            tool_call_id,
            path=path,
            dialect="bash",
            warm_reused=warm_reused,
            exec_ms=round((time.perf_counter() - exec_t0) * 1000.0, 2),
            command_preview=str(command or "")[:120],
            probe=probe,
        )

    # Ensure a live session exists so we can register it for force-kill, then run.
    try:
        with _wb._SESSIONS_LOCK:
            existing = _wb._SESSIONS.get(warm_key)
        warm_reused = existing is not None and existing.alive()
        if existing is None or not existing.alive():
            # Prime the pool; run_in_warm_bash will reuse it.
            _wb._get_or_spawn(
                key=warm_key,
                shell_argv=shell,
                prelude=prelude,
                popen_kwargs=_popen_kwargs(),
                kill_tree=lambda pid: _kill_process_tree(pid),
            )
            warm_reused = False
        with _wb._SESSIONS_LOCK:
            live = _wb._SESSIONS.get(warm_key)
        if live is not None:
            _register_active_bash(invocation, live.proc, command)
        result = run_in_warm_bash(
            key=warm_key,
            command=command,
            posix_cwd=_to_posix(cwd),
            shell_argv=shell,
            prelude=prelude,
            popen_kwargs=_popen_kwargs(),
            timeout_s=blocking_ms / 1000.0,
            kill_tree=lambda pid: _kill_process_tree(pid),
        )
    except Exception:
        _unregister_active_bash(invocation)
        return None

    if result.timed_out and result.detached and result.session is not None:
        _unregister_active_bash(invocation)
        if blocking_ms < timeout_ms and not lo_risk:
            remaining = max(1.0, (timeout_ms - blocking_ms) / 1000.0)
            _timing(path="warm_bg", warm_reused=warm_reused)
            return _promote_warm_to_background(
                result.session,
                command=command,
                tool_call_id=tool_call_id,
                description=description,
                thread_id=thread_id,
                session_key=session_key,
                partial=result.partial,
                blocking_ms=blocking_ms,
                remaining_timeout_s=remaining,
            )
        try:
            _kill_process_tree(int(result.session.proc.pid or 0), also_libreoffice=lo_risk)
        except Exception:
            pass
        result.session.close(kill_tree=lambda pid: _kill_process_tree(pid))
        _timing(path="warm", warm_reused=warm_reused)
        _emit(
            "stdout",
            invocation_id=invocation,
            tool_call_id=tool_call_id,
            text=result.partial,
        )
        _emit("exit", invocation_id=invocation, tool_call_id=tool_call_id, exit_code=124, success=False)
        return _format_finished(
            command=command,
            stdout=result.partial,
            stderr="",
            exit_code=124,
            timed_out=True,
        )

    _unregister_active_bash(invocation)

    if result.exit_code == 127 and not result.stdout and not result.timed_out:
        return None

    if result.cwd:
        _remember_cwd(thread_id, result.cwd)

    _timing(path="warm", warm_reused=warm_reused)
    stdout = result.stdout or ""
    exit_code = result.exit_code
    _emit("stdout", invocation_id=invocation, tool_call_id=tool_call_id, text=stdout)
    _emit("exit", invocation_id=invocation, tool_call_id=tool_call_id, exit_code=exit_code, success=exit_code == 0)
    return _format_finished(
        command=command,
        stdout=stdout,
        stderr="",
        exit_code=exit_code,
        timed_out=False,
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
    invocation = tool_call_id or uuid.uuid4().hex
    # LibreOffice detaches from the process tree — it must not be backgrounded
    # (orphan soffice holds the .xlsx lock), so its explicit timeout stays full.
    lo_risk = _is_libreoffice_risk_command(command)
    blocking_ms = _blocking_budget_ms(timeout_ms, explicit=explicit, promotable=not lo_risk)

    if _warm_bash_eligible(command):
        warm_out = _run_foreground_warm(
            command,
            timeout_ms,
            cwd,
            tool_call_id,
            thread_id=thread_id,
            explicit=explicit,
            description=description,
            session_key=session_key,
        )
        if warm_out is not None:
            return warm_out

    argv, dialect = _script(command, cwd=cwd)
    # CreateProcess requires a Windows path. Git Bash accepts that cwd and converts it.
    _emit("start", invocation_id=invocation, tool_call_id=tool_call_id, command=command)
    exec_t0 = time.perf_counter()
    probe = _PROBE_COMMAND_RE.search(str(command or "").strip()) is not None

    def _timing_cold(*, path: str = "cold") -> None:
        _note_bash_timing(
            tool_call_id,
            path=path,
            dialect=dialect,
            warm_reused=False,
            exec_ms=round((time.perf_counter() - exec_t0) * 1000.0, 2),
            command_preview=str(command or "")[:120],
            probe=probe,
        )

    try:
        proc = subprocess.Popen(argv, cwd=cwd, **_popen_kwargs())
    except OSError as exc:
        _timing_cold()
        _emit("exit", invocation_id=invocation, tool_call_id=tool_call_id, exit_code=127, success=False)
        return f"status: spawn_error\ninterrupted: false\nstderr:\n{exc}"

    timed_out = False
    stdout = ""
    stderr = ""
    _register_active_bash(invocation, proc, command)
    try:
        try:
            stdout, stderr = proc.communicate(timeout=blocking_ms / 1000.0)
        except subprocess.TimeoutExpired as exc:
            # Soft assistant budget normally backgrounds long commands. LibreOffice
            # detaches from the process tree — backgrounding leaves orphan soffice
            # holding the .xlsx lock and poisons the next turn. Soft-land as timeout.
            if blocking_ms < timeout_ms and not lo_risk:
                _unregister_active_bash(invocation, proc)
                _timing_cold(path="cold_bg")
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
                    blocking_ms=blocking_ms,
                )
            timed_out = True
            _kill_process_tree(int(proc.pid or 0), also_libreoffice=lo_risk)
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
    finally:
        _unregister_active_bash(invocation, proc)

    _timing_cold()
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
    argv, dialect = _script(command, cwd=cwd)
    _note_bash_timing(
        tool_call_id,
        path="background",
        dialect=dialect,
        warm_reused=False,
        exec_ms=0,
        command_preview=str(command or "")[:120],
        probe=_PROBE_COMMAND_RE.search(str(command or "").strip()) is not None,
    )
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
    guard = _pure_wait_guard(command)
    if guard is not None:
        return guard
    explicit = _timeout_was_explicit(timeout)
    timeout_ms = _effective_timeout_ms(command, _semantic_timeout(timeout), explicit=explicit)
    tid = _thread_id(runtime)
    sk = _session_key(runtime)
    desc = description or command[:80]
    # Execution channels are per-thread: the main conversation, parallel
    # workflow workers and subagents must not serialize behind each other's
    # long commands (a main-chat `sleep 50` used to block every worker's
    # `ls`). A process-wide concurrency cap keeps resource use bounded.
    # Lock + semaphore wait is reported per tool_call_id so observability can
    # separate queue time from real execution time (handler wall time alone
    # made a queued `git show` look like 237s).
    queue_t0 = time.perf_counter()
    with _exec_lock_for(tid or sk):
        with _bash_concurrency_slot():
            try:
                from evoflow.observability.tool_timing import note_tool_queue_wait

                note_tool_queue_wait(tool_call_id, (time.perf_counter() - queue_t0) * 1000.0)
            except Exception:
                pass
            if _semantic_bool(run_in_background):
                _note_bash_timing(
                    tool_call_id,
                    path="background",
                    dialect="bash" if bash_shell() else "powershell",
                    warm_reused=False,
                    exec_ms=0,
                    command_preview=str(command or "")[:120],
                    probe=_PROBE_COMMAND_RE.search(str(command or "").strip()) is not None,
                )
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
