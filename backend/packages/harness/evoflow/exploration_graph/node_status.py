"""Mind map node status helpers (shared by injection, API, hints)."""

from __future__ import annotations

# Still actively tracked — full body injection + processing UI.
ACTIVE_NODE_STATUSES = frozenset({"active", "stale"})

# Done / closed — compressed injection only.
ARCHIVED_NODE_STATUSES = frozenset({"resolved", "verified", "refuted", "blocked"})

# User/model: no longer needs in-progress tracking; not claiming done.
PARKED_NODE_STATUSES = frozenset({"parked"})

# Hidden from model injection entirely.
COLLAPSED_STATUS = "collapsed"

# Kinds where status lifecycle is meaningful (work tracking).
STATUS_TRACKED_KINDS = frozenset({"flow", "gap", "task", "hypothesis"})

# Parent closed → children treated as done/hidden in injection (read-time cascade).
CLOSED_NODE_STATUSES = frozenset(
    {"resolved", "verified", "refuted", "blocked", "parked", COLLAPSED_STATUS}
)

# User closes a tracked branch → cascade this status to active/stale tracked descendants.
CASCADE_CHILD_STATUSES = frozenset(
    {"resolved", "verified", "refuted", "blocked", "parked", COLLAPSED_STATUS}
)

_KIND_PREFIX_MAP = {
    "goal:": "goal",
    "flow:": "flow",
    "gap:": "gap",
    "claim:": "claim",
    "file:": "file",
    "diagram:": "diagram",
    "task:": "task",
    "note:": "note",
}

# Statuses a user may set from the evopanel UI.
USER_PATCHABLE_STATUSES = frozenset(
    {
        "active",
        "parked",
        "resolved",
        "verified",
        "refuted",
        "blocked",
        COLLAPSED_STATUS,
    }
)

_STATUS_ALIASES = {
    "done": "resolved",
    "closed": "resolved",
    "idle": "parked",
    "skip": "parked",
    "skipped": "parked",
    "dismissed": "parked",
}


def normalize_node_status(raw: str | None) -> str:
    s = str(raw or "active").strip().lower()
    if not s:
        return "active"
    return _STATUS_ALIASES.get(s, s)


def is_user_patchable_status(raw: str | None) -> bool:
    return normalize_node_status(raw) in USER_PATCHABLE_STATUSES


def is_processing_status(raw: str | None) -> bool:
    return normalize_node_status(raw) in ACTIVE_NODE_STATUSES


def is_closed_status(raw: str | None) -> bool:
    return normalize_node_status(raw) in CLOSED_NODE_STATUSES


def effective_kind(kind: str = "", external_id: str = "") -> str:
    k = str(kind or "").strip().lower()
    if k and k != "note":
        return k
    eid = str(external_id or "").strip().lower()
    for prefix, inferred in _KIND_PREFIX_MAP.items():
        if eid.startswith(prefix):
            return inferred
    return k or "note"


def is_status_tracked_kind(kind: str = "", external_id: str = "") -> bool:
    return effective_kind(kind, external_id) in STATUS_TRACKED_KINDS


def should_cascade_status_to_descendants(status: str) -> bool:
    return normalize_node_status(status) in CASCADE_CHILD_STATUSES
