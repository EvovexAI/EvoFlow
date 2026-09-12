"""DAG dependency resolution for supervisor subtasks.

Provides:
- depends_on extraction / name-index building
- Reference-to-ID resolution (id or name)
- Auto-finalization of unrunnable pending subtasks
- Subtask eligibility resolution for start_execution waves
"""

from __future__ import annotations

import logging
import re
import time
from typing import Any

logger = logging.getLogger(__name__)

# Re-exported from supervisor_tool module for backward compat
_TERMINAL_SUBTASK = frozenset({"completed", "failed", "cancelled"})
_IN_FLIGHT_SUBTASK = frozenset({"executing", "running", "in_progress"})
_MAX_SUBTASK_RETRIES = 10


def _extract_dep_refs_from_subtask_spec(spec: dict[str, Any]) -> Any:
    """Read upstream refs from a subtask create spec.

    Models and UIs use mixed field names; creation must accept all of them:
    - ``depends_on`` / ``dependsOn`` (canonical for ``worker_profile``)
    - ``dependencies`` (Task/Subtask model + EvoPanel manual add)
    """
    for key in ("depends_on", "dependsOn", "dependencies"):
        val = spec.get(key)
        if val is not None:
            return val
    return None


def _subtask_dep_ids(st: dict[str, Any]) -> list[str]:
    """depends_on from worker_profile (other subtask ids that must complete first)."""
    # Primary source: worker_profile.depends_on (design §5.2).
    wp = st.get("worker_profile")
    raw: Any = None
    if isinstance(wp, dict):
        raw = wp.get("depends_on")

    # Backward/compat sources: some historical rows stored dependencies on the subtask itself.
    if raw is None:
        raw = st.get("depends_on")
    if raw is None:
        raw = st.get("dependsOn")
    if raw is None:
        raw = st.get("dependencies")

    # Normalize allowed shapes -> list[str]
    if raw is None:
        return []
    if isinstance(raw, str):
        # Accept a single id/name accidentally serialized as string.
        raw = [raw]
    if not isinstance(raw, list):
        return []
    out: list[str] = []
    for x in raw:
        d = str(x).strip()
        if d:
            out.append(d)
    return out


def _subtask_spec_ref(spec: dict[str, Any]) -> str:
    """Explicit ``ref`` / ``subtask_ref`` from create spec (if any)."""
    raw = spec.get("ref")
    if raw is None:
        raw = spec.get("subtask_ref")
    if raw is None:
        return ""
    return str(raw).strip()


def _max_numeric_subtask_ref(existing_subtasks: list[dict[str, Any]]) -> int:
    """Highest numeric ``ref`` already on this main task (for continuing 1,2,3… on append)."""
    best = 0
    for st in existing_subtasks:
        if not isinstance(st, dict):
            continue
        r = str(st.get("ref") or "").strip()
        if r.isdigit():
            best = max(best, int(r))
    return best


def _effective_subtask_ref(
    spec: dict[str, Any],
    *,
    batch_index: int,
    ref_offset: int = 0,
) -> str:
    """Stable step id for depends_on: explicit ref, else auto ``1``…``n`` (1-based, per batch + offset)."""
    explicit = _subtask_spec_ref(spec)
    if explicit:
        return explicit
    return str(ref_offset + batch_index + 1)


def assign_default_refs_to_batch(
    batch_planned: list[dict[str, Any]],
    *,
    ref_offset: int = 0,
) -> None:
    """Write ``row['ref']`` for every planned subtask (auto 1,2,3 when omitted)."""
    for row in batch_planned:
        spec = row.get("spec")
        idx = int(row.get("index", 0))
        if isinstance(spec, dict):
            row["ref"] = _effective_subtask_ref(spec, batch_index=idx, ref_offset=ref_offset)
        else:
            row["ref"] = str(ref_offset + idx + 1)


def next_subtask_ref_for_append(existing_subtasks: list[dict[str, Any]]) -> str:
    """Next numeric ref when adding a single subtask to an existing task."""
    return str(_max_numeric_subtask_ref(existing_subtasks) + 1)


