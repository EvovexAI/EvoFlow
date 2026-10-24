"""Short registered names for collab worker tools (what the model sees).

Legacy long names in agent YAML / allowlists are rewritten via
``canonical_tool_name`` / ``canonicalize_tool_names``.
"""

from __future__ import annotations

DONE = "done"
PROGRESS = "progress"
CHECKLIST = "checklist"
PEER_SEND = "peer_send"
PEER_READ = "peer_read"
PEER_REPLY = "peer_reply"

# Old spellings → short registered names (tools are only registered under short names).
LEGACY_TO_CANONICAL: dict[str, str] = {
    "subtask_outcome_report": DONE,
    "subtask_progress_report": PROGRESS,
    "subtask_work_checklist": CHECKLIST,
    "collab_peer_send": PEER_SEND,
    "collab_peer_read": PEER_READ,
    "collab_peer_reply": PEER_REPLY,
}

MANDATORY_FULL: tuple[str, ...] = (
    CHECKLIST,
    PROGRESS,
    DONE,
    PEER_SEND,
    PEER_READ,
    PEER_REPLY,
)
MANDATORY_LIGHT: tuple[str, ...] = (DONE,)


def canonical_tool_name(name: str) -> str:
    raw = str(name or "").strip()
    return LEGACY_TO_CANONICAL.get(raw, raw)


def canonicalize_tool_names(names: list[str] | tuple[str, ...] | None) -> list[str]:
    """Map legacy spellings → short names; drop dupes; preserve order."""
    if not names:
        return []
    out: list[str] = []
    seen: set[str] = set()
    for raw in names:
        canon = canonical_tool_name(str(raw or "").strip())
        if not canon or canon in seen:
            continue
        seen.add(canon)
        out.append(canon)
    return out


def expand_tool_name_aliases(name: str) -> frozenset[str]:
    """Canonical + legacy spellings (for stripping bans that still use old names)."""
    canon = canonical_tool_name(name)
    out = {canon}
    for leg, c in LEGACY_TO_CANONICAL.items():
        if c == canon:
            out.add(leg)
    if name:
        out.add(str(name).strip())
    return frozenset(x for x in out if x)


__all__ = [
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
    "canonicalize_tool_names",
    "expand_tool_name_aliases",
]
