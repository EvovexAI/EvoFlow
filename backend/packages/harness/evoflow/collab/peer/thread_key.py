"""Thread key helpers for collab peer messaging."""

from __future__ import annotations

from typing import Any

LEAD_PARTY = "__lead__"


def build_thread_key(from_party: str, to_subtask_id: str) -> str:
    return f"{str(from_party).strip()}->{str(to_subtask_id).strip()}"


def parse_thread_key(thread_key: str) -> tuple[str, str]:
    raw = str(thread_key or "").strip()
    if "->" not in raw:
        return "", ""
    left, right = raw.split("->", 1)
    return left.strip(), right.strip()


def resolve_subtask_ref(storage: Any, main_task_id: str, token: str, *, current_sid: str = "") -> str | None:
    """Resolve subtask id from id, ref, or unique name."""
    from evoflow.collab.storage import find_main_task
    from evoflow.tools.builtins.supervisor.dependency import (
        _build_ref_to_id_index,
        _build_subtask_name_index,
        _resolve_dep_ref_to_id,
    )

    ref = str(token or "").strip()
    if not ref:
        return None
    row = find_main_task(storage, main_task_id)
    if not row:
        return None
    _proj, task = row
    by_id: dict[str, dict[str, Any]] = {}
    for st in task.get("subtasks") or []:
        if not isinstance(st, dict):
            continue
        sid = str(st.get("id") or "").strip()
        if sid:
            by_id[sid] = st
    if ref in by_id:
        return ref
    return _resolve_dep_ref_to_id(
        ref,
        current_sid=current_sid,
        by_id=by_id,
        name_index=_build_subtask_name_index(by_id),
        ref_index=_build_ref_to_id_index(by_id),
    )
