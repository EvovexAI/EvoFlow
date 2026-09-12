"""Execution security configuration (config.yaml ``execution_security`` section)."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

from evoflow.execution_security.approval import AskForApproval, normalize_ask
from evoflow.execution_security.profiles import (
    PROFILE_WORKSPACE,
    PermissionProfileId,
    normalize_profile_id,
)

WindowsSandboxLevel = Literal["restricted-token", "elevated"]


class ExecutionSecurityConfig(BaseModel):
    """Host-path OS sandbox + approval settings (not a runtime product dependency).

    Container (AIO) paths stay on ``sandbox:`` / AioSandboxProvider; this
    section only governs **host** shell execution.
    """

    enabled: bool = Field(
        default=False,
        description="Force-on OS sandbox for host terminal (independent of helper auto-detect).",
    )
    profile: str = Field(
        default=PROFILE_WORKSPACE,
        description="Permission profile: read-only | workspace | danger-full-access",
    )
    approval: str = Field(
        default=AskForApproval.ON_REQUEST.value,
        description="AskForApproval: untrusted | on-request | never",
    )
    windows_level: WindowsSandboxLevel = Field(
        default="restricted-token",
        description="Windows sandbox level: restricted-token (default) or elevated",
    )
    helper_dir: str | None = Field(
        default=None,
        description="Directory containing evoflow-*-sandbox helpers (override search path)",
    )
    allow_passthrough: bool = Field(
        default=True,
        description="If helpers are missing, run on host without OS jail",
    )
    auto_enable_when_helpers_ready: bool = Field(
        default=True,
        description=(
            "native-like default: when platform helpers are present, host terminal "
            "uses OS sandbox without a separate toggle. Session chat presets still "
            "pick the profile (read-only / workspace / full-access)."
        ),
    )


_execution_security_config: ExecutionSecurityConfig = ExecutionSecurityConfig()


def get_execution_security_config() -> ExecutionSecurityConfig:
    return _execution_security_config


def set_execution_security_config(config: ExecutionSecurityConfig) -> None:
    global _execution_security_config
    _execution_security_config = config


def load_execution_security_config_from_dict(config_dict: dict) -> None:
    global _execution_security_config
    raw = dict(config_dict or {})
    if "profile" in raw:
        raw["profile"] = normalize_profile_id(raw.get("profile"))
    if "approval" in raw:
        raw["approval"] = normalize_ask(raw.get("approval")).value
    level = str(raw.get("windows_level") or "restricted-token").strip().lower().replace("_", "-")
    # Accept short aliases used in product copy.
    if level in ("restricted", "unelevated", "default"):
        level = "restricted-token"
    if level not in ("restricted-token", "elevated"):
        level = "restricted-token"
    raw["windows_level"] = level
    _execution_security_config = ExecutionSecurityConfig(**raw)


def resolved_profile_id(cfg: ExecutionSecurityConfig | None = None) -> PermissionProfileId:
    c = cfg or get_execution_security_config()
    return normalize_profile_id(c.profile)


def resolved_ask(cfg: ExecutionSecurityConfig | None = None) -> AskForApproval:
    c = cfg or get_execution_security_config()
    return normalize_ask(c.approval)


def is_execution_security_active(cfg: ExecutionSecurityConfig | None = None) -> bool:
    """Whether host shell should prefer OS sandbox helpers (explicit or auto-ready)."""
    c = cfg or get_execution_security_config()
    if c.enabled:
        return True
    if not c.auto_enable_when_helpers_ready:
        return False
    from evoflow.execution_security.helpers import discover_helpers

    return discover_helpers(helper_dir=c.helper_dir).platform_ready


def resolve_execution_security_for_session(session_key: str | None) -> ExecutionSecurityConfig:
    """Merge global execution_security with session runtime preset (profile + approval)."""
    base = get_execution_security_config()
    sk = str(session_key or "").strip()
    if not sk:
        return base
    try:
        from evoflow.persistence.permission_preset_store import effective_preset_spec

        spec = effective_preset_spec(sk)
    except Exception:
        return base
    return base.model_copy(
        update={
            "profile": spec.execution_profile,
            "approval": spec.execution_approval.value,
        }
    )


def resolve_execution_security_for_thread(thread_id: str | None) -> ExecutionSecurityConfig:
    from evoflow.persistence.session_repositories import find_session_key_by_thread_id

    tid = str(thread_id or "").strip()
    if not tid:
        return get_execution_security_config()
    sk = find_session_key_by_thread_id(tid)
    return resolve_execution_security_for_session(sk)

