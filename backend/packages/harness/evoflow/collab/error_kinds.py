"""Structured error classification for workflow tasks / subtasks (E-4).

Historically every failure landed in one ``error`` / ``error_text`` string field
and consumers distinguished semantics by prefix sniffing (``auto_blocked:``,
``reconcile:``) or not at all — users saw internal markers like
``reconcile:tick:zombie_executing``. ``error_kind`` makes the category a first
class field while the legacy prefixes remain the wire format until the display
layer migrates.

Kinds:
- ``business``        — the worker genuinely failed at its task (done=failed, tool error)
- ``dispatch``        — the run could not be dispatched / delegated
- ``dependency_blocked`` — soft dependency wait, not a failure (legacy ``auto_blocked:``)
- ``reconcile``       — bookkeeping written by the reconciler (zombie heal / requeue)
- ``cancelled``       — cancelled by user or parent cancel
- ``timeout``         — timed out
- ``unknown``         — unclassified
"""

from __future__ import annotations

from typing import Any

ERROR_KIND_BUSINESS = "business"
ERROR_KIND_DISPATCH = "dispatch"
ERROR_KIND_DEPENDENCY_BLOCKED = "dependency_blocked"
ERROR_KIND_RECONCILE = "reconcile"
ERROR_KIND_CANCELLED = "cancelled"
ERROR_KIND_TIMEOUT = "timeout"
ERROR_KIND_UNKNOWN = "unknown"

ERROR_KINDS = frozenset(
    {
        ERROR_KIND_BUSINESS,
        ERROR_KIND_DISPATCH,
        ERROR_KIND_DEPENDENCY_BLOCKED,
        ERROR_KIND_RECONCILE,
        ERROR_KIND_CANCELLED,
        ERROR_KIND_TIMEOUT,
        ERROR_KIND_UNKNOWN,
    }
)

# Kinds that must NOT surface in user-facing "错误" panels.
NON_USER_FACING_KINDS = frozenset({ERROR_KIND_DEPENDENCY_BLOCKED, ERROR_KIND_RECONCILE})


def classify_error_text(raw: Any) -> str:
    """Derive an ``error_kind`` from a legacy error string (prefix protocol)."""
    s = str(raw or "").strip().lower()
    if not s:
        return ERROR_KIND_UNKNOWN
    if s.startswith("auto_blocked:"):
        return ERROR_KIND_DEPENDENCY_BLOCKED
    if s.startswith("reconcile:"):
        return ERROR_KIND_RECONCILE
    if s.startswith("dispatch error") or s.startswith("dispatch_failed") or s.startswith("authorize_failed"):
        return ERROR_KIND_DISPATCH
    if "timed out" in s or s.startswith("timeout") or s == "timeout":
        return ERROR_KIND_TIMEOUT
    if "cancelled" in s or "canceled" in s:
        return ERROR_KIND_CANCELLED
    return ERROR_KIND_BUSINESS


def resolve_error_kind(row: dict[str, Any] | None) -> str:
    """Effective kind for a subtask row: explicit field wins, else classify text."""
    if not isinstance(row, dict):
        return ERROR_KIND_UNKNOWN
    kind = str(row.get("error_kind") or "").strip().lower()
    if kind in ERROR_KINDS:
        return kind
    raw = str(row.get("error_text") or row.get("error") or "").strip()
    if not raw:
        return ERROR_KIND_UNKNOWN
    return classify_error_text(raw)


def stamp_error_kind(row: dict[str, Any], kind: str) -> None:
    """Write ``error_kind`` onto a subtask row in place (no-op on bad input)."""
    if not isinstance(row, dict):
        return
    k = str(kind or "").strip().lower()
    if k in ERROR_KINDS:
        row["error_kind"] = k


__all__ = [
    "ERROR_KIND_BUSINESS",
    "ERROR_KIND_CANCELLED",
    "ERROR_KIND_DEPENDENCY_BLOCKED",
    "ERROR_KIND_DISPATCH",
    "ERROR_KIND_RECONCILE",
    "ERROR_KIND_TIMEOUT",
    "ERROR_KIND_UNKNOWN",
    "ERROR_KINDS",
    "NON_USER_FACING_KINDS",
    "classify_error_text",
    "resolve_error_kind",
    "stamp_error_kind",
]
