"""Collab executor thread ids — checkpoint isolation tied to the lead session."""

from __future__ import annotations

import re
import uuid

# Must match Paths._SAFE_THREAD_ID_RE (alphanumeric, hyphen, underscore only).
SUBTASK_THREAD_SEP = "__sub__"
_LEGACY_SUBTASK_THREAD_SEP = "::sub::"
_LANGGRAPH_LEAD_THREAD_UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)
# Deterministic hosted-goal LangGraph checkpoint threads (must be valid UUID for /threads/{id}/runs).
_HOSTED_GOAL_CHECKPOINT_NS = uuid.UUID("7c9e6679-7425-40de-944b-e07fc1f90ae7")


def _split_executor_thread(thread_id: str) -> tuple[str | None, str | None]:
    tid = str(thread_id or "").strip()
    if not tid:
        return None, None
    for sep in (SUBTASK_THREAD_SEP, _LEGACY_SUBTASK_THREAD_SEP):
        if sep in tid:
            lead, sid = tid.split(sep, 1)
            return lead.strip() or None, sid.strip() or None
    return None, None


def is_collab_executor_thread(thread_id: str | None) -> bool:
    """True for subagent checkpoint threads (not lead chat session ids)."""
    tid = str(thread_id or "").strip()
    if not tid:
        return False
    if tid.startswith("SubThread_"):
        return True
    lead, _ = _split_executor_thread(tid)
    return lead is not None


def normalize_lead_thread_id(thread_id: str | None) -> str | None:
    """Unwrap nested ``{lead}__sub__{parent}__sub__…`` down to the root Lead thread."""
    tid = str(thread_id or "").strip()
    if not tid:
        return None
    while True:
        lead, _sub = _split_executor_thread(tid)
        if not lead:
            return tid
        tid = lead


def collab_subtask_executor_thread_id(lead_thread_id: str, subtask_id: str) -> str:
    """Deterministic executor thread: ``{lead}__sub__{subtask_id}``."""
    lead = normalize_lead_thread_id(lead_thread_id) or str(lead_thread_id or "").strip()
    sid = str(subtask_id or "").strip()
    if lead and sid:
        return f"{lead}{SUBTASK_THREAD_SEP}{sid}"
    if sid:
        return f"SubThread_{sid}"
    return f"SubThread_{lead or 'orphan'}"


def normalize_collab_executor_thread_id(thread_id: str) -> str:
    """Rewrite legacy ``::sub::`` ids to the safe ``__sub__`` form."""
    tid = str(thread_id or "").strip()
    if not tid or _LEGACY_SUBTASK_THREAD_SEP not in tid:
        return tid
    lead, sid = _split_executor_thread(tid)
    if lead and sid:
        return collab_subtask_executor_thread_id(lead, sid)
    return tid


def lead_thread_from_executor_thread(executor_thread_id: str | None) -> str | None:
    tid = str(executor_thread_id or "").strip()
    if not tid:
        return None
    lead, _ = _split_executor_thread(tid)
    if lead:
        return normalize_lead_thread_id(lead)
    if tid.startswith("SubThread_"):
        return None
    return None


def goal_checkpoint_thread_id(lead_thread_id: str, goal_session_id: str) -> str:
    """LangGraph checkpoint thread for ``goal_agent`` (valid UUID, isolated from lead chat)."""
    lead = (
        resolve_langgraph_lead_thread_id(lead_thread_id)
        or normalize_lead_thread_id(lead_thread_id)
        or str(lead_thread_id or "").strip()
    )
    sid = str(goal_session_id or "").strip()
    if not lead or not sid:
        return str(uuid.uuid4())
    return str(uuid.uuid5(_HOSTED_GOAL_CHECKPOINT_NS, f"{lead}|hosted-goal|{sid}"))


def is_goal_checkpoint_thread_id(thread_id: str | None) -> bool:
    """Best-effort: true when ``thread_id`` is a UUID v5 in the hosted-goal namespace."""
    tid = str(thread_id or "").strip()
    if not tid or not _LANGGRAPH_LEAD_THREAD_UUID_RE.match(tid):
        return False
    try:
        parsed = uuid.UUID(tid)
    except ValueError:
        return False
    return parsed.version == 5


def is_langgraph_lead_thread_id(thread_id: str | None) -> bool:
    """True when ``thread_id`` is valid for LangGraph HTTP ``/threads/{id}/runs*`` (lead UUID)."""
    tid = str(thread_id or "").strip()
    if not tid or is_collab_executor_thread(tid):
        return False
    return bool(_LANGGRAPH_LEAD_THREAD_UUID_RE.match(tid))


def resolve_langgraph_lead_thread_id(thread_id: str | None) -> str | None:
    """Map collab executor ids to their root lead UUID; pass through valid lead ids."""
    tid = str(thread_id or "").strip()
    if not tid:
        return None
    if is_langgraph_lead_thread_id(tid):
        return tid
    if is_collab_executor_thread(tid):
        lead = lead_thread_from_executor_thread(tid) or normalize_lead_thread_id(tid)
        if lead and is_langgraph_lead_thread_id(lead):
            return lead
        return None
    return None


def resolve_subtask_executor_thread_id(
    lead_thread_id: str | None,
    subtask_id: str | None,
    *,
    stored_subtask_thread_id: str | None = None,
) -> str:
    """Return executor thread for writes/reads.

    Prefer a persisted ``subtask_thread_id`` that already scopes this ``subtask_id``:
    after LangGraph restart the lead UUID may be recreated, but chat message rows
    stay under the old ``{lead}__sub__{sid}`` / ``SubThread_{sid}``. Nested
    ``__sub__`` mistakes on the *same* lead still rewrite to the canonical form.
    """
    lead = normalize_lead_thread_id(lead_thread_id) or str(lead_thread_id or "").strip()
    sid = str(subtask_id or "").strip()
    canonical = collab_subtask_executor_thread_id(lead, sid) if lead and sid else ""
    stored = normalize_collab_executor_thread_id(str(stored_subtask_thread_id or "").strip())
    if stored and sid:
        if stored == f"SubThread_{sid}":
            return stored
        stored_root = normalize_lead_thread_id(lead_thread_from_executor_thread(stored) or "")
        _stored_seg, stored_sid = _split_executor_thread(stored)
        if str(stored_sid or "").strip() == sid:
            if not lead:
                return stored
            if stored_root == lead:
                # Same lead: unwrap nested mistakes → canonical
                return canonical or stored
            # Lead UUID changed (service / LangGraph recreate) — keep persisted worker thread
            return stored
    if stored and canonical and stored == canonical:
        return stored
    if canonical:
        return canonical
    if stored:
        return stored
    if lead and sid:
        return collab_subtask_executor_thread_id(lead, sid)
    if sid:
        return f"SubThread_{sid}"
    return f"SubThread_{lead or 'orphan'}"


__all__ = [
    "SUBTASK_THREAD_SEP",
    "collab_subtask_executor_thread_id",
    "goal_checkpoint_thread_id",
    "is_goal_checkpoint_thread_id",
    "is_collab_executor_thread",
    "is_langgraph_lead_thread_id",
    "lead_thread_from_executor_thread",
    "normalize_collab_executor_thread_id",
    "normalize_lead_thread_id",
    "resolve_langgraph_lead_thread_id",
    "resolve_subtask_executor_thread_id",
]