def _build_batch_ref_and_index_maps(
    batch_planned: list[dict[str, Any]],
) -> tuple[dict[str, str], dict[int, str], list[dict[str, Any]]]:
    """Map batch ``ref`` and array index -> preallocated subtask id. Returns duplicate-ref warnings."""
    ref_to_id: dict[str, str] = {}
    index_to_id: dict[int, str] = {}
    warnings: list[dict[str, Any]] = []
    for row in batch_planned:
        idx = int(row.get("index", 0))
        sid = str(row.get("id") or "").strip()
        if not sid:
            continue
        index_to_id[idx] = sid
        rk = str(row.get("ref") or "").strip()
        if not rk:
            continue
        if rk in ref_to_id and ref_to_id[rk] != sid:
            warnings.append(
                {
                    "index": idx,
                    "name": str(row.get("name") or ""),
                    "warning": f"duplicate subtasks[i].ref '{rk}' in batch; later row ignored for ref map",
                }
            )
            continue
        ref_to_id[rk] = sid
    return ref_to_id, index_to_id, warnings


def _resolve_dep_ref_during_create(
    dep_ref: str,
    *,
    preallocated_id: str,
    existing_ids: set[str],
    batch_planned: list[dict[str, Any]],
    batch_ref_to_id: dict[str, str],
    batch_index_to_id: dict[int, str],
    existing_ref_to_id: dict[str, str] | None = None,
) -> str | None:
    """Resolve one depends_on token at subtask creation time (numeric refs only).

    Accepted tokens:
    - Auto/explicit step ref: ``"1"``, ``"2"``, … (``subtasks[i].ref``; default is array order)
    - Preallocated ``Subtask_*`` id (same call or existing rows)
    - ``@0`` / ``#1`` — 0-based / 1-based index in the **current** ``subtasks`` array

    Display ``name`` is not used for dependency edges.
    """
    ref = str(dep_ref or "").strip()
    if not ref or ref == preallocated_id:
        return None
    if ref in existing_ids or any(ref == str(x.get("id") or "") for x in batch_planned):
        return ref
    prior = existing_ref_to_id or {}
    if ref in prior:
        return prior[ref]
    if ref in batch_ref_to_id:
        return batch_ref_to_id[ref]
    if ref.startswith("@") and ref[1:].isdigit():
        return batch_index_to_id.get(int(ref[1:]))
    if ref.startswith("#") and ref[1:].isdigit():
        one_based = int(ref[1:])
        if one_based >= 1:
            return batch_index_to_id.get(one_based - 1)
    return None


def _build_existing_ref_to_id(existing_subtasks: list[dict[str, Any]]) -> dict[str, str]:
    out: dict[str, str] = {}
    for st in existing_subtasks:
        if not isinstance(st, dict):
            continue
        sid = str(st.get("id") or "").strip()
        rk = str(st.get("ref") or "").strip()
        if sid and rk:
            out[rk] = sid
    return out


def normalize_depends_on_at_create(
    raw_dep: list[Any],
    *,
    preallocated_id: str,
    existing_ids: set[str],
    batch_planned: list[dict[str, Any]],
    batch_ref_to_id: dict[str, str],
    batch_index_to_id: dict[int, str],
    existing_ref_to_id: dict[str, str] | None = None,
) -> tuple[list[str], list[str]]:
    """Normalize depends_on list to concrete subtask ids; return unresolved tokens."""
    normalized: list[str] = []
    unresolved: list[str] = []
    seen: set[str] = set()
    for dep in raw_dep:
        if isinstance(dep, int):
            ref = str(dep).strip()
        else:
            ref = str(dep or "").strip()
        if not ref:
            continue
        rid = _resolve_dep_ref_during_create(
            ref,
            preallocated_id=preallocated_id,
            existing_ids=existing_ids,
            batch_planned=batch_planned,
            batch_ref_to_id=batch_ref_to_id,
            batch_index_to_id=batch_index_to_id,
            existing_ref_to_id=existing_ref_to_id,
        )
        if rid and rid not in seen:
            seen.add(rid)
            normalized.append(rid)
        elif rid is None:
            unresolved.append(ref)
    return normalized, unresolved


def _build_ref_to_id_index(by_id: dict[str, dict[str, Any]]) -> dict[str, str]:
    """Map plan step ref (e.g. ``"1"``) to concrete subtask id within one main task."""
    idx: dict[str, str] = {}
    for sid, st in by_id.items():
        ref = str(st.get("ref") or "").strip()
        if ref and ref not in idx:
            idx[ref] = sid
        semantic = str(st.get("semantic_ref") or "").strip()
        if semantic and semantic not in idx:
            idx[semantic] = sid
        wp = st.get("worker_profile")
        if isinstance(wp, dict):
            wp_semantic = str(wp.get("semantic_ref") or "").strip()
            if wp_semantic and wp_semantic not in idx:
                idx[wp_semantic] = sid
        if not ref:
            m = re.match(r"^Step\s+(\d+)\s*:", str(st.get("name") or "").strip(), re.IGNORECASE)
            if m:
                r2 = m.group(1)
                if r2 not in idx:
                    idx[r2] = sid
    return idx


