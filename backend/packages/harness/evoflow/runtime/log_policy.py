"""Unified disk-log policy (align with ZCode): one root, daily names, opt-in debug.

Layout::

    {EVOFLOW_LOGS_DIR or <product>/logs}/
      gateway-YYYY-MM-DD.log          # always-on product logs
      frontend-YYYY-MM-DD.log
      …
      debug/                         # opt-in traces; export excludes
        stream_trace/…
        *.log

Env:

- ``EVOFLOW_LOGS_DIR`` — authoritative log root (desktop sets this).
- ``EVOFLOW_LOG_RETENTION_DAYS`` — default **14** (ZCode desktop parity).
- Debug traces require explicit ``*=1`` / ``true`` (not merely unset).
"""

from __future__ import annotations

import os
import re
from datetime import UTC, datetime, timedelta
from pathlib import Path

DEFAULT_RETENTION_DAYS = 14
DEFAULT_EXPORT_LOOKBACK_DAYS = 3
_DATE_SUFFIX_RE = re.compile(r"^(.+)-(\d{4}-\d{2}-\d{2})\.log$")
_TRUE = {"1", "true", "yes", "on"}
_FALSE = {"0", "false", "no", "off"}


def env_flag(name: str, *, default: bool = False) -> bool:
    raw = (os.environ.get(name) or "").strip().lower()
    if not raw:
        return default
    if raw in _FALSE:
        return False
    if raw in _TRUE:
        return True
    return default


def retention_days() -> int:
    raw = (os.environ.get("EVOFLOW_LOG_RETENTION_DAYS") or "").strip()
    if not raw:
        return DEFAULT_RETENTION_DAYS
    try:
        return max(1, int(raw))
    except ValueError:
        return DEFAULT_RETENTION_DAYS


def resolve_product_logs_dir() -> Path:
    """Single product log root. Prefer ``EVOFLOW_LOGS_DIR``; never hardcode a user path."""
    raw = (os.environ.get("EVOFLOW_LOGS_DIR") or "").strip()
    if raw:
        return Path(raw).expanduser().resolve()

    home = (os.environ.get("EVOFLOW_HOME") or "").strip()
    if home:
        base = Path(home).expanduser().resolve()
        # EVOFLOW_HOME may be …/data or …/data/profiles/<id>
        if base.name.lower() == "data":
            return (base.parent / "logs").resolve()
        return (base / "logs").resolve()

    # Dev vs release home (mirror Tauri evoflow_dir)
    product = Path.home() / (".evoflow-dev" if _looks_like_dev() else ".evoflow")
    return (product / "logs").resolve()


def resolve_debug_logs_dir() -> Path:
    return resolve_product_logs_dir() / "debug"


def _looks_like_dev() -> bool:
    if env_flag("EVOFLOW_DEV", default=False):
        return True
    # Sidecar often inherits panel config dir for -dev
    cfg = (os.environ.get("EVOFLOW_CONFIG_DIR") or "").strip().lower()
    if cfg.endswith(".evoflow-dev") or ".evoflow-dev" in cfg.replace("\\", "/"):
        return True
    return False


def daily_log_name(prefix: str, *, day: datetime | None = None) -> str:
    d = (day or datetime.now()).strftime("%Y-%m-%d")
    return f"{prefix}-{d}.log"


def prune_all_daily_logs(log_dir: Path, *, days: int | None = None) -> int:
    """Delete any ``{prefix}-YYYY-MM-DD.log`` older than retention (filename date)."""
    keep = days if days is not None else retention_days()
    cutoff = datetime.now(UTC).date() - timedelta(days=keep)
    removed = 0
    if not log_dir.is_dir():
        return 0
    for path in log_dir.iterdir():
        if not path.is_file():
            continue
        m = _DATE_SUFFIX_RE.match(path.name)
        if not m:
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


def prune_old_daily_logs(log_dir: Path, base_name: str, *, days: int | None = None) -> int:
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
