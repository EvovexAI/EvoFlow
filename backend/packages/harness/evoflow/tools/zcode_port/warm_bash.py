"""Persistent bash sessions — skip per-command Git Bash cold start.

Each thread keeps one ``bash --noprofile --norc -s`` process. Commands run in a
subshell with stdin attached to ``/dev/null`` (same non-interactive contract as
the cold ``Popen`` path). A unique end-marker line carries exit code + cwd.

Soft-budget timeout detaches the session to a background reader (command keeps
running) and drops it from the pool so the next foreground call can spawn a
fresh warm shell. Hard timeout kills the process tree.
"""

from __future__ import annotations

import os
import queue
import re
import subprocess
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Callable

_WARM_ENABLED_DEFAULT = "1"
_WARM_IDLE_TTL_S = float(os.getenv("EVOFLOW_BASH_WARM_IDLE_TTL_S", "600") or "600")
_WARM_SESSIONS_MAX = 64

_DONE_LINE_RE_TMPL = r"^__EF_RC_{nonce}__(-?\d+)__EF_CWD__(.*)__EF_END_{nonce}__$"


def warm_enabled() -> bool:
    raw = (os.getenv("EVOFLOW_BASH_WARM") or _WARM_ENABLED_DEFAULT).strip().lower()
    return raw not in {"0", "false", "no", "off"}


@dataclass
class WarmRunResult:
    stdout: str
    exit_code: int
    timed_out: bool
    # Soft-budget: session handed to caller for background drain; already left the pool.
    detached: bool = False
    session: "WarmBashSession | None" = None
    partial: str = ""
    cwd: str = ""
    proc: subprocess.Popen | None = None


@dataclass
class WarmBashSession:
    key: str
    proc: subprocess.Popen
    shell_argv: list[str]
    created_at: float = field(default_factory=time.monotonic)
    last_used: float = field(default_factory=time.monotonic)
    _reader_q: queue.Queue[str | None] = field(default_factory=queue.Queue)
    _reader_thread: threading.Thread | None = field(default=None, repr=False)
    _broken: bool = False
    _last_cwd: str = ""
    _detach_nonce: str = ""

    def alive(self) -> bool:
        if self._broken:
            return False
        try:
            return self.proc.poll() is None
        except Exception:
            return False

    def start_reader(self) -> None:
        if self._reader_thread is not None:
            return
        assert self.proc.stdout is not None

        def _pump() -> None:
            try:
                for line in self.proc.stdout:
                    self._reader_q.put(line)
            except Exception:
                pass
            finally:
                self._reader_q.put(None)

        self._reader_thread = threading.Thread(
            target=_pump, name=f"warm-bash-read-{self.key[:16]}", daemon=True
        )
        self._reader_thread.start()

    def close(self, *, kill_tree: Callable[[int], None] | None = None) -> None:
        self._broken = True
        try:
            if self.proc.poll() is None and self.proc.pid:
                if kill_tree is not None:
                    kill_tree(int(self.proc.pid))
                else:
                    self.proc.kill()
        except Exception:
            pass
        try:
            if self.proc.stdin:
                self.proc.stdin.close()
        except Exception:
            pass


_SESSIONS: dict[str, WarmBashSession] = {}
_SESSIONS_LOCK = threading.Lock()


def _mark_warm_bash_dropped(key: str) -> None:
    """Best-effort registry complete — must run without ``_SESSIONS_LOCK`` held."""
    try:
        from evoflow.persistence.session_runtime_repository import (
            KIND_WARM_BASH,
            safe_complete_child_work,
        )

        k = str(key or "").strip()
        if not k:
            return
        safe_complete_child_work(
            kind=KIND_WARM_BASH,
            ref_id=k,
            status="dropped",
            thread_id=k,
            parent_thread_id=k,
        )
    except Exception:
        pass


def _drop_session(key: str, session: WarmBashSession | None = None) -> None:
    dropped = False
    with _SESSIONS_LOCK:
        cur = _SESSIONS.get(key)
        if cur is None:
            return
        if session is not None and cur is not session:
            return
        _SESSIONS.pop(key, None)
        dropped = True
    if dropped:
        _mark_warm_bash_dropped(key)


