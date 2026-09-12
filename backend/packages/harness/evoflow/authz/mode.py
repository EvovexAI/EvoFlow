"""ACL isolation is always on (multi-user). Mode API kept as no-op compat."""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)

_ISOLATE = "isolate"


def get_acl_mode() -> str:
    """Always isolate; env/settings ignored."""
    return _ISOLATE


def set_acl_mode(mode: str | None = None) -> None:
    """No-op compatibility shim (isolation is permanent)."""
    del mode


def should_filter(mode: str | None = None) -> bool:
    """Always filter by principal / scope membership."""
    del mode
    return True


def should_log(mode: str | None = None) -> bool:
    del mode
    return True


def log_decision(action: str, *, allowed: bool, detail: dict[str, Any] | None = None) -> None:
    if not should_log():
        return
    logger.info(
        "acl.%s decision allowed=%s mode=%s detail=%s",
        action,
        allowed,
        get_acl_mode(),
        detail or {},
    )
