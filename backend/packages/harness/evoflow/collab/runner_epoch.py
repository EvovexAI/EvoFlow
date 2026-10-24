"""Gateway process epoch — stamp claims so restart can detect zombie ``executing`` rows."""

from __future__ import annotations

import os
import uuid

_EPOCH: str | None = None


def current_runner_epoch() -> str:
    """Stable for this process; override with ``EVOFLOW_RUNNER_EPOCH`` for tests."""
    global _EPOCH
    env = str(os.environ.get("EVOFLOW_RUNNER_EPOCH") or "").strip()
    if env:
        return env
    if not _EPOCH:
        _EPOCH = f"ep-{uuid.uuid4().hex[:12]}"
    return _EPOCH


def reset_runner_epoch_for_tests(epoch: str | None = None) -> str:
    """Force a new epoch (tests only)."""
    global _EPOCH
    _EPOCH = str(epoch).strip() if epoch else f"ep-{uuid.uuid4().hex[:12]}"
    return _EPOCH


__all__ = ["current_runner_epoch", "reset_runner_epoch_for_tests"]
