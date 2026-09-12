"""Gateway / LangGraph file logging: daily files, 7-day retention, full uvicorn + app output."""

from __future__ import annotations

import logging
import os
import re
import sys
import threading
import time
from datetime import UTC, datetime, timedelta
from logging import Filter, Handler, LogRecord
from pathlib import Path

_CONFIGURED: dict[str, bool] = {}
_LOG_DIR: Path | None = None

DEFAULT_RETENTION_DAYS = 7
_DATE_SUFFIX_RE = re.compile(r"^(.+)-(\d{4}-\d{2}-\d{2})\.log$")


def resolve_gateway_logs_dir() -> Path:
    """Resolve directory for log files.

    Priority:
        1. ``EVOFLOW_LOGS_DIR``
        2. ``<EVOFLOW_HOME>/logs``
        3. ``<repo-root>/logs`` (config.example.yaml or Makefile + backend/)
        4. ``<cwd>/logs``
    """
    raw = (os.getenv("EVOFLOW_LOGS_DIR") or "").strip()
    if raw:
        return Path(raw).expanduser().resolve()

    evoflow_home = (os.getenv("EVOFLOW_HOME") or "").strip()
    if evoflow_home:
        from evoflow.config.data_paths import logs_dir, resolve_data_base_dir

        return logs_dir(resolve_data_base_dir())

    cwd = Path.cwd().resolve()
    for base in (cwd, cwd.parent, cwd.parent.parent, cwd.parent.parent.parent):
        if (base / "config.example.yaml").is_file():
            return (base / "logs").resolve()
        if (base / "Makefile").is_file() and (base / "backend").is_dir():
            return (base / "logs").resolve()
    return (cwd / "logs").resolve()


def retention_days() -> int:
    raw = (os.getenv("EVOFLOW_LOG_RETENTION_DAYS") or "").strip()
    if not raw:
        return DEFAULT_RETENTION_DAYS
    try:
        return max(1, int(raw))
    except ValueError:
        return DEFAULT_RETENTION_DAYS


def prune_old_daily_logs(log_dir: Path, base_name: str, *, days: int | None = None) -> int:
    """Delete ``{base_name}-YYYY-MM-DD.log`` older than ``days`` (default 7). Returns removed count."""
    keep = days if days is not None else retention_days()
    cutoff = datetime.now(UTC).date() - timedelta(days=keep)
    removed = 0
    if not log_dir.is_dir():
        return 0
    for path in log_dir.iterdir():
        if not path.is_file():
            continue
        m = _DATE_SUFFIX_RE.match(path.name)
        if not m or m.group(1) != base_name:
            continue
        try:
            file_date = datetime.strptime(m.group(2), "%Y-%m-%d").date()
        except ValueError:
            continue
        if file_date < cutoff:
            try:
                path.unlink()
                removed += 1
            except OSError:
                pass
    return removed


def _log_flush_interval_s() -> float:
    """Seconds between INFO flushes (WARNING+ always flush). 0 = flush every line."""
    raw = (os.getenv("EVOFLOW_LOG_FLUSH_INTERVAL_S") or "1").strip()
    try:
        return max(0.0, float(raw))
    except ValueError:
        return 1.0