def resolve_explicit_subtask_tokens(
    storage: Any,
    main_task_id: str,
    tokens: list[str] | None,
) -> tuple[list[str], list[str]]:
    """Resolve ``start_execution`` ``subtask_ids`` tokens to concrete subtask ids.

    Accepts ``Subtask_*`` ids (preferred) or plan step ``ref`` strings (``"1"``, ``"2"``, …)
    from ``plan`` ``steps[].ref`` / ``subtasksSync.created[].ref``.

    Returns:
        (resolved_ids, unresolved_tokens)
    """
    from evoflow.collab.storage import find_main_task

    tid = str(main_task_id or "").strip()
    raw = [str(x).strip() for x in (tokens or []) if str(x).strip()]
    if not tid or not raw:
        return [], [t for t in raw if t]

    row = find_main_task(storage, main_task_id)
    if not row:
        return [], raw

    _proj, task = row
    by_id: dict[str, dict[str, Any]] = {}
    for st in task.get("subtasks") or []:
        if isinstance(st, dict):
            sid = str(st.get("id") or "").strip()
            if sid:
                by_id[sid] = st
    name_index = _build_subtask_name_index(by_id)
    ref_index = _build_ref_to_id_index(by_id)

    resolved: list[str] = []
    unresolved: list[str] = []
    seen: set[str] = set()
    for token in raw:
        rid = _resolve_dep_ref_to_id(
            token,
            current_sid="",
            by_id=by_id,
            name_index=name_index,
            ref_index=ref_index,
        )
        if rid and rid in by_id and rid not in seen:
            seen.add(rid)
            resolved.append(rid)
        else:
            unresolved.append(token)
    return resolved, unresolved


def _build_subtask_name_index(by_id: dict[str, dict[str, Any]]) -> dict[str, list[str]]:
    """Name -> [subtask ids] index for resolving depends_on that use names."""
    idx: dict[str, list[str]] = {}
    for sid, st in by_id.items():
        nm = str(st.get("name") or "").strip()
        if not nm:
            continue
        idx.setdefault(nm, []).append(sid)
    return idx


def _resolve_dep_ref_to_id(
    dep_ref: str,
    *,
    current_sid: str,
    by_id: dict[str, dict[str, Any]],
    name_index: dict[str, list[str]],
    ref_index: dict[str, str] | None = None,
) -> str | None:
    """Resolve depends_on item to concrete subtask id.

    Accept:
    - subtask id (preferred)
    - plan step ``ref`` (e.g. ``"1"`` from ``plan`` sync)
    - subtask name when unique (compat)
    """
    ref = str(dep_ref or "").strip()
    if not ref:
        return None
    if ref == current_sid:
        return None
    if ref in by_id:
        return ref
    if ref_index:
        rid = ref_index.get(ref)
        if rid and rid != current_sid and rid in by_id:
            return rid
    cands = name_index.get(ref) or []
    if len(cands) == 1:
        return cands[0]
    # Unknown id (e.g. Subtask_* copied from another task/session) or ambiguous name.
    return None


def _write_subtask_depends_on_list(st: dict[str, Any], deps: list[str]) -> None:
    """Persist depends_on to a single canonical location (worker_profile preferred)."""
    wp = st.get("worker_profile")
    if isinstance(wp, dict):
        wp["depends_on"] = deps
        for k in ("depends_on", "dependsOn", "dependencies"):
            if k in st:
                st.pop(k, None)
        return
    st["depends_on"] = deps
    st.pop("dependsOn", None)
    st.pop("dependencies", None)


