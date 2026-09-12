"""Status / readiness probe for the host OS execution security layer."""

from __future__ import annotations

import sys
from typing import Any

from evoflow.execution_security.config import (
    get_execution_security_config,
    is_execution_security_active,
    resolved_ask,
    resolved_profile_id,
)
from evoflow.execution_security.helpers import discover_helpers


def _platform_notes(ready: bool, *, active: bool, auto: bool, enabled: bool) -> str:
    if sys.platform.startswith("linux"):
        helper_hint = (
            "Ready."
            if ready
            else "Build evoflow-linux-sandbox (scripts/build-sandbox-helpers.sh) for local tests."
        )
    elif sys.platform == "win32":
        helper_hint = (
            "Ready (restricted-token)."
            if ready
            else "Build evoflow-windows-sandbox (scripts/windows/build-sandbox-helpers.ps1) for local tests — not a runtime product dependency."
        )
    elif sys.platform == "darwin":
        helper_hint = "macOS Seatbelt policy generation not packaged yet; host shell stays passthrough."
    else:
        helper_hint = f"Unsupported platform: {sys.platform}"

    if active and not enabled and auto and ready:
        return f"{helper_hint} Auto-enabled (helper ready), like runtime Default; chat permission pill picks the profile."
    if not active and auto and not ready:
        return f"{helper_hint} Auto-enable is on, but helpers are missing - host shell stays passthrough until helpers are installed."
    return helper_hint


def execution_security_status() -> dict[str, Any]:
    """Return a JSON-serializable snapshot for settings / diagnostics.

    Re-applies SQLite ``execution.security`` first so Settings UI matches the
    persisted toggle even if in-memory config was left at YAML defaults (e.g.
    overlay skipped during an early config load).
    """
    try:
        from evoflow.execution_security.persist import (
            apply_persisted_execution_security_overrides,
        )

        apply_persisted_execution_security_overrides()
    except Exception:
        pass

    cfg = get_execution_security_config()
    helpers = discover_helpers(helper_dir=cfg.helper_dir)
    ready = helpers.platform_ready
    active = is_execution_security_active(cfg)
    if active and ready:
        mode = "sandboxed"
    elif active and cfg.allow_passthrough:
        mode = "passthrough"
    elif active:
        mode = "blocked"
    else:
        mode = "disabled"

    return {
        "enabled": cfg.enabled,
        "active": active,
        "auto_enable_when_helpers_ready": cfg.auto_enable_when_helpers_ready,
        "mode": mode,
        "profile": resolved_profile_id(cfg),
        "approval": resolved_ask(cfg).value,
        "windows_level": cfg.windows_level,
        "allow_passthrough": cfg.allow_passthrough,
        "platform": sys.platform,
        "helpers_ready": ready,
        "helpers": {
            "helper_dir": str(helpers.helper_dir) if helpers.helper_dir else None,
            "linux_sandbox": str(helpers.linux_sandbox) if helpers.linux_sandbox else None,
            "windows_sandbox": str(helpers.windows_sandbox) if helpers.windows_sandbox else None,
            "seatbelt_exec": str(helpers.seatbelt_exec) if helpers.seatbelt_exec else None,
        },
        "notes": _platform_notes(
            ready,
            active=active,
            auto=cfg.auto_enable_when_helpers_ready,
            enabled=cfg.enabled,
        ),
    }