class DailyNamedFileHandler(Handler):
    """Append to ``{log_dir}/{base_name}-YYYY-MM-DD.log`` (one file per calendar day)."""

    def __init__(self, log_dir: Path, base_name: str, *, retention_days: int = DEFAULT_RETENTION_DAYS) -> None:
        super().__init__(level=logging.DEBUG)
        self.log_dir = log_dir.resolve()
        self.base_name = base_name
        self.retention_days = retention_days
        self._lock = threading.RLock()
        self._current_date: str | None = None
        self._stream = None
        self._last_flush_mono = 0.0
        self._flush_interval_s = _log_flush_interval_s()

    def _path_for(self, date_str: str) -> Path:
        return self.log_dir / f"{self.base_name}-{date_str}.log"

    def _ensure_stream(self) -> None:
        today = datetime.now().strftime("%Y-%m-%d")
        if self._current_date == today and self._stream is not None:
            return
        with self._lock:
            if self._current_date == today and self._stream is not None:
                return
            if self._stream is not None:
                try:
                    self._stream.close()
                except OSError:
                    pass
                self._stream = None
            self.log_dir.mkdir(parents=True, exist_ok=True)
            prune_old_daily_logs(self.log_dir, self.base_name, days=self.retention_days)
            path = self._path_for(today)
            self._stream = path.open("a", encoding="utf-8", newline="\n")
            self._current_date = today

    def emit(self, record: LogRecord) -> None:
        try:
            self._ensure_stream()
            if self._stream is None:
                return
            msg = self.format(record)
            with self._lock:
                self._stream.write(msg + "\n")
                # Flush every line was a major idle-IO amplifier (scheduler INFO ticks).
                # WARNING+ always flush; INFO/DEBUG coalesce to EVOFLOW_LOG_FLUSH_INTERVAL_S.
                interval = self._flush_interval_s
                now = time.monotonic()
                force = record.levelno >= logging.WARNING or interval <= 0
                if force or (now - self._last_flush_mono) >= interval:
                    self._stream.flush()
                    self._last_flush_mono = now
        except Exception:
            self.handleError(record)

    def close(self) -> None:
        with self._lock:
            if self._stream is not None:
                try:
                    self._stream.close()
                except OSError:
                    pass
                self._stream = None
            self._current_date = None
        super().close()


def _service_base_name(log_name: str) -> str:
    stem = (log_name or "gateway").strip()
    if stem.endswith(".log"):
        stem = stem[: -len(".log")]
    return stem or "gateway"


def _same_daily_handler(h: Handler, log_dir: Path, base_name: str) -> bool:
    if not isinstance(h, DailyNamedFileHandler):
        return False
    return h.log_dir == log_dir.resolve() and h.base_name == base_name


# Dev file watchers (uvicorn reload, code_index, langgraph) spam INFO on every save.
_QUIET_LOGGER_LEVELS: dict[str, int] = {
    "watchfiles": logging.WARNING,
    "watchfiles.main": logging.WARNING,
    "app.gateway.events.task_event_handlers": logging.WARNING,
    "app.gateway.events.event_queue": logging.WARNING,
    # LangGraph startup / internal status spam
    "langgraph_runtime": logging.CRITICAL,
    "langgraph_runtime_inmem": logging.CRITICAL,
    "langgraph_runtime_inmem.queue": logging.CRITICAL,
    "langgraph_runtime_inmem.lifespan": logging.CRITICAL,
    "langgraph_api.auth": logging.WARNING,
    "langgraph_api.auth.middleware": logging.WARNING,
    "langgraph_api.metadata": logging.WARNING,
    "langgraph_api.cron_scheduler": logging.WARNING,
    "langgraph_api._checkpointer": logging.WARNING,
    "langgraph_api._checkpointer._adapter": logging.WARNING,
    "uvicorn.error": logging.WARNING,
    # Access stays INFO so real API traffic remains visible; PanelPollAccessNoiseFilter
    # drops high-frequency frontend poll 200s (busy / work-board / execution/state / …).
    "httpx": logging.WARNING,
    # Harness config startup noise
    "evoflow.config.subagents_config": logging.WARNING,
    "evoflow.config.acp_config": logging.WARNING,
    # Stream wire/mirror frame-by-frame logging — extremely verbose (102MB/day)
    "evoflow.stream_wire": logging.WARNING,
    "evoflow.stream_mirror": logging.WARNING,
    # LangGraph internal noise
    "langgraph_api.worker": logging.WARNING,
    "langgraph_api.timing": logging.WARNING,
    "langgraph_api.timing.timer": logging.WARNING,
    "langgraph_api.auth.custom": logging.WARNING,
    "langgraph_api.models": logging.WARNING,
    "langgraph_api.models.run": logging.WARNING,
}


