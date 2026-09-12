"""Persist UI-editable ``execution_security`` overrides in SQLite app settings.

YAML ``execution_security`` is the bootstrap default; settings UI writes
``execution.security`` and reapplies into the in-memory config on load / PATCH.
"""

from __future__ import annotations

from typing import Any

from evoflow.execution_security.config import (
    ExecutionSecurityConfig,
    get_execution_security_config,
    load_execution_security_config_from_dict,
    set_execution_security_config,
)

EXECUTION_SECURITY_SETTINGS_KEY = "execution.security"

# Fields the security-center UI may change (helper_dir stays YAML/env only).
_EDITABLE_KEYS = (
    "enabled",
    "profile",
    "approval",
    "windows_level",
    "allow_passthrough",
    "auto_enable_when_helpers_ready",
)


def _cfg_repo():
    # Lazy import — avoid circular import via evoflow.config ↔ persistence.
    from evoflow.persistence import config_repositories as cfg_repo

    return cfg_repo


def _sanitize_patch(patch: dict[str, Any] | None) -> dict[str, Any]:
    if not isinstance(patch, dict):
        return {}
    out: dict[str, Any] = {}
    for key in _EDITABLE_KEYS:
        if key not in patch:
            continue
        out[key] = patch[key]
    return out


def load_persisted_execution_security_overrides() -> dict[str, Any]:
    raw = _cfg_repo().get_app_setting(EXECUTION_SECURITY_SETTINGS_KEY)
    return _sanitize_patch(raw if isinstance(raw, dict) else None)


def apply_persisted_execution_security_overrides() -> ExecutionSecurityConfig:
    """Merge SQLite overrides onto the current in-memory config (after YAML load)."""
    overrides = load_persisted_execution_security_overrides()
    if not overrides:
        return get_execution_security_config()
    base = get_execution_security_config().model_dump()
    base.update(overrides)
    load_execution_security_config_from_dict(base)
    return get_execution_security_config()


def patch_execution_security_settings(patch: dict[str, Any] | None) -> dict[str, Any]:
    """Deep-apply editable fields: memory + SQLite. Returns live status snapshot."""
    clean = _sanitize_patch(patch)
    if not clean:
        from evoflow.execution_security.status import execution_security_status

        return execution_security_status()

    base = get_execution_security_config().model_dump()
    base.update(clean)
    load_execution_security_config_from_dict(base)

    stored = load_persisted_execution_security_overrides()
    stored.update(clean)
    _cfg_repo().set_app_setting(EXECUTION_SECURITY_SETTINGS_KEY, stored)

    from evoflow.execution_security.status import execution_security_status

    return execution_security_status()


def reset_execution_security_to_yaml_defaults_for_tests() -> None:
    """Test helper: clear SQLite overlay and restore default in-memory config."""
    try:
        _cfg_repo().set_app_setting(EXECUTION_SECURITY_SETTINGS_KEY, {})
    except Exception:
        pass
    set_execution_security_config(ExecutionSecurityConfig())
