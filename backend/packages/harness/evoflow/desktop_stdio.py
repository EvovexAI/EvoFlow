"""Windows desktop / frozen EXE: UTF-8 stdio and no ANSI colors for LangGraph logging.

Chinese Windows defaults to GBK; ``langgraph-api`` version warnings use emoji (U+26A0)
and arrows that trigger ``UnicodeEncodeError`` through colorama when writing to stderr.

PyInstaller ``--noconsole`` builds close the console handle; colorama's ``AnsiToWin32``
wraps that closed stream during import. Later ``logging`` emits through the wrapper and
raises ``ValueError: I/O operation on closed file`` (often visible during
``langgraph_runtime_inmem`` import).
"""

from __future__ import annotations

import ctypes
import io
import logging
import os
import sys
from typing import TextIO


def apply_windows_stdio_env() -> None:
    """Set process env before LangGraph/colorama initialize (safe on all platforms)."""
    os.environ.setdefault("PYTHONUTF8", "1")
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")
    os.environ["NO_COLOR"] = "1"
    os.environ["FORCE_COLOR"] = "0"
    os.environ["COLORAMA_DISABLE"] = "1"


def _stream_is_usable(stream: TextIO | None) -> bool:
    if stream is None:
        return False
    try:
        fd = stream.fileno()
        os.fstat(fd)
        return True
    except (AttributeError, OSError, ValueError):
        pass
    try:
        stream.write("")
        stream.flush()
        return True
    except (OSError, ValueError):
        return False


def _is_colorama_wrapped(stream: object) -> bool:
    mod = type(stream).__module__
    name = type(stream).__name__
    return mod.startswith("colorama") or name in ("AnsiToWin32", "StreamWrapper")


def _deinit_colorama() -> None:
    try:
        import colorama.initialise as colour_init

        colour_init.atexit_done = True
    except Exception:
        pass
    try:
        import colorama

        colorama.deinit()
    except Exception:
        pass


def _assign_devnull_stream(name: str) -> None:
    null = os.devnull
    stream = open(null, "w", encoding="utf-8")  # noqa: SIM115
    setattr(sys, name, stream)
    fd = 1 if name == "stdout" else 2
    try:
        null_fd = os.open(null, os.O_WRONLY)
        try:
            os.dup2(null_fd, fd)
        finally:
            os.close(null_fd)
    except OSError:
        pass


def _fd_is_writable(fd: int) -> bool:
    """Return True only if *fd* is backed by a valid, writable OS handle.

    On Windows ``--noconsole`` builds, ``os.dup(1)`` / ``os.dup(2)`` can succeed
    even though the underlying console handle is invalid (already closed by
    PyInstaller).  A zero-byte ``os.write`` flushes out such phantom fds that
    would later cause ``open(fd, …)`` → ``OSError: [WinError 6]``.
    """
    try:
        os.write(fd, b"")
        return True
    except OSError:
        return False


def _open_dup_stream(fd: int) -> TextIO | None:
    """Open a UTF-8 TextIO from a saved dup fd; return ``None`` on invalid handle."""
    try:
        return open(fd, mode="w", encoding="utf-8", closefd=True)  # noqa: SIM115
    except OSError:
        try:
            os.close(fd)
        except OSError:
            pass
        return None


def _try_assign_console_stream(name: str) -> bool:
    """Try to open CONOUT$ (Windows console output buffer) after AttachConsole.

    GUI subsystem EXEs (``console=False`` in PyInstaller) don't inherit the parent
    console.  After ``AttachConsole(ATTACH_PARENT_PROCESS)`` the process has a
    console, but the CRT's stdio file descriptors still point to the old closed
    handles.  Opening ``CONOUT$`` directly bypasses the CRT and gives Python a
    real writable stream to the console.
    """
    if os.name != "nt" or not getattr(sys, "frozen", False):
        return False
    try:
        stream = open("CONOUT$", "w", encoding="utf-8")  # noqa: SIM115
        setattr(sys, name, stream)
        return True
    except Exception:
        return False


def _replace_stdio_from_dup(saved: dict[str, int]) -> None:
    for name in ("stdout", "stderr"):
        stream = _open_dup_stream(saved[name]) if name in saved else None
        if stream is None:
            if not _try_assign_console_stream(name):
                _assign_devnull_stream(name)
        else:
            setattr(sys, name, stream)


