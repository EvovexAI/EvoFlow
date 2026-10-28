"""Computer Use top-indicator state — aligned with ZCode windowsCuaOperationIndicator.

ZCode lifecycle (docs/cua/2026-09-14-windows-cua-indicator-repair-spec.md):

- **Start**: first real CUA cell begins executing (tool-started / setupComputerUseRuntime).
- **Stay on**: same turn, more CUA cells → refresh; do **not** hide when a cell ends.
- **End**:
  1. turn / session explicitly cleared, or
  2. ``AUTO_HIDE_MS`` (30s) after the last CUA activity with no new cell, or
  3. app quit / force clear.

EvoFlow mapping (LangGraph has no CLI sideband):

- node_repl CUA cell **start** → ``pulse_cua_glow_start``
- node_repl CUA cell **end** → ``pulse_cua_glow_end`` (keeps indicator for 30s grace;
  long-running cell stays on via ``_RUNNING`` until the cell returns)
- user stop / RUN_ERROR → ``clear_cua_glow``
"""

from __future__ import annotations

import threading
import time
from typing import Any

# ZCode AUTO_HIDE_MS
AUTO_HIDE_MS = 30_000.0

_LOCK = threading.Lock()
# Keys of CUA cells currently inside ``_run`` (covers cells longer than 30s).
_RUNNING: set[str] = set()
# After the last running cell ends, stay visible until this monotonic deadline.
_GRACE_UNTIL_MS = 0.0
_UPDATED_AT = 0.0


def _now_ms() -> float:
    return time.monotonic() * 1000.0


def _snapshot_locked(now: float) -> dict[str, Any]:
    global _GRACE_UNTIL_MS
    active = bool(_RUNNING) or now < _GRACE_UNTIL_MS
    if not active and _GRACE_UNTIL_MS:
        _GRACE_UNTIL_MS = 0.0
    return {
        "active": active,
        "running": len(_RUNNING),
        "grace_ms_left": max(0, int(_GRACE_UNTIL_MS - now)) if not _RUNNING else None,
        "keys": sorted(_RUNNING),
        "updated_at_ms": _UPDATED_AT,
        "auto_hide_ms": int(AUTO_HIDE_MS),
    }


def pulse_cua_glow_start(*, key: str = "") -> dict[str, Any]:
    """CUA cell started executing — show indicator (ZCode tool-started)."""
    global _UPDATED_AT, _GRACE_UNTIL_MS
    kid = str(key or "").strip() or "default"
    now = _now_ms()
    with _LOCK:
        _RUNNING.add(kid)
        # Running cell owns visibility; grace is for the gap after it ends.
        _GRACE_UNTIL_MS = 0.0
        _UPDATED_AT = now
        return _snapshot_locked(now)


def pulse_cua_glow_end(*, key: str = "") -> dict[str, Any]:
    """CUA cell finished — do not hard-hide; start/refresh 30s grace (ZCode)."""
    global _UPDATED_AT, _GRACE_UNTIL_MS
    kid = str(key or "").strip() or "default"
    now = _now_ms()
    with _LOCK:
        _RUNNING.discard(kid)
        if not _RUNNING:
            _GRACE_UNTIL_MS = now + AUTO_HIDE_MS
        _UPDATED_AT = now
        return _snapshot_locked(now)


def clear_cua_glow() -> dict[str, Any]:
    """Force hide (turn error / user stop / session closed)."""
    global _UPDATED_AT, _GRACE_UNTIL_MS
    now = _now_ms()
    with _LOCK:
        _RUNNING.clear()
        _GRACE_UNTIL_MS = 0.0
        _UPDATED_AT = now
        return _snapshot_locked(now)


def set_cua_glow(*, active: bool, key: str = "") -> dict[str, Any]:
    """Compat wrapper used by HTTP + older callers."""
    if active:
        return pulse_cua_glow_start(key=key)
    raw = str(key or "").strip()
    if not raw:
        return clear_cua_glow()
    return pulse_cua_glow_end(key=raw)


def get_cua_glow_status() -> dict[str, Any]:
    now = _now_ms()
    with _LOCK:
        return _snapshot_locked(now)
