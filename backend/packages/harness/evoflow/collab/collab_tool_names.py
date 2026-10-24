"""Short canonical names for collab worker tools (less tokens to emit / read).

Legacy long names remain registered as aliases so mid-flight workers and old
prompts keep working; allowlists / mandates use the short names.
"""

from __future__ import annotations

# Canonical (short)
DONE = "done"
PROGRESS = "progress"
CHECKLIST = "checklist"
PEER_SEND = "peer_send"
PEER_READ = "peer_read"
PEER_REPLY = "peer_reply"

# Legacy → canonical
LEGACY_TO_CANONICAL: dict[str, str] = {
    "subtask_outcome_report": DONE,
    "subtask_progress_report": PROGRESS,
    "subtask_work_checklist": CHECKLIST,
    "collab_peer_send": PEER_SEND,
    "collab_peer_read": PEER_READ,
    "collab_peer_reply": PEER_REPLY,
}

CANONICAL_TO_LEGACY: dict[str, str] = {v: k for k, v in LEGACY_TO_CANONICAL.items()}

MANDATORY_FULL: tuple[str, ...] = (
    CHECKLIST,
    PROGRESS,
    DONE,
    PEER_SEND,
    PEER_READ,
    PEER_REPLY,
)
MANDATORY_LIGHT: tuple[str, ...] = (DONE,)

# All names that refer to the same surfaces (canonical + legacy)
ALL_COLLAB_REPORT_NAMES: frozenset[str] = frozenset(
    {
        DONE,
        PROGRESS,
        CHECKLIST,
        PEER_SEND,
        PEER_READ,
        PEER_REPLY,
        *LEGACY_TO_CANONICAL.keys(),
    }
)


def canonical_tool_name(name: str) -> str:
    raw = str(name or "").strip()
    return LEGACY_TO_CANONICAL.get(raw, raw)


def expand_tool_name_aliases(name: str) -> frozenset[str]:
    """Return canonical + legacy spellings for allowlist / ban stripping."""
    canon = canonical_tool_name(name)
    out = {canon}
    leg = CANONICAL_TO_LEGACY.get(canon)
    if leg:
        out.add(leg)
    if name:
        out.add(str(name).strip())
    return frozenset(x for x in out if x)


__all__ = [
    "ALL_COLLAB_REPORT_NAMES",
    "CANONICAL_TO_LEGACY",
    "CHECKLIST",
    "DONE",
    "LEGACY_TO_CANONICAL",
    "MANDATORY_FULL",
    "MANDATORY_LIGHT",
    "PEER_READ",
    "PEER_REPLY",
    "PEER_SEND",
    "PROGRESS",
    "canonical_tool_name",
    "expand_tool_name_aliases",
]
