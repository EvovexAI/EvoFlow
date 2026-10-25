"""Resolve a Task ``assignee`` into a real, mutable agent_code.

Why this module exists
----------------------
``evoflow.authz.agent_actor.assert_can_mutate_assigned_task`` compares the
ambient actor against the row's ``assigned_to`` **literally**::

    if who.lower() == owner.lower():
        return          # the owner may mutate its own row

So a Task whose ``assigned_to`` is not a real agent_code is an **orphan**:
``me`` / ``user`` / ``owner`` never equal any employee code, and a session
key like ``automation:90390552:run-<uuid>`` never equals one either.  Such a
row can only be closed by a privileged actor, and automation rounds used to
create exactly one of them per run (2026-10-23 / 10-24 / 10-25 produced three
``assigned_to='me'`` pending rows that nobody but the platform could close).

This module is the single source of truth for "who may own this Task".  The
tool layer, the CLI and ``admin.tasks.create_task`` all route through it, so
no caller can reintroduce an unowned row.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

logger = logging.getLogger(__name__)

#: Human first-person / role words.  These are legal ``raised_by`` values
#: ("who raised it") but never legal assignees ("who owns it").
HUMAN_ASSIGNEE_LITERALS = frozenset(
    {"me", "user", "human", "manual", "owner", "operator", "self"}
)

#: Session-key shapes that can leak into ``assignee`` (e.g. an automation run
#: stamping its own session key as the owner).
SESSION_KEY_PREFIXES = ("automation:", "proactive:")

#: An automation run key (``automation:<automation_id>:run-<uuid>``) is the
#: run's OWN identity.  The run creates the row and the run can close it again
#: -- measured 2026-10-25: the run closed its own row 5.8 s after creating it
#: (``2610250102_7486``).  So such a key IS a legitimate, writable owner:
#: it is the "explicit system-writable ownership" the task brief allows.
#: What must never be stored is a *human word* (``me`` / ``user`` / ``owner``),
#: which matches no actor at all and therefore strands the row.
WRITABLE_SESSION_PREFIX = "automation:"

#: System front-desk fallback.  ``xiaomi`` is a real agent_code (it has a row
#: in ``evoflow_proactive_roles``) and a privileged Task actor, so the row it
#: owns is one that somebody can actually progress and close.  It is also the
#: only fallback that does not pretend a shell task belongs to a working
#: employee who never agreed to it.
FALLBACK_ASSIGNEE = "xiaomi"

# Resolution sources
SOURCE_UNRESOLVED = "unresolved"  # nothing was requested
SOURCE_UNUSABLE = "unusable"  # requested, but not a storable owner
SOURCE_SESSION_KEY = "session_key"  # a real employee was inside the key
SOURCE_EXPLICIT = "explicit"  # used verbatim
SOURCE_FALLBACK = "fallback"  # we substituted the system front desk


@dataclass(frozen=True)
class AssigneeResolution:
    """Outcome of resolving one raw ``assignee`` value.

    ``code`` is what should be stored in ``assigned_to``.
    ``is_fallback`` marks "we could not honour the caller's intent and used
    :data:`FALLBACK_ASSIGNEE` instead" — callers use it to avoid waking the
    fallback owner for a task nobody actually asked for.
    """

    code: str | None = None
    role_name: str | None = None
    source: str = SOURCE_UNRESOLVED
    is_fallback: bool = False


def is_human_assignee_literal(value: str | None) -> bool:
    """True for human first-person words that must never be an assignee."""
    return str(value or "").strip().lower() in HUMAN_ASSIGNEE_LITERALS


def is_session_key(value: str | None) -> bool:
    """True for session-key shaped values (automation/proactive session)."""
    text = str(value or "").strip()
    return text.startswith(SESSION_KEY_PREFIXES)


def employee_code_from_session_key(value: str | None) -> str:
    """Best-effort real employee code embedded in a session key.

    ``proactive:emp-0b8f4287:duty:round-x`` -> ``emp-0b8f4287``.
    ``automation:90390552:run-abc`` -> ``""`` (no employee inside).
    """
    text = str(value or "").strip()
    if not text:
        return ""
    try:
        from evoflow.proactive.employee_prompting.identity import normalize_employee_agent_code

        code = str(normalize_employee_agent_code(text) or "").strip()
    except Exception:
        return ""
    if not code or code == text:
        # normalize returned the key unchanged -> no employee embedded.
        return ""
    return code


def is_writable_session_key(value: str | None) -> bool:
    """True for a session key that identifies a writer, not a human.

    An automation run key qualifies: the run is the actor that created the
    row, so it is the one actor that can also close it.
    """
    text = str(value or "").strip()
    return text.startswith(WRITABLE_SESSION_PREFIX)


def is_assignee_usable(value: str | None) -> bool:
    """True when the value could stand on its own as an assignee.

    "Usable" means: not a human first-person word, and not a session key
    that has no employee embedded in it -- unless it is an automation run
    key, which names its own writer.
    """
    text = str(value or "").strip()
    if not text:
        return False
    if is_human_assignee_literal(text):
        return False
    if (
        is_session_key(text)
        and not employee_code_from_session_key(text)
        and not is_writable_session_key(text)
    ):
        return False
    return True


def _role_name_for(code: str) -> str | None:
    """Display name of the employee owning ``code`` (None when unknown)."""
    if not code:
        return None
    try:
        from evoflow.proactive.repositories import ProactiveRepository

        role = ProactiveRepository.get_role(code)
    except Exception:
        return None
    if role is None:
        return None
    return str(getattr(role, "role_name", "") or "").strip() or None


def _unusable(original: str, *, allow_fallback: bool) -> AssigneeResolution:
    """The requested owner cannot be stored as-is."""
    if not allow_fallback:
        return AssigneeResolution(code=None, source=SOURCE_UNUSABLE)
    logger.info(
        "task assignee %r is not a real agent_code -> falling back to %s",
        original,
        FALLBACK_ASSIGNEE,
    )
    return AssigneeResolution(
        code=FALLBACK_ASSIGNEE,
        role_name=_role_name_for(FALLBACK_ASSIGNEE),
        source=SOURCE_FALLBACK,
        is_fallback=True,
    )


def resolve_task_assignee(
    raw: str | None,
    *,
    allow_fallback: bool = True,
) -> AssigneeResolution:
    """Resolve a raw ``assignee`` value into a storable agent_code.

    Rules:

    1. empty -> unassigned (``None``); callers keep their existing
       "nobody owns it" semantics (privileged actors only).
    2. human first-person word (``me``/``user``/``owner``/...) -> unusable.
    3. session key -> use the employee code embedded in it when there is one,
       otherwise unusable.
    4. anything else -> kept verbatim (it may be a valid code we cannot
       resolve offline, e.g. a subagent id).

    With ``allow_fallback=True`` an unusable value becomes
    :data:`FALLBACK_ASSIGNEE` (the system front desk) instead of ``None``;
    with ``allow_fallback=False`` it stays ``None`` so the caller can run its
    own cascade (e.g. "assign to the role / the acting employee") first.
    """
    text = str(raw or "").strip()
    if not text:
        return AssigneeResolution(code=None, source=SOURCE_UNRESOLVED)

    if is_human_assignee_literal(text):
        return _unusable(text, allow_fallback=allow_fallback)

    if is_session_key(text):
        code = employee_code_from_session_key(text)
        if code:
            return AssigneeResolution(
                code=code,
                role_name=_role_name_for(code),
                source=SOURCE_SESSION_KEY,
            )
        if is_writable_session_key(text):
            # The run owns the rows it creates -- keep the key verbatim so the
            # run can still close its own row.
            return AssigneeResolution(code=text, source=SOURCE_SESSION_KEY)
        return _unusable(text, allow_fallback=allow_fallback)

    return AssigneeResolution(code=text, source=SOURCE_EXPLICIT)