def normalize_subtask_depends_on_refs(storage: Any, main_task_id: str) -> dict[str, Any]:
    """Rewrite ``worker_profile.depends_on`` step refs to concrete subtask ids.

    ``plan`` sync stores numeric refs (``["1"]``); runtime DAG resolution expects
    ``Subtask_*`` ids. Call after plan sync and before dependency resolution.
    """
    from evoflow.collab.storage import find_main_task

    row = find_main_task(storage, main_task_id)
    if not row:
        return {"changed": False, "normalized": []}
    proj, task = row
    subtasks: list[dict[str, Any]] = [x for x in (task.get("subtasks") or []) if isinstance(x, dict)]
    if not subtasks:
        return {"changed": False, "normalized": []}

    by_id: dict[str, dict[str, Any]] = {}
    for st in subtasks:
        sid = str(st.get("id") or "").strip()
        if sid:
            by_id[sid] = st
    name_index = _build_subtask_name_index(by_id)
    ref_index = _build_ref_to_id_index(by_id)

    changed = False
    normalized: list[dict[str, Any]] = []

    for st in subtasks:
        sid = str(st.get("id") or "").strip()
        if not sid:
            continue
        raw_deps = _subtask_dep_ids(st)
        if not raw_deps:
            continue

        new_list: list[str] = []
        seen: set[str] = set()
        sub_changed = False

        for dep_ref in raw_deps:
            ref = str(dep_ref or "").strip()
            if not ref or ref == sid:
                continue
            rid = _resolve_dep_ref_to_id(
                ref,
                current_sid=sid,
                by_id=by_id,
                name_index=name_index,
                ref_index=ref_index,
            )
            if rid is None:
                continue
            if rid not in seen:
                seen.add(rid)
                new_list.append(rid)
            if rid != ref:
                sub_changed = True

        if sub_changed or new_list != raw_deps:
            _write_subtask_depends_on_list(st, new_list)
            changed = True
            normalized.append({"subtaskId": sid, "depends_on": new_list})

    if not changed:
        return {"changed": False, "normalized": normalized}

    task["subtasks"] = subtasks
    storage.save_project(proj)
    if normalized:
        logger.info(
            "normalize_subtask_depends_on_refs task_id=%s: %s",
            main_task_id,
            normalized[:20],
        )
    return {"changed": True, "normalized": normalized}


def _repair_orphan_depends_on_subtask_ids(storage: Any, main_task_id: str) -> dict[str, Any]:
    """Fix depends_on entries that reference ids not in this task (stale foreign Subtask_* ids).

    When a model copies a subtask id from another session, those references never resolve and
    downstream subtasks stay blocked. We remap such refs to the first subtask in list order when
    the dependent is not the first subtask (common \"task1 then parallel wave\" pattern). For
    serial chains that depend on the second subtask, prefer depends_on by **name** instead of id.
    """
    from evoflow.collab.storage import find_main_task, rollup_root_task_progress_from_subtasks

    row = find_main_task(storage, main_task_id)
    if not row:
        return {"changed": False, "repairs": []}
    proj, task = row
    subtasks: list[dict[str, Any]] = [x for x in (task.get("subtasks") or []) if isinstance(x, dict)]
    if not subtasks:
        return {"changed": False, "repairs": []}

    by_id: dict[str, dict[str, Any]] = {}
    for st in subtasks:
        sid = str(st.get("id") or "").strip()
        if sid:
            by_id[sid] = st
    ordered_ids = [str(st.get("id")) for st in subtasks if str(st.get("id") or "").strip()]
    name_index = _build_subtask_name_index(by_id)
    ref_index = _build_ref_to_id_index(by_id)
    first_sid = ordered_ids[0] if ordered_ids else None

    changed = False
    repairs: list[dict[str, Any]] = []

    for idx, st in enumerate(subtasks):
        sid = str(st.get("id") or "").strip()
        if not sid:
            continue
        raw_deps = _subtask_dep_ids(st)
        if not raw_deps:
            continue

        new_list: list[str] = []
        seen: set[str] = set()
        sub_changed = False

        for dep_ref in raw_deps:
            ref = str(dep_ref or "").strip()
            if not ref:
                continue
            if ref == sid:
                continue

            nm_cands = name_index.get(ref) or []
            if len(nm_cands) > 1:
                repairs.append({"subtaskId": sid, "droppedAmbiguousName": ref})
                sub_changed = True
                continue

            rid = _resolve_dep_ref_to_id(
                ref,
                current_sid=sid,
                by_id=by_id,
                name_index=name_index,
                ref_index=ref_index,
            )
            if rid and rid in by_id:
                if rid not in seen:
                    seen.add(rid)
                    new_list.append(rid)
                continue

            if ref in by_id:
                if ref not in seen:
                    seen.add(ref)
                    new_list.append(ref)
                continue

            # Unresolved: stale id or unknown token — remap/drop
            if first_sid and idx > 0 and ref != first_sid:
                if first_sid not in seen:
                    seen.add(first_sid)
                    new_list.append(first_sid)
                repairs.append({"subtaskId": sid, "remappedFrom": ref, "remappedTo": first_sid})
                sub_changed = True
            else:
                repairs.append({"subtaskId": sid, "dropped": ref})
                sub_changed = True

        if sub_changed:
            _write_subtask_depends_on_list(st, new_list)
            changed = True

    if not changed:
        return {"changed": False, "repairs": repairs}

    task["subtasks"] = subtasks
    storage.save_project(proj)
    try:
        rollup_root_task_progress_from_subtasks(storage, main_task_id)
    except Exception:
        logger.debug("repair orphan depends_on: rollup failed task_id=%s", main_task_id, exc_info=True)
    if repairs:
        logger.info(
            "repaired orphan depends_on for task_id=%s: %s",
            main_task_id,
            repairs[:20],
        )
    return {"changed": True, "repairs": repairs}


