"""Per-cycle initiative ceiling for smart-employee duty rounds.

``max_initiatives_per_cycle`` used to be enforced only in the prompt-only think
path (it truncated the LLM's initiative list). The agent-loop path — where the
employee raises work via the ``tasks`` tool / ``evoflow tasks create`` — had no
ceiling, so one round could flood the board with unlimited Tasks.

This module is the single enforcement point:

- :func:`effective_max_initiatives` — resolve the ceiling for a role
  (``0`` means「本轮不许再开新单」).
- :func:`round_refs` — recover the duty round stamp(s) of a work item, no matter
  whether the caller stamped ``round_id`` (``round:2026-…``) or a duty session
  key (``proactive:{code}:duty:round-2026-…``).
- :func:`count_round_work_items` — count work items already raised in the round.
- :func:`check_round_quota` — combined check used by the create paths.

Round stamps are compared **normalized** (alphanumerics only) because the
session-key sanitizer rewrites ``:`` to ``-``. That way
``round:2026-11-06T12:00:00Z`` and ``proactive:x:duty:round-2026-11-06T12-00-00Z``
resolve to the same round.
"""

from __future__ import annotations

import logging
import re
from typing import Any

logger = logging.getLogger(__name__)

# Fallback when a role has no explicit config (matches prompt-only default).
DEFAULT_MAX_INITIATIVES = 3

_DUTY_MARKER = ":duty:"
_NON_ALNUM = re.compile(r"[^0-9A-Za-z]+")


def effective_max_initiatives(role: Any) -> int:
    """Ceiling of new work items for one duty round of ``role``.

    Returns a non-negative int. ``0`` means「本轮不许再开新单」.
    """
    cfg = getattr(role, "config", None)
    raw = getattr(cfg, "max_initiatives_per_cycle", None)
    if raw is None:
        return DEFAULT_MAX_INITIATIVES
    try:
        n = int(raw)
    except (TypeError, ValueError):
        return DEFAULT_MAX_INITIATIVES
    return max(0, n)


def round_token(value: str | None) -> str:
    """Normalize a round stamp / session key to a comparable token."""
    s = str(value or "").strip()
    if not s:
        return ""
    return _NON_ALNUM.sub("", s)


def round_refs(*values: str | None) -> list[str]:
    """Collect the distinct round stamps referenced by ``values``.

    Accepts raw round ids (``round:…``) and duty session keys
    (``proactive:{code}:duty:{stamp}``) and returns the stamps to match on.
    """
    out: list[str] = []
    for raw in values:
        s = str(raw or "").strip()
        if not s:
            continue
        if s.startswith("proactive:"):
            idx = s.find(_DUTY_MARKER)
            if idx < 0:
                continue
            s = s[idx + len(_DUTY_MARKER) :].strip()
        if s and s not in out:
            out.append(s)
    return out


def _row_round_stamp(row: dict[str, Any]) -> str:
    """The round stamp of a task row (``round_id`` first, then duty session key)."""
    rid = str(row.get("round_id") or "").strip()
    if rid:
        return rid
    ref = str(row.get("source_ref") or "").strip()
    if ref.startswith("proactive:"):
        idx = ref.find(_DUTY_MARKER)
        if idx >= 0:
            return ref[idx + len(_DUTY_MARKER) :].strip()
    return ""


def _row_belongs_to_role(row: dict[str, Any], role: Any) -> bool:
    role_name = str(getattr(role, "role_name", "") or "").strip().lower()
    agent_code = str(getattr(role, "agent_code", "") or "").strip().lower()
    ar = str(row.get("assigned_role") or "").strip().lower()
    at = str(row.get("assigned_to") or "").strip().lower()
    rb = str(row.get("raised_by") or "").strip().lower()
    if role_name and ar == role_name:
        return True
    if agent_code and (at == agent_code or rb == agent_code):
        return True
    return False


def count_round_work_items(role: Any, refs: list[str]) -> int:
    """Number of work items already raised by ``role`` in the given round(s).

    Uses a SQL-level COUNT (no board hydration) so the per-round cap stays
    cheap even on a large task board. Falls back to the hydrated board read
    when the SQL path is unavailable. Returns ``0`` on any failure (fail open —
    never block work because of a read error).
    """
    stamps = [str(r or "").strip() for r in (refs or []) if str(r or "").strip()]
    if not stamps:
        return 0
    agent_code = str(getattr(role, "agent_code", "") or "").strip()
    role_name = str(getattr(role, "role_name", "") or "").strip()

    # The session-key stamp differs from the raw round id by ``:`` → ``-``.
    # Query both spellings so the match is exact.
    variants: list[str] = []
    for stamp in stamps:
        for cand in (stamp, stamp.replace(":", "-"), stamp.replace("-", ":")):
            if cand and cand not in variants:
                variants.append(cand)

    try:
        from evoflow.persistence import task_repositories as task_repo

        n = int(
            task_repo.count_root_tasks_by_round_refs(
                refs=variants,
                agent_code=agent_code,
                role_name=role_name,
            )
        )
        if n:
            return n
    except Exception:
        logger.debug("cycle_limits: SQL round count failed", exc_info=True)

    tokens = {round_token(r) for r in stamps}
    tokens.discard("")
    if not tokens:
        return 0
    try:
        from evoflow.admin.tasks import list_tasks

        data = list_tasks(include_subtasks=False)
        rows = data.get("tasks") or []
    except Exception:
        logger.debug("cycle_limits: count_round_work_items failed", exc_info=True)
        return 0

    n = 0
    for row in rows:
        if not isinstance(row, dict):
            continue
        if not _row_belongs_to_role(row, role):
            continue
        if round_token(_row_round_stamp(row)) in tokens:
            n += 1
    return n


def check_round_quota(
    role: Any,
    refs: list[str] | str,
    *,
    pending: int = 1,
) -> tuple[bool, str]:
    """Whether ``role`` may raise ``pending`` more work items this round.

    Returns ``(allowed, reason_zh)``. ``reason_zh`` is empty when allowed.
    """
    max_n = effective_max_initiatives(role)
    if max_n <= 0:
        return False, "本轮建单上限为 0，已拒绝新建；如需开工请调整 max_initiatives_per_cycle"
    ref_list = [refs] if isinstance(refs, str) else list(refs or [])
    ref_list = round_refs(*ref_list)
    if not ref_list:
        # No round stamp → cannot attribute items to a cycle; do not block.
        return True, ""
    used = count_round_work_items(role, ref_list)
    if used + max(0, int(pending)) > max_n:
        return (
            False,
            f"本轮建单已达上限（{used}/{max_n}），请勿重复造单；"
            f"如需新增请先结案或调整 max_initiatives_per_cycle",
        )
    return True, ""