class LangGraphPollNoiseFilter(Filter):
    def filter(self, record: LogRecord) -> bool:
        if os.getenv("EVOFLOW_SHOW_LANGGRAPH_POLL_LOGS", "").strip().lower() in {"1", "true", "yes", "on"}:
            return True
        if record.name != "langgraph_api.server" or record.levelno > logging.INFO:
            return True
        message = record.getMessage()
        if " 200 " not in message:
            return True
        if "GET /threads/" not in message:
            return True
        return not ("/state " in message or "/runs " in message)


# Panel / ChatApp high-frequency polls — hide successful GETs (set EVOFLOW_SHOW_PANEL_POLL_LOGS=1 to keep).
_PANEL_POLL_ACCESS_RE = re.compile(
    r'"GET\s+(?:/api)?/(?:'
    r'health/liveness|'
    r'(?:api/)?session-notifications|'
    r'(?:api/)?proactive/roles/[^/\s"]+/(?:busy|work-board)|'
    r'(?:api/)?chat/sessions/[^/\s"]+/execution/state'
    r')(?:\?[^"]*)?\s+HTTP/[^"]+"\s+200\b',
    re.IGNORECASE,
)


class PanelPollAccessNoiseFilter(Filter):
    """Drop 200 OK access lines for frontend status polls (busy / work-board / execution/state / …)."""

    def filter(self, record: LogRecord) -> bool:
        if os.getenv("EVOFLOW_SHOW_PANEL_POLL_LOGS", "").strip().lower() in {"1", "true", "yes", "on"}:
            return True
        if record.levelno > logging.INFO:
            return True
        try:
            message = record.getMessage()
        except Exception:
            return True
        if " 200" not in message or "GET " not in message:
            return True
        return _PANEL_POLL_ACCESS_RE.search(message) is None


def _has_filter(handler: Handler, filter_type: type[Filter]) -> bool:
    return any(isinstance(f, filter_type) for f in getattr(handler, "filters", []))


def _quiet_noisy_loggers() -> None:
    for name, lvl in _QUIET_LOGGER_LEVELS.items():
        logging.getLogger(name).setLevel(lvl)


def _attach_noise_filters(root: logging.Logger) -> None:
    for handler in root.handlers:
        if not _has_filter(handler, LangGraphPollNoiseFilter):
            handler.addFilter(LangGraphPollNoiseFilter())
        if not _has_filter(handler, PanelPollAccessNoiseFilter):
            handler.addFilter(PanelPollAccessNoiseFilter())
    # Logger-level filters survive uvicorn re-attaching StreamHandlers.
    for name in ("uvicorn.access", "langgraph_api.server"):
        lg = logging.getLogger(name)
        if not _has_filter(lg, PanelPollAccessNoiseFilter):
            lg.addFilter(PanelPollAccessNoiseFilter())
        for handler in lg.handlers:
            if not _has_filter(handler, PanelPollAccessNoiseFilter):
                handler.addFilter(PanelPollAccessNoiseFilter())


def _wire_logger_tree(root: logging.Logger, level: int) -> None:
    """Ensure uvicorn / langgraph / evoflow loggers propagate to root (complete file capture)."""
    root.setLevel(level)
    for name in (
        "uvicorn",
        "uvicorn.error",
        "uvicorn.access",
        "fastapi",
        "langgraph",
        "langgraph_api",
        "langgraph_runtime",
        "evoflow",
        "app",
    ):
        lg = logging.getLogger(name)
        # Do not bump quiet loggers (e.g. uvicorn.error WARNING) back to root INFO.
        if name not in _QUIET_LOGGER_LEVELS:
            lg.setLevel(level)
        lg.propagate = True
    _quiet_noisy_loggers()
    # Access: single sink via root — drop uvicorn's own handlers to stop duplicate lines
    # ("200 OK" from uvicorn handler + "200" from root).
    access = logging.getLogger("uvicorn.access")
    access.setLevel(logging.INFO)
    for h in list(access.handlers):
        access.removeHandler(h)
        try:
            h.close()
        except Exception:
            pass
    access.propagate = True
    # Single-process: LangGraph access logs live under langgraph_api.server (structlog).
    # Must be INFO even when parent langgraph_api is set WARNING by _QUIET_LOGGER_LEVELS.
    lg_srv = logging.getLogger("langgraph_api.server")
    lg_srv.setLevel(logging.INFO)
    lg_srv.propagate = True
    lg_err = logging.getLogger("langgraph_api.errors")
    lg_err.setLevel(logging.INFO)
    lg_err.propagate = True
    # Re-apply quiet after INFO bumps above (access intentionally stays INFO).
    _quiet_noisy_loggers()
    access.setLevel(logging.INFO)

