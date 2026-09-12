"""Thread run-queue diagnostics — ``~/.evoflow/logs/thread-run-queue.log``.

When a chat sticks on UI「准备中…」with no agent logs, this file shows whether the
new run was still waiting behind an older pending/running run (enqueue HOL), or
never got ``lg_queue_claim``.

Env:

- ``EVOFLOW_THREAD_RUN_QUEUE_LOG``: ``0`` / ``false`` / ``off`` disables file log.
- ``EVOFLOW_THREAD_RUN_QUEUE_LOG_FILE``: full path override.
- ``EVOFLOW_THREAD_RUN_QUEUE_LOG_DIR`` or ``EVOFLOW_LOGS_DIR``: directory.
"""

from __future__ import annotations

import logging
import os
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

_LOGGER_NAME = "evoflow.thread_run_queue"
_CONFIGURED = False
_FILE_LOCK = threading.Lock()

# Claim wait above this is almost always head-of-line blocking (zombie prior run).
_SLOW_CLAIM_MS = 2_000.0


def _file_logging_disabled() -> bool:
    raw = (os.getenv("EVOFLOW_THREAD_RUN_QUEUE_LOG") or "").strip().lower()
    return raw in {"0", "false", "off", "no"}


def _resolve_log_path() -> Path:
    override = (os.getenv("EVOFLOW_THREAD_RUN_QUEUE_LOG_FILE") or "").strip()
    if override:
        return Path(override).expanduser()
    for key in ("EVOFLOW_THREAD_RUN_QUEUE_LOG_DIR", "EVOFLOW_LOGS_DIR"):
        d = (os.getenv(key) or "").strip()
        if d:
            return Path(d).expanduser() / "thread-run-queue.log"
    home = (os.getenv("EVOFLOW_HOME") or "").strip()
    if home:
        return Path(home).expanduser() / "logs" / "thread-run-queue.log"
    return Path.home() / ".evoflow" / "logs" / "thread-run-queue.log"


def _ensure_logger() -> logging.Logger:
    global _CONFIGURED
    log = logging.getLogger(_LOGGER_NAME)
    if _CONFIGURED or _file_logging_disabled():
        return log
    with _FILE_LOCK:
        if _CONFIGURED:
            return log
        path = _resolve_log_path()
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            fh = logging.FileHandler(path, encoding="utf-8")
            fh.setFormatter(logging.Formatter("%(message)s"))
            log.setLevel(logging.INFO)
            log.handlers.clear()
            log.addHandler(fh)
            log.propagate = False
            _CONFIGURED = True
            log.info(
                "%s | thread-run-queue | ready path=%s",
                _now(),
                path,
            )
        except Exception:
            logging.getLogger(__name__).debug(
                "thread-run-queue log setup failed", exc_info=True
            )
            _CONFIGURED = True
    return log


def _now() -> str:
    return datetime.now(timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M:%S")


def _fmt_fields(fields: dict[str, Any]) -> str:
    parts: list[str] = []
    for k, v in fields.items():
        if v is None or v == "":
            continue
        if isinstance(v, bool):
            parts.append(f"{k}={'Y' if v else 'N'}")
        elif isinstance(v, float):
            parts.append(f"{k}={v:.1f}" if abs(v) >= 10 else f"{k}={v:.2f}")
        else:
            text = str(v).replace("\n", " ").strip()
            if len(text) > 180:
                text = text[:177] + "..."
            parts.append(f"{k}={text}")
    return " ".join(parts)


def log_thread_run_queue(event: str, *, level: int = logging.INFO, **fields: Any) -> None:
    """Append one line to ``thread-run-queue.log`` (and logger)."""
    if _file_logging_disabled():
        return
    log = _ensure_logger()
    tid = str(fields.pop("thread_id", "") or "").strip()
    sk = str(fields.pop("session_key", "") or "").strip()
    rid = str(fields.pop("run_id", "") or "").strip()
    head = [_now(), "run-queue", event]
    if tid:
        head.append(f"thread={tid[:36]}")
    if sk:
        head.append(f"session={sk}")
    if rid:
        head.append(f"run={rid[:36]}")
    line = " | ".join(head)
    body = _fmt_fields(fields)
    msg = f"{line}\n  {body}" if body else line
    try:
        log.log(level, msg)
    except Exception:
        pass


def log_slow_queue_claim_if_needed(*, pending_age_ms: float | None, **fields: Any) -> None:
    """Warn when claim happens long after run create (classic enqueue HOL)."""
    age = float(pending_age_ms) if pending_age_ms is not None else 0.0
    lvl = logging.WARNING if age >= _SLOW_CLAIM_MS else logging.INFO
    log_thread_run_queue(
        "lg_queue_claim",
        level=lvl,
        pending_age_ms=age,
        slow_claim=age >= _SLOW_CLAIM_MS,
        **fields,
    )
