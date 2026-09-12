"""Subtask stream / 走马灯 trace — dedicated file only (does not flood gateway.log).

Default: ``{EVOFLOW_HOME or ~/.evoflow}/logs/subtask-stream.trace.log``
Override: ``EVOFLOW_SUBTASK_STREAM_LOG=/path/to/file.log``

Disable: ``EVOFLOW_SUBTASK_STREAM_TRACE=0``
"""

from __future__ import annotations

import os
import threading
from datetime import UTC, datetime
from pathlib import Path

_PREFIX = "[subtask-stream]"
_lock = threading.Lock()


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


def _write(level: str, msg: str, *args: object) -> None:
    if not _enabled():
        return
    try:
        text = msg % args if args else msg
    except Exception:
        text = f"{msg} {args!r}"
    ts = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
    line = f"{ts} {level} {_PREFIX} {text}\n"
    path = subtask_stream_trace_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with _lock:
            with path.open("a", encoding="utf-8") as f:
                f.write(line)
    except Exception:
        pass


def stream_info(msg: str, *args: object) -> None:
    _write("INFO", msg, *args)


def stream_warn(msg: str, *args: object) -> None:
    _write("WARN", msg, *args)


def stream_debug(msg: str, *args: object) -> None:
    _write("DEBUG", msg, *args)


__all__ = [
    "stream_debug",
    "stream_info",
    "stream_warn",
    "subtask_stream_trace_path",
]