def _is_auto_blocked_reason(value: Any) -> bool:
    return str(value or "").strip().startswith("auto_blocked:")


def _clear_auto_blocked_diagnostics(st: dict[str, Any]) -> bool:
    """Remove soft-block diagnostics that must not look like node execution failures."""
    cleared = False
    if _is_auto_blocked_reason(st.get("error")):
        st.pop("error", None)
        cleared = True
    if _is_auto_blocked_reason(st.get("error_text")):
        st.pop("error_text", None)
        cleared = True
    if st.pop("dispatch_block_reason", None) is not None:
        cleared = True
    return cleared


def _auto_finalize_unrunnable_pending_subtasks(storage: Any, main_task_id: str) -> dict[str, Any]:
    """Soft-block pending dependents when an upstream ended non-successfully.

    Cases:
    - upstream dependency already reached terminal non-completed state (failed/cancelled/timed_out)

    Dependents stay ``waiting_dispatch`` (not cancelled) so a later upstream retry can
    unblock them. Soft-block reason is stored on ``dispatch_block_reason`` only — never
    on ``error`` / ``error_text``, which the workflow UI treats as real failures.
    """
    from evoflow.collab.storage import find_main_task, rollup_root_task_progress_from_subtasks

    row = find_main_task(storage, main_task_id)
    if not row:
        return {"changed": False, "skipped": []}
    proj, task = row
    subtasks: list[dict[str, Any]] = [x for x in (task.get("subtasks") or []) if isinstance(x, dict)]
    if not subtasks:
        return {"changed": False, "skipped": []}

    by_id: dict[str, dict[str, Any]] = {}
    for st in subtasks:
        sid = str(st.get("id") or "").strip()
        if sid:
            by_id[sid] = st
    if not by_id:
        return {"changed": False, "skipped": []}
    name_index = _build_subtask_name_index(by_id)
    status_by_id: dict[str, str] = {sid: str(st.get("status") or "pending").strip().lower() for sid, st in by_id.items()}

    changed = False
    skipped: list[dict[str, Any]] = []
    time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    for sid, st in by_id.items():
        s_status = status_by_id.get(sid, "pending")
        if s_status in _TERMINAL_SUBTASK or s_status in _IN_FLIGHT_SUBTASK:
            continue
        deps = _subtask_dep_ids(st)
        if not deps:
            if _clear_auto_blocked_diagnostics(st):
                changed = True
            continue

        blocked_by_upstream_terminal: list[str] = []
        for dep_ref in deps:
            dep_id = _resolve_dep_ref_to_id(
                dep_ref,
                current_sid=sid,
                by_id=by_id,
                name_index=name_index,
            )
            if not dep_id or dep_id not in by_id:
                continue
            d_status = status_by_id.get(dep_id, "pending")
            if d_status in {"failed", "cancelled", "timed_out"}:
                blocked_by_upstream_terminal.append(dep_id)

        if not blocked_by_upstream_terminal:
            # Upstream recovered (or was never terminal) — drop stale soft-block noise.
            if _clear_auto_blocked_diagnostics(st):
                changed = True
            continue

        reason = f"auto_blocked: upstream_terminal_non_completed={blocked_by_upstream_terminal}"

        # IMPORTANT:
        # Do NOT permanently cancel dependents when an upstream failed.
        # Upstream subtasks can be retried and eventually succeed; dependents should become runnable again.
        # Keep diagnostic off user-facing error fields so the node does not look "failed".
        st["status"] = "waiting_dispatch"
        st["progress"] = int(st.get("progress") or 0)
        st["dispatch_block_reason"] = reason[:500]
        if _is_auto_blocked_reason(st.get("error")):
            st.pop("error", None)
        if _is_auto_blocked_reason(st.get("error_text")):
            st.pop("error_text", None)
        st.pop("completed_at", None)
        changed = True
        skipped.append({"subtaskId": sid, "reason": reason})

    if not changed:
        return {"changed": False, "skipped": []}

    task["subtasks"] = subtasks
    storage.save_project(proj)
    try:
        rollup_root_task_progress_from_subtasks(storage, main_task_id)
    except Exception:
        logger.debug("auto finalize pending subtasks: rollup failed task_id=%s", main_task_id, exc_info=True)
    return {"changed": True, "skipped": skipped}