def configure_gateway_file_logging(
    *,
    log_dir: Path | None = None,
    log_name: str = "gateway.log",
    force: bool = False,
) -> Path:
    """Attach daily file + console handlers to the root logger (idempotent per ``base_name``).

    Creates ``{log_dir}/{base}-YYYY-MM-DD.log`` and deletes files older than 7 days.
    ``log_name`` stem becomes the daily file prefix (e.g. ``gateway.log`` → ``gateway-2026-05-17.log``).
    """
    global _LOG_DIR
    base_name = _service_base_name(log_name)
    if _CONFIGURED.get(base_name) and not force:
        return (_LOG_DIR or resolve_gateway_logs_dir()).resolve()

    log_dir = (log_dir or resolve_gateway_logs_dir()).resolve()
    log_dir.mkdir(parents=True, exist_ok=True)
    _LOG_DIR = log_dir

    level_name = (os.getenv("EVOFLOW_GATEWAY_LOG_LEVEL") or os.getenv("LOG_LEVEL") or "INFO").upper()
    level = getattr(logging, level_name, logging.INFO)

    fmt = logging.Formatter(
        "%(asctime)s - %(name)s - %(levelname)s - %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    root = logging.getLogger()
    _wire_logger_tree(root, level)

    has_file = any(_same_daily_handler(h, log_dir, base_name) for h in root.handlers)
    if force:
        for h in list(root.handlers):
            if _same_daily_handler(h, log_dir, base_name):
                root.removeHandler(h)
                try:
                    h.close()
                except Exception:
                    pass
        has_file = False

    if not has_file:
        fh = DailyNamedFileHandler(log_dir, base_name, retention_days=retention_days())
        fh.setFormatter(fmt)
        root.addHandler(fh)
    _attach_noise_filters(root)

    # Desktop EXE / Tauri sidecar redirect stderr to log files; skip console handler to
    # avoid GBK UnicodeEncodeError from colorama on zh-CN Windows (langgraph emoji logs).
    attach_console = True
    if getattr(sys, "frozen", False):
        attach_console = False
    elif (os.getenv("EVOFLOW_LOGS_DIR") or "").strip():
        attach_console = False
    elif os.getenv("EVOFLOW_DISABLE_CONSOLE_LOG", "").strip().lower() in ("1", "true", "yes"):
        attach_console = False

    has_stream = any(
        isinstance(h, logging.StreamHandler)
        and not isinstance(h, DailyNamedFileHandler)
        and getattr(h, "stream", None) in (sys.stdout, sys.stderr)
        for h in root.handlers
    )
    if attach_console and not has_stream:
        sh = logging.StreamHandler(sys.stderr)
        sh.setLevel(level)
        sh.setFormatter(fmt)
        root.addHandler(sh)
    _attach_noise_filters(root)

    today = datetime.now().strftime("%Y-%m-%d")
    logging.getLogger(__name__).info(
        "File logging enabled: %s (retention=%sd)",
        log_dir / f"{base_name}-{today}.log",
        retention_days(),
    )
    _CONFIGURED[base_name] = True
    return log_dir


# Back-compat alias used by packaging entrypoints
configure_file_logging = configure_gateway_file_logging