def invalidate_warm_session(key: str, *, kill_tree: Callable[[int], None] | None = None) -> None:
    """Drop and kill the warm shell for *key* (thread channel)."""
    with _SESSIONS_LOCK:
        session = _SESSIONS.pop(str(key or "").strip(), None)
    if session is not None:
        session.close(kill_tree=kill_tree)
        _mark_warm_bash_dropped(str(key or "").strip())


def invalidate_warm_for_proc(
    proc: subprocess.Popen, *, kill_tree: Callable[[int], None] | None = None
) -> None:
    """Drop any warm session whose Popen is *proc* (force-kill path)."""
    with _SESSIONS_LOCK:
        matched = [k for k, s in _SESSIONS.items() if s.proc is proc]
        sessions = [(k, _SESSIONS.pop(k)) for k in matched]
    for k, session in sessions:
        session.close(kill_tree=kill_tree)
        _mark_warm_bash_dropped(k)


def reset_warm_sessions_for_tests(*, kill_tree: Callable[[int], None] | None = None) -> None:
    """Test helper: close every pooled session."""
    with _SESSIONS_LOCK:
        items = list(_SESSIONS.items())
        _SESSIONS.clear()
    for _k, session in items:
        session.close(kill_tree=kill_tree)


def _evict_idle_and_cap(*, kill_tree: Callable[[int], None] | None) -> None:
    now = time.monotonic()
    with _SESSIONS_LOCK:
        items = list(_SESSIONS.items())
    for key, session in items:
        if not session.alive() or (now - session.last_used) > _WARM_IDLE_TTL_S:
            _drop_session(key, session)
            session.close(kill_tree=kill_tree)
    capped: list[str] = []
    with _SESSIONS_LOCK:
        if len(_SESSIONS) < _WARM_SESSIONS_MAX:
            return
        ordered = sorted(_SESSIONS.items(), key=lambda kv: kv[1].last_used)
        while len(_SESSIONS) >= _WARM_SESSIONS_MAX and ordered:
            key, session = ordered.pop(0)
            if _SESSIONS.get(key) is session:
                _SESSIONS.pop(key, None)
                session.close(kill_tree=kill_tree)
                capped.append(key)
    for key in capped:
        _mark_warm_bash_dropped(key)


def _spawn(
    *,
    key: str,
    shell_argv: list[str],
    prelude: str,
    popen_kwargs: dict,
    kill_tree: Callable[[int], None] | None,
) -> WarmBashSession:
    _evict_idle_and_cap(kill_tree=kill_tree)
    kw = dict(popen_kwargs)
    kw["stdin"] = subprocess.PIPE
    kw["stderr"] = subprocess.STDOUT
    proc = subprocess.Popen([*shell_argv, "--noprofile", "--norc", "-s"], **kw)
    session = WarmBashSession(key=key, proc=proc, shell_argv=list(shell_argv))
    session.start_reader()
    if prelude:
        assert proc.stdin is not None
        proc.stdin.write(prelude if prelude.endswith("\n") else prelude + "\n")
        proc.stdin.flush()
    with _SESSIONS_LOCK:
        old = _SESSIONS.get(key)
        _SESSIONS[key] = session
    if old is not None and old is not session:
        old.close(kill_tree=kill_tree)
    # Registry write AFTER releasing _SESSIONS_LOCK (Lock is not reentrant).
    try:
        from evoflow.persistence.session_runtime_repository import (
            KIND_WARM_BASH,
            safe_register_child_work,
        )

        safe_register_child_work(
            kind=KIND_WARM_BASH,
            ref_id=str(key),
            status="running",
            thread_id=str(key),
            parent_thread_id=str(key),
            title="warm_bash",
        )
    except Exception:
        pass
    return session


def _get_or_spawn(
    *,
    key: str,
    shell_argv: list[str],
    prelude: str,
    popen_kwargs: dict,
    kill_tree: Callable[[int], None] | None,
) -> WarmBashSession:
    with _SESSIONS_LOCK:
        session = _SESSIONS.get(key)
    if session is not None and session.alive():
        session.last_used = time.monotonic()
        return session
    if session is not None:
        _drop_session(key, session)
        session.close(kill_tree=kill_tree)
    return _spawn(
        key=key,
        shell_argv=shell_argv,
        prelude=prelude,
        popen_kwargs=popen_kwargs,
        kill_tree=kill_tree,
    )


