"""Where structured debug/trace rows go: SQLite (default) vs optional file mirror."""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any

import yaml

logger = logging.getLogger(__name__)


def _env_bool(name: str) -> bool | None:
    raw = (os.environ.get(name) or "").strip().lower()
    if raw in ("1", "true", "yes", "on"):
        return True
    if raw in ("0", "false", "no", "off"):
        return False
    return None


def observability_env_override() -> bool | None:
    """Return ``EVOFLOW_OBSERVABILITY`` when set; otherwise ``None`` (use config.yaml)."""
    return _env_bool("EVOFLOW_OBSERVABILITY")


def observability_enabled() -> bool:
    """Whether SQLite observability may open/write ``evoflow_observability.db``.

    Default is **off** (user installs). Enable via ``observability.enabled: true``
    or ``EVOFLOW_OBSERVABILITY=1``. Env overrides config when set.
    """
    env = observability_env_override()
    if env is not None:
        return env
    try:
        from evoflow.config.app_config import get_app_config

        return bool(get_app_config().observability.enabled)
    except Exception:
        return False


def set_observability_enabled(enabled: bool) -> dict[str, Any]:
    """Persist ``observability.enabled`` into bootstrap ``config.yaml`` and reload.

    Env ``EVOFLOW_OBSERVABILITY`` always wins — when set, refuse the write and
    report ``locked_by_env`` so the panel can disable the toggle.
    """
    want = bool(enabled)
    env = observability_env_override()
    if env is not None:
        return {
            "ok": False,
            "enabled": bool(env),
            "locked_by_env": True,
            "error": "EVOFLOW_OBSERVABILITY overrides config; unset the env to use the UI toggle",
        }

    from evoflow.config.app_config import AppConfig, get_app_config, reload_app_config

    config_path = AppConfig.resolve_config_path()
    try:
        with open(config_path, encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}
        if not isinstance(data, dict):
            data = {}
        obs = data.get("observability")
        if not isinstance(obs, dict):
            obs = {}
        obs["enabled"] = want
        data["observability"] = obs
        with open(config_path, "w", encoding="utf-8") as f:
            yaml.dump(data, f, default_flow_style=False, allow_unicode=True, sort_keys=False)
    except Exception as exc:
        logger.exception("Failed to write observability.enabled to %s", config_path)
        return {
            "ok": False,
            "enabled": observability_enabled(),
            "locked_by_env": False,
            "error": str(exc),
        }

    try:
        # Keep in-memory model aligned even if mtime race skips reload.
        cfg = get_app_config()
        cfg.observability.enabled = want
    except Exception:
        pass
    reload_app_config()

    effective = observability_enabled()
    return {
        "ok": True,
        "enabled": effective,
        "locked_by_env": False,
        "config_path": str(config_path),
    }


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
