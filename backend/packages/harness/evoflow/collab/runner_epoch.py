"""Runner epoch — identify the *deployment incarnation* that stamped a claim.

The epoch exists so a restarted runner can tell "this ``executing`` row was
stamped by a worker that no longer exists" from "a worker is still on it".

Why it must NOT be a per-process random id by default
-----------------------------------------------------
Desktop runs in **split process model** (``processModel: split`` in
``backend-runtime.json``): the Gateway (control plane, runs the reconciler
ticks) and the LangGraph runtime (data plane, runs ``task_tool`` and therefore
stamps claims) are two OS processes.  Both are started by the same desktop boot
and both inherit ``EVOFLOW_BOOT_CYCLE_ID`` from ``boot_cycle::apply_boot_cycle_env``.

If the epoch were a per-process uuid, the Gateway's reconciler would compare its
own uuid against rows stamped by LangGraph, always mismatch, and "heal" live
workers back to ``pending`` on every tick.  So the default epoch is the boot
cycle id — one value per desktop launch, shared by every runner process of that
launch, still changing on restart (which is the property the reconciler needs).

Resolution order:

1. ``EVOFLOW_RUNNER_EPOCH`` — explicit override (tests / single-process CLI).
2. Test override set by :func:`reset_runner_epoch_for_tests`.
3. ``EVOFLOW_BOOT_CYCLE_ID`` — shared across all processes of one boot.
4. Per-process random uuid — last-resort fallback (no boot env available).
"""

from __future__ import annotations

import os
import time
import uuid

# Resolved once per process; fixed for the lifetime of the process.
_EPOCH: str | None = None
# Set by reset_runner_epoch_for_tests only.
_OVERRIDE: str | None = None
# Wall-clock time this process started (used to tell "before my boot" rows apart).
_PROCESS_STARTED_TS: float = time.time()


def _env_epoch() -> str:
    return str(os.environ.get("EVOFLOW_RUNNER_EPOCH") or "").strip()


def _boot_cycle_id() -> str:
    return str(os.environ.get("EVOFLOW_BOOT_CYCLE_ID") or "").strip()


def current_runner_epoch() -> str:
    """Epoch of this deployment incarnation (shared by all processes of one boot)."""
    env = _env_epoch()
    if env:
        return env
    if _OVERRIDE:
        return _OVERRIDE
    global _EPOCH
    if _EPOCH:
        return _EPOCH
    boot = _boot_cycle_id()
    if boot:
        _EPOCH = boot
    else:
        _EPOCH = f"ep-{uuid.uuid4().hex[:12]}"
    return _EPOCH


def runner_process_started_ts() -> float:
    """Unix seconds when this process started (module import time)."""
    return _PROCESS_STARTED_TS


def runner_epoch_is_shared() -> bool:
    """True when the epoch identifies a *boot* shared by every runner process.

    Only a shared (boot-scoped) epoch may be compared against ``runner_epoch``
    stamped by a different process.  With the per-process fallback the
    comparison is meaningless — Gateway and LangGraph would never match — so
    callers must fall back to the lease / staleness signals instead.
    """
    if _env_epoch():
        # Explicit override: caller controls the scope; assume comparable.
        return True
    if _OVERRIDE:
        return True
    return bool(_boot_cycle_id())


def reset_runner_epoch_for_tests(epoch: str | None = None) -> str:
    """Force a new epoch (tests only). Returns the epoch now in effect."""
    global _EPOCH, _OVERRIDE
    _EPOCH = None
    _OVERRIDE = str(epoch).strip() if epoch else f"ep-{uuid.uuid4().hex[:12]}"
    return current_runner_epoch()


__all__ = [
    "current_runner_epoch",
    "reset_runner_epoch_for_tests",
    "runner_epoch_is_shared",
    "runner_process_started_ts",
]
