"""Subtask stream / 走马灯 / multi-session inject trace.

Default: ``{EVOFLOW_HOME or ~/.evoflow}/logs/subtask-stream.trace.log``
Override: ``EVOFLOW_SUBTASK_STREAM_LOG=/path/to/file.log``

Disable: ``EVOFLOW_SUBTASK_STREAM_TRACE=0``

``[multi-session]`` lines diagnose packaged-desktop session starvation
(inject await path, BG_JOB isolation, live stream count). Startup banner +
errors are also mirrored to ``logs/plugin-control.log`` so install builds
have one obvious place to look.
"""

from __future__ import annotations

import os
import sys
import threading
from datetime import UTC, datetime
from pathlib import Path

_PREFIX = "[subtask-stream]"
_MULTI_PREFIX = "[multi-session]"
_lock = threading.Lock()
_banner_logged = False


def _enabled() -> bool:
    raw = os.getenv("EVOFLOW_SUBTASK_STREAM_TRACE", "1").strip().lower()
    return raw not in ("0", "false", "no", "off")


def subtask_stream_trace_path() -> Path:
    raw = os.getenv("EVOFLOW_SUBTASK_STREAM_LOG", "").strip()
    if raw:
        return Path(raw).expanduser().resolve()
    try:
        from evoflow.config.paths import get_paths

        return (get_paths().base_dir / "logs" / "subtask-stream.trace.log").resolve()
    except Exception:
        home = Path(os.getenv("EVOFLOW_HOME") or Path.home() / ".evoflow")
        return (home / "logs" / "subtask-stream.trace.log").resolve()


def _write(level: str, msg: str, *args: object, prefix: str = _PREFIX) -> None:
    if not _enabled():
        return
    try:
        text = msg % args if args else msg
    except Exception:
        text = f"{msg} {args!r}"
    ts = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
    line = f"{ts} {level} {prefix} {text}\n"
    path = subtask_stream_trace_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with _lock:
            with path.open("a", encoding="utf-8") as f:
                f.write(line)
    except Exception:
        pass


def _mirror_plugin_control(message: str) -> None:
    """Best-effort mirror into plugin-control.log (packaged desktop triage)."""
    try:
        from evoflow.tools.builtins.browser_debug_log import browser_debug_log

        browser_debug_log("py", f"{_MULTI_PREFIX} {message}")
    except Exception:
        pass


def stream_info(msg: str, *args: object) -> None:
    _write("INFO", msg, *args)


def stream_warn(msg: str, *args: object) -> None:
    _write("WARN", msg, *args)


def stream_debug(msg: str, *args: object) -> None:
    _write("DEBUG", msg, *args)


def multi_session_info(msg: str, *args: object, mirror: bool = False) -> None:
    """Write a ``[multi-session]`` line; set ``mirror=True`` for plugin-control too."""
    try:
        text = msg % args if args else msg
    except Exception:
        text = f"{msg} {args!r}"
    _write("INFO", text, prefix=_MULTI_PREFIX)
    if mirror:
        _mirror_plugin_control(text)


def multi_session_warn(msg: str, *args: object, mirror: bool = True) -> None:
    """Warn-level multi-session line (defaults to mirroring plugin-control)."""
    try:
        text = msg % args if args else msg
    except Exception:
        text = f"{msg} {args!r}"
    _write("WARN", text, prefix=_MULTI_PREFIX)
    if mirror:
        _mirror_plugin_control(f"WARN {text}")


def log_multi_session_runtime_banner(*, source: str = "startup") -> None:
    """One-shot concurrency fingerprint so packaged builds prove which path is live."""
    global _banner_logged
    if _banner_logged:
        return
    _banner_logged = True
    frozen = bool(getattr(sys, "frozen", False) or getattr(sys, "_MEIPASS", None))
    lag = ""
    try:
        from evoflow.runtime.ports import get as ports_get

        lag_fn = ports_get("diagnostics.event_loop_lag_seconds")
        if callable(lag_fn):
            lag = f" loop_lag_s={float(lag_fn()):.3f}"
    except Exception:
        pass
    multi_session_info(
        "runtime source=%s frozen=%s gateway_process=%s "
        "FORCE_BG_JOB_ISOLATED_LOOPS=%s BG_JOB_ISOLATED_LOOPS=%s "
        "N_JOBS_PER_WORKER=%s inject_port=awaitable_v1 platform=%s%s",
        source,
        int(frozen),
        (os.getenv("EVOFLOW_GATEWAY_PROCESS") or "").strip() or "-",
        (os.getenv("EVOFLOW_FORCE_BG_JOB_ISOLATED_LOOPS") or "").strip() or "-",
        (os.getenv("BG_JOB_ISOLATED_LOOPS") or "").strip() or "-",
        (os.getenv("N_JOBS_PER_WORKER") or "").strip() or "-",
        sys.platform,
        lag,
        mirror=True,
    )


__all__ = [
    "log_multi_session_runtime_banner",
    "multi_session_info",
    "multi_session_warn",
    "stream_debug",
    "stream_info",
    "stream_warn",
    "subtask_stream_trace_path",
]