def _sanitize_logging_after_stdio_fix() -> None:
    """Drop StreamHandlers still bound to pre-fix or colorama-wrapped streams."""
    root = logging.getLogger()
    for handler in list(root.handlers):
        if not isinstance(handler, logging.StreamHandler):
            continue
        stream = getattr(handler, "stream", None)
        if stream is None:
            continue
        if stream is sys.stdout or stream is sys.stderr:
            continue
        if _is_colorama_wrapped(stream) or not _stream_is_usable(stream):
            root.removeHandler(handler)
            try:
                handler.close()
            except Exception:
                pass
    try:
        last = logging.lastResort
        if isinstance(last, logging.Handler):
            stream = getattr(last, "stream", None)
            if stream is not sys.stderr or _is_colorama_wrapped(stream) or not _stream_is_usable(stream):
                logging.lastResort = logging.NullHandler()
    except Exception:
        pass


def _try_attach_parent_console() -> bool:
    """Attach to parent process console (cmd.exe/PowerShell) when launched as GUI subsystem.

    GUI subsystem EXEs (``console=False`` in PyInstaller) launched from a command prompt
    do not inherit the console.  ``AttachConsole(ATTACH_PARENT_PROCESS)`` reconnects
    stdout/stderr so CLI output is visible.
    """
    if os.name != "nt" or not getattr(sys, "frozen", False):
        return False
    try:
        # ATTACH_PARENT_PROCESS = -1 (0xFFFFFFFF)
        result = ctypes.windll.kernel32.AttachConsole(-1)
        return result != 0
    except Exception:
        return False


def prepare_frozen_process_stdio() -> None:
    """Run as early as possible in PyInstaller EXEs (before uvicorn/langgraph imports).

    Wrapped in a try/except so an invalid stdio handle can never crash the gateway
    process -- the worst case degrades to NUL-backed streams, not a hard exit.
    """
    if not getattr(sys, "frozen", False):
        return
    try:
        apply_windows_stdio_env()

        # GUI subsystem EXEs (console=False) launched from cmd.exe/PowerShell have
        # no console — stdout/stderr go to /dev/null.  AttachConsole reconnects
        # the process to the parent console so CLI output is visible.
        if os.name == "nt":
            _try_attach_parent_console()

        saved: dict[str, int] = {}
        for name, fd_no in (("stdout", 1), ("stderr", 2)):
            stream = getattr(sys, name, None)
            if _stream_is_usable(stream) and not _is_colorama_wrapped(stream):
                try:
                    fd = os.dup(stream.fileno())
                    if _fd_is_writable(fd):
                        saved[name] = fd
                    else:
                        os.close(fd)
                    continue
                except OSError:
                    pass
            try:
                fd = os.dup(fd_no)
                if _fd_is_writable(fd):
                    saved[name] = fd
                else:
                    os.close(fd)
            except OSError:
                pass

        _deinit_colorama()
        _replace_stdio_from_dup(saved)
        _sanitize_logging_after_stdio_fix()
    except Exception:
        # Last-resort: ensure sys.std{out,err} point somewhere writable so
        # later logging/uvicorn never hits "I/O on closed file".
        for name in ("stdout", "stderr"):
            stream = getattr(sys, name, None)
            if not _stream_is_usable(stream):
                _assign_devnull_stream(name)


def reconfigure_stdio_utf8() -> None:
    """Re-wrap stdout/stderr as UTF-8 with replacement on unmappable characters."""
    if os.name != "nt" or getattr(sys, "frozen", False):
        return
    for name in ("stdout", "stderr"):
        stream = getattr(sys, name, None)
        if stream is None or not hasattr(stream, "buffer"):
            continue
        if _is_colorama_wrapped(stream):
            continue
        try:
            wrapped = io.TextIOWrapper(
                stream.buffer,
                encoding="utf-8",
                errors="replace",
                line_buffering=True,
            )
            setattr(sys, name, wrapped)
        except Exception:
            pass


def apply_windows_stdio_fixes(*, reconfigure: bool = True) -> None:
    """Call at process entry (gateway EXE, langgraph CLI wrapper) on Windows hosts."""
    apply_windows_stdio_env()
    if getattr(sys, "frozen", False):
        prepare_frozen_process_stdio()
        return
    if reconfigure and os.name == "nt":
        reconfigure_stdio_utf8()