def _build_script(command: str, *, posix_cwd: str, nonce: str) -> str:
    # Subshell + stdin from /dev/null: one-shot env/cd (ZCode non-persist) and
    # prevent stdin consumers from stealing the warm-shell protocol stream.
    return (
        f'(\n'
        f'cd "{posix_cwd}" || exit 1\n'
        f"{command}\n"
        f") </dev/null\n"
        f'_ef_ec=$?\n'
        f'printf "\\n__EF_RC_{nonce}__%s__EF_CWD__%s__EF_END_{nonce}__\\n" '
        f'"$_ef_ec" "$(pwd)"\n'
    )


def drain_until_marker(
    session: WarmBashSession,
    *,
    nonce: str,
    timeout_s: float,
) -> tuple[str, int | None, bool]:
    """Read stdout lines until the end marker or timeout.

    Returns ``(output_without_marker, exit_code_or_None, timed_out)``.
    """
    done_re = re.compile(_DONE_LINE_RE_TMPL.format(nonce=re.escape(nonce)))
    chunks: list[str] = []
    deadline = time.monotonic() + max(0.05, timeout_s)
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return "".join(chunks), None, True
        try:
            line = session._reader_q.get(timeout=remaining)
        except queue.Empty:
            return "".join(chunks), None, True
        if line is None:
            session._broken = True
            return "".join(chunks), None, True
        matched = done_re.match(line.rstrip("\r\n"))
        if matched:
            try:
                code = int(matched.group(1))
            except ValueError:
                code = 1
            session._last_cwd = matched.group(2) or ""
            session.last_used = time.monotonic()
            return "".join(chunks), code, False
        chunks.append(line)


def run_in_warm_bash(
    *,
    key: str,
    command: str,
    posix_cwd: str,
    shell_argv: list[str],
    prelude: str,
    popen_kwargs: dict,
    timeout_s: float,
    kill_tree: Callable[[int], None],
) -> WarmRunResult:
    """Run *command* on the warm shell for *key*.

    Waits up to *timeout_s*. On timeout the session is detached (removed from the
    pool) and returned so the caller can background-drain or kill it. This
    function does not kill on timeout.
    """
    session = _get_or_spawn(
        key=key,
        shell_argv=shell_argv,
        prelude=prelude,
        popen_kwargs=popen_kwargs,
        kill_tree=kill_tree,
    )
    nonce = uuid.uuid4().hex[:12]
    script = _build_script(command, posix_cwd=posix_cwd, nonce=nonce)
    assert session.proc.stdin is not None
    try:
        session.proc.stdin.write(script)
        session.proc.stdin.flush()
    except Exception:
        session._broken = True
        _drop_session(key, session)
        session.close(kill_tree=kill_tree)
        return WarmRunResult(stdout="", exit_code=127, timed_out=False, detached=False)

    output, code, timed_out = drain_until_marker(session, nonce=nonce, timeout_s=timeout_s)
    if not timed_out and code is not None:
        return WarmRunResult(
            stdout=output,
            exit_code=code,
            timed_out=False,
            cwd=session._last_cwd,
            proc=session.proc,
        )

    _drop_session(key, session)
    session._detach_nonce = nonce
    return WarmRunResult(
        stdout="",
        exit_code=124,
        timed_out=True,
        detached=True,
        session=session,
        partial=output,
        proc=session.proc,
    )


def continue_drain(
    session: WarmBashSession,
    *,
    timeout_s: float,
) -> tuple[str, int | None, bool]:
    """Continue reading a detached session until marker / timeout / death."""
    nonce = session._detach_nonce
    if not nonce:
        return "", None, True
    return drain_until_marker(session, nonce=str(nonce), timeout_s=timeout_s)


def last_cwd(session: WarmBashSession) -> str:
    return str(session._last_cwd or "")
