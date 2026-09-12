"""Where structured debug/trace rows go: SQLite (default) vs optional file mirror."""

from __future__ import annotations

import os
from pathlib import Path


def _env_bool(name: str) -> bool | None:
    raw = (os.environ.get(name) or "").strip().lower()
    if raw in ("1", "true", "yes", "on"):
        return True
    if raw in ("0", "false", "no", "off"):
        return False
    return None


def observability_enabled() -> bool:
    """Whether SQLite observability may open/write ``evoflow_observability.db``.

    Default is **off** (user installs). Enable via ``observability.enabled: true``
    or ``EVOFLOW_OBSERVABILITY=1``. Env overrides config when set.
    """
    env = _env_bool("EVOFLOW_OBSERVABILITY")
    if env is not None:
        return env
    try:
        from evoflow.config.app_config import get_app_config

        return bool(get_app_config().observability.enabled)
    except Exception:
        return False


def file_mirror_enabled() -> bool:
    """True only when explicitly opted in (``observability.file_mirror`` or env).

    Default is **off**: no ``logs/debug/threads/<id>/`` JSONL when using SQLite observability.
    """
    env = _env_bool("EVOFLOW_DEBUG_FILE_MIRROR")
    if env is not None:
        return env
    try:
        from evoflow.config.app_config import get_app_config

        return bool(get_app_config().observability.file_mirror)
    except Exception:
        return False


def should_write_debug_files() -> bool:
    """Whether to append per-thread files under ``logs/debug/threads/``."""
    return file_mirror_enabled()


def observability_reads_primary() -> bool:
    """Agent-trace and similar UIs read SQLite instead of log files."""
    return observability_enabled()


def debug_log_root() -> Path:
    """Single directory for any optional debug files (``{root}/logs/debug/...``)."""
    try:
        from evoflow.config.paths import get_paths

        bd = get_paths().base_dir
        if bd:
            return Path(bd).resolve()
    except Exception:
        pass
    return Path(__file__).resolve().parents[5]


def debug_file_path(*relative_under_debug: str) -> Path:
    """``<base_dir>/logs/debug/<relative_under_debug>`` (one root only)."""
    return debug_log_root() / "logs" / "debug" / Path(*relative_under_debug)
