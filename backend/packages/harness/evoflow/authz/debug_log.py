"""Opt-in authz debug logging (``EVOFLOW_DEBUG_AUTHZ=1``).

Prints identity resolution / session stamp inputs so multi-user 串台 is
visible without turning on global DEBUG. Safe: no tokens/passwords.
"""

from __future__ import annotations

import logging
import os
from typing import Any

logger = logging.getLogger("evoflow.authz.debug")

_TRUTHY = frozenset({"1", "true", "yes", "on"})


def authz_debug_enabled() -> bool:
    raw = (os.getenv("EVOFLOW_DEBUG_AUTHZ") or "").strip().lower()
    return raw in _TRUTHY


def authz_debug(event: str, **fields: Any) -> None:
    if not authz_debug_enabled():
        return
    parts = [f"{k}={fields[k]!r}" for k in sorted(fields) if fields[k] is not None]
    logger.info("[authz-debug] %s %s", event, " ".join(parts))
