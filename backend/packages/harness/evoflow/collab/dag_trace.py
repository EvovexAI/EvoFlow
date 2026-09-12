"""Collab DAG trace — writes ONLY to a dedicated file (does not flood main logs).

Default path: ``{EVOFLOW_HOME or ~/.evoflow}/logs/collab-dag.trace.log``
Override: ``EVOFLOW_COLLAB_DAG_LOG=/path/to/file.log``
"""

from __future__ import annotations

import os
import threading
from datetime import UTC, datetime
from pathlib import Path

_PREFIX = "[collab-dag]"
_lock = threading.Lock()


def collab_dag_trace_path() -> Path:
    raw = os.getenv("EVOFLOW_COLLAB_DAG_LOG", "").strip()
    if raw:
        return Path(raw).expanduser().resolve()
    try:
        from evoflow.config.paths import get_paths

        return (get_paths().base_dir / "logs" / "collab-dag.trace.log").resolve()
    except Exception:
        home = Path(os.getenv("EVOFLOW_HOME") or Path.home() / ".evoflow")
        return (home / "logs" / "collab-dag.trace.log").resolve()


def _write(level: str, msg: str, *args: object) -> None:
    try:
        text = msg % args if args else msg
    except Exception:
        text = f"{msg} {args!r}"
    ts = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
    line = f"{ts} {level} {_PREFIX} {text}\n"
    path = collab_dag_trace_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with _lock:
            with path.open("a", encoding="utf-8") as f:
                f.write(line)
    except Exception:
        pass


def dag_info(msg: str, *args: object) -> None:
    _write("INFO", msg, *args)


def dag_warning(msg: str, *args: object) -> None:
    _write("WARN", msg, *args)


def dag_error(msg: str, *args: object) -> None:
    _write("ERROR", msg, *args)


def dag_debug(msg: str, *args: object) -> None:
    _write("DEBUG", msg, *args)