_MAX_SUBTASK_RETRIES = 10
_FAILED_UPSTREAM_STATUSES = frozenset({"failed", "error", "timed_out", "cancelled", "canceled"})
_WAITING_DOWNSTREAM_STATUSES = frozenset({"planned", "pending", "waiting_dispatch"})


def subtask_auto_retry_max() -> int:
    import os

    raw = (os.getenv("EVOFLOW_SUBTASK_AUTO_RETRY_MAX") or "3").strip()
    try:
        return max(0, min(10, int(raw)))
    except ValueError:
        return 3


def _upstream_failure_exhausted(st: dict[str, Any], *, max_auto_retries: int) -> bool:
    status = str(st.get("status") or "").strip().lower()
    if status not in _FAILED_UPSTREAM_STATUSES:
        return False
    return int(st.get("auto_retry_count") or 0) >= max(0, int(max_auto_retries))


def skip_subtasks_blocked_by_exhausted_upstream_failure(
    storage: Any,
    main_task_id: str,
    *,
    max_auto_retries: int | None = None,
) -> dict[str, Any]:
    """Mark downstream subtasks ``skipped`` when an upstream failure cannot auto-retry."""
    from evoflow.collab.storage import find_main_task, rollup_root_task_progress_from_subtasks
    from evoflow.timeutil import utc_now_iso_z

    limit = subtask_auto_retry_max() if max_auto_retries is None else max(0, int(max_auto_retries))
    row = find_main_task(storage, main_task_id)
    if not row:
        return {"changed": False, "skipped": []}
    normalize_subtask_depends_on_refs(storage, main_task_id)
    row = find_main_task(storage, main_task_id)
    if not row:
        return {"changed": False, "skipped": []}
    proj, task = row
    subtasks: list[dict[str, Any]] = [x for x in (task.get("subtasks") or []) if isinstance(x, dict)]
    if not subtasks:
        return {"changed": False, "skipped": []}

    by_id: dict[str, dict[str, Any]] = {}
    for st in subtasks:
        sid = str(st.get("id") or "").strip()
        if sid:
            by_id[sid] = st
    name_index = _build_subtask_name_index(by_id)
    ref_index = _build_ref_to_id_index(by_id)
    now = utc_now_iso_z()
    changed = False
    skipped: list[dict[str, Any]] = []

    for sid, st in by_id.items():
        status = str(st.get("status") or "pending").strip().lower()
        if status not in _WAITING_DOWNSTREAM_STATUSES:
            continue
        blocked_by: list[str] = []
        for dep_ref in _subtask_dep_ids(st):
            dep_id = _resolve_dep_ref_to_id(
                dep_ref,
                current_sid=sid,
                by_id=by_id,
                name_index=name_index,
                ref_index=ref_index,
            )
            if not dep_id:
                continue
            dep_st = by_id.get(dep_id)
            if isinstance(dep_st, dict) and _upstream_failure_exhausted(dep_st, max_auto_retries=limit):
                blocked_by.append(dep_id)
        if not blocked_by:
            continue
        reason = f"auto_skipped: upstream_exhausted={blocked_by}"
        st["status"] = "skipped"
        st["progress"] = int(st.get("progress") or 0)
        st["updated_at"] = now
        st["error"] = reason[:500]
        st["error_text"] = reason[:500]
        st.pop("completed_at", None)
        changed = True
        skipped.append({"subtaskId": sid, "reason": reason})

    if not changed:
        return {"changed": False, "skipped": []}

    task["subtasks"] = subtasks
    storage.save_project(proj)
    try:
        rollup_root_task_progress_from_subtasks(storage, main_task_id)
    except Exception:
        logger.debug("skip blocked subtasks: rollup failed task_id=%s", main_task_id, exc_info=True)
    return {"changed": True, "skipped": skipped}


def requeue_failed_subtasks_ready_for_retry(storage: Any, main_task_id: str) -> list[str]:
    """Reset failed subtasks whose dependencies are satisfied so start_execution can run again.

    Used when the user clicks「开始执行」after a prior wave left root subtasks in ``failed``.
    """
    from evoflow.collab.storage import find_main_task
    from evoflow.timeutil import utc_now_iso_z

    row = find_main_task(storage, main_task_id)
    if not row:
        return []
    normalize_subtask_depends_on_refs(storage, main_task_id)
    row = find_main_task(storage, main_task_id)
    if not row:
        return []
    proj, task = row
    subtasks: list[dict[str, Any]] = [x for x in (task.get("subtasks") or []) if isinstance(x, dict)]
    if not subtasks:
        return []

    by_id: dict[str, dict[str, Any]] = {}
    for st in subtasks:
        sid = str(st.get("id") or "").strip()
        if sid:
            by_id[sid] = st
    name_index = _build_subtask_name_index(by_id)
    ref_index = _build_ref_to_id_index(by_id)
    status_by_id: dict[str, str] = {sid: str(st.get("status") or "pending").strip().lower() for sid, st in by_id.items()}

    def unmet_dependencies(sid: str, st: dict[str, Any]) -> list[str]:
        bad: list[str] = []
        for dep_ref in _subtask_dep_ids(st):
            dep = _resolve_dep_ref_to_id(
                dep_ref,
                current_sid=sid,
                by_id=by_id,
                name_index=name_index,
                ref_index=ref_index,
            )
            if dep is None:
                ref = str(dep_ref or "").strip()
                if ref and ref != sid:
                    bad.append(f"invalid_dep:{ref}")
                continue
            dep_st = by_id.get(dep)
            from evoflow.collab.subtask_outcome import is_upstream_subtask_dependency_met

            if not is_upstream_subtask_dependency_met(dep_st if isinstance(dep_st, dict) else None):
                bad.append(dep)
        return bad

    now = utc_now_iso_z()
    requeued: list[str] = []
    for sid, st in by_id.items():
        if status_by_id.get(sid) != "failed":
            continue
        wp = st.get("worker_profile")
        max_retries = 3
        if isinstance(wp, dict) and wp.get("max_retries") is not None:
            try:
                max_retries = int(wp.get("max_retries"))
            except (TypeError, ValueError):
                max_retries = 3
        max_retries = max(0, min(int(max_retries), _MAX_SUBTASK_RETRIES))
        if int(st.get("retry_count") or 0) >= max_retries:
            continue
        if unmet_dependencies(sid, st):
            continue
        st["status"] = "pending"
        st["progress"] = 0
        st["updated_at"] = now
        st["retry_count"] = int(st.get("retry_count") or 0) + 1
        st["last_retry_at"] = now
        st["last_retry_from_status"] = "failed"
        for key in ("error", "failed_at", "result", "completed_at"):
            st.pop(key, None)
        requeued.append(sid)
        status_by_id[sid] = "pending"

    if not requeued:
        return []

    task["subtasks"] = subtasks
    storage.save_project(proj)
    return requeued


def _resolve_subtasks_for_start_execution(
    storage: Any,
    main_task_id: str,
    explicit: list[str] | None,
) -> tuple[list[str], list[dict[str, Any]]]:
    """Pick subtasks to delegate in this wave: assigned, non-terminal, all depends_on completed.

    Multiple subtasks whose dependencies are all satisfied run **in parallel** in the same start_execution.
    Subtasks still waiting on upstream work are returned in ``blocked`` for UI / lead planning.

    Returns:
        runnable: ordered ids to pass to delegate (explicit order if explicit; else subtasks list order).
        blocked: diagnostic rows (e.g. dependencies_not_satisfied, unassigned, already_terminal).
    """
    from evoflow.collab.storage import find_main_task

    row = find_main_task(storage, main_task_id)
    if not row:
        return [], []
    normalize_subtask_depends_on_refs(storage, main_task_id)
    row = find_main_task(storage, main_task_id)
    if not row:
        return [], []
    _proj, task = row
    subtasks: list[Any] = task.get("subtasks") or []
    by_id: dict[str, dict[str, Any]] = {}
    for st in subtasks:
        sid = st.get("id")
        if sid:
            by_id[str(sid)] = st
    name_index = _build_subtask_name_index(by_id)
    ref_index = _build_ref_to_id_index(by_id)
    status_by_id: dict[str, str] = {sid: (st.get("status") or "pending").strip().lower() for sid, st in by_id.items()}

    def unmet_dependencies(sid: str, st: dict[str, Any]) -> list[str]:
        bad: list[str] = []
        for dep_ref in _subtask_dep_ids(st):
            dep = _resolve_dep_ref_to_id(
                dep_ref,
                current_sid=sid,
                by_id=by_id,
                name_index=name_index,
                ref_index=ref_index,
            )
            if dep is None:
                ref = str(dep_ref or "").strip()
                if not ref or ref == sid:
                    continue
                bad.append(f"invalid_dep:{ref}")
                continue
            dep_st = by_id.get(dep)
            from evoflow.collab.subtask_outcome import is_upstream_subtask_dependency_met

            if not is_upstream_subtask_dependency_met(dep_st if isinstance(dep_st, dict) else None):
                bad.append(dep)
        return bad

    def eligible(sid: str) -> bool:
        st = by_id.get(sid)
        if not st:
            return False
        status = status_by_id.get(sid, "pending")
        if status in _TERMINAL_SUBTASK:
            return False
        if status in _IN_FLIGHT_SUBTASK:
            return False
        if not str(st.get("assigned_to") or "").strip():
            return False
        return len(unmet_dependencies(sid, st)) == 0

    runnable: list[str] = []
    blocked: list[dict[str, Any]] = []

    if explicit:
        explicit_ids, _unresolved = resolve_explicit_subtask_tokens(storage, main_task_id, explicit)
        seen: set[str] = set()
        for sid in explicit_ids:
            if not sid or sid in seen:
                continue
            seen.add(sid)
            st = by_id.get(sid)
            if not st:
                blocked.append({"subtaskId": sid, "reason": "not_found"})
                continue
            stt = status_by_id.get(sid, "pending")
            if stt in _TERMINAL_SUBTASK:
                blocked.append({"subtaskId": sid, "reason": "already_terminal", "status": stt})
                continue
            if stt in _IN_FLIGHT_SUBTASK:
                blocked.append({"subtaskId": sid, "reason": "in_flight", "unmetDependencies": []})
                continue
            if not str(st.get("assigned_to") or "").strip():
                blocked.append({"subtaskId": sid, "reason": "unassigned"})
                continue
            # Explicit ids still must respect depends_on. Skipping caused Step2 to
            # start while Step1 was incomplete after stop→update→restart / resume.
            unmet = unmet_dependencies(sid, st)
            if unmet:
                blocked.append(
                    {
                        "subtaskId": sid,
                        "reason": "waiting_on_dependencies",
                        "unmetDependencies": unmet,
                    }
                )
                continue
            runnable.append(sid)
        return runnable, blocked

    seen_run: set[str] = set()
    for st in subtasks:
        sid = st.get("id")
        if not sid:
            continue
        sid = str(sid)
        if not eligible(sid):
            continue
        if sid in seen_run:
            continue
        seen_run.add(sid)
        runnable.append(sid)

    for sid, st in by_id.items():
        if sid in seen_run:
            continue
        status = status_by_id.get(sid, "pending")
        if status in _TERMINAL_SUBTASK:
            continue
        if not str(st.get("assigned_to") or "").strip():
            continue
        if status in _IN_FLIGHT_SUBTASK:
            blocked.append(
                {
                    "subtaskId": sid,
                    "reason": "in_flight",
                    "unmetDependencies": [],
                }
            )
            continue
        blocked.append(
            {
                "subtaskId": sid,
                "reason": "waiting_on_dependencies",
                "unmetDependencies": unmet_dependencies(sid, st),
            }
        )
    return runnable, blocked


__all__ = [
    "_TERMINAL_SUBTASK",
    "_IN_FLIGHT_SUBTASK",
    "_extract_dep_refs_from_subtask_spec",
    "_subtask_spec_ref",
    "_max_numeric_subtask_ref",
    "_effective_subtask_ref",
    "assign_default_refs_to_batch",
    "next_subtask_ref_for_append",
    "_build_existing_ref_to_id",
    "_build_batch_ref_and_index_maps",
    "normalize_depends_on_at_create",
    "_subtask_dep_ids",
    "_build_ref_to_id_index",
    "_build_subtask_name_index",
    "resolve_explicit_subtask_tokens",
    "_resolve_dep_ref_to_id",
    "normalize_subtask_depends_on_refs",
    "_repair_orphan_depends_on_subtask_ids",
    "_auto_finalize_unrunnable_pending_subtasks",
    "requeue_failed_subtasks_ready_for_retry",
    "_resolve_subtasks_for_start_execution",
]
