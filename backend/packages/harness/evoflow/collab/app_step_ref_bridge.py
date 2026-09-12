"""Bridge workflow plan refs (semantic) with runtime subtask refs (numeric).

Used by ``get_run_status`` and OpenAPI answer synthesis so API consumers
see consistent ``subtask_status``, ``step_ref_to_subtask_id``, and run-level outputs.
"""

from __future__ import annotations

import re
from typing import Any

_STEP_PREFIX_RE = re.compile(r"(?i)^\s*step\s+\d+\s*[:：]\s*")
_DONE_STATUS = frozenset({"completed", "done", "success"})


def strip_runtime_step_prefix(name: str | None) -> str:
    return _STEP_PREFIX_RE.sub("", str(name or "")).strip()


def subtask_semantic_ref(st: dict[str, Any]) -> str:
    direct = str(st.get("semantic_ref") or "").strip()
    if direct:
        return direct
    wp = st.get("worker_profile")
    if isinstance(wp, dict):
        from_wp = str(wp.get("semantic_ref") or "").strip()
        if from_wp:
            return from_wp
    return ""


def plan_step_semantic_ref(step: dict[str, Any], *, index: int) -> str:
    if not isinstance(step, dict):
        return ""
    explicit = str(step.get("semantic_ref") or "").strip()
    if explicit:
        return explicit
    raw = str(step.get("ref") if step.get("ref") is not None else step.get("step_num") or "").strip()
    if raw:
        try:
            int(raw)
        except ValueError:
            return raw
    return ""


def plan_step_alias_refs(step: dict[str, Any], index: int) -> set[str]:
    aliases: set[str] = {str(index + 1)}
    if not isinstance(step, dict):
        return aliases
    ref = str(step.get("ref") if step.get("ref") is not None else step.get("step_num") or "").strip()
    semantic = plan_step_semantic_ref(step, index=index)
    if ref:
        aliases.add(ref)
    if semantic:
        aliases.add(semantic)
    return aliases


def _ref_sort_key(step: dict[str, Any]) -> tuple[int, str]:
    ref = str(step.get("ref") or "").strip()
    try:
        return (int(ref), ref)
    except ValueError:
        return (10**9, ref or str(step.get("name") or ""))


def build_step_ref_alias_map(
    plan_steps: list[dict[str, Any]],
    steps_detail: list[dict[str, Any]],
    *,
    app_steps: list[dict[str, Any]] | None = None,
) -> dict[str, str]:
    """Map any plan/runtime alias (e.g. ``brief``) → canonical runtime ref (e.g. ``1``)."""
    alias_map: dict[str, str] = {}
    app_plan = [s for s in (app_steps or []) if isinstance(s, dict)]

    for idx, detail in enumerate(steps_detail):
        if not isinstance(detail, dict):
            continue
        canonical = str(detail.get("ref") or "").strip() or str(idx + 1)
        alias_map[canonical] = canonical

        sem = str(detail.get("semantic_ref") or "").strip()
        if sem:
            alias_map[sem] = canonical

        for source in (
            plan_steps[idx] if idx < len(plan_steps) else None,
            app_plan[idx] if idx < len(app_plan) else None,
        ):
            if not isinstance(source, dict):
                continue
            for alias in plan_step_alias_refs(source, idx):
                alias_map[alias] = canonical

    return alias_map


def resolve_step_ref(ref: str, alias_map: dict[str, str]) -> str:
    raw = str(ref or "").strip()
    if not raw:
        return ""
    return alias_map.get(raw, raw)


def mirror_ref_aliases(target: dict[str, Any], alias_map: dict[str, str]) -> None:
    """Duplicate values under semantic aliases (canonical keys win)."""
    for alias, canonical in alias_map.items():
        if alias == canonical:
            continue
        if canonical in target and alias not in target:
            target[alias] = target[canonical]


def find_step_by_ref(
    steps_detail: list[dict[str, Any]],
    ref: str,
    alias_map: dict[str, str],
) -> dict[str, Any] | None:
    want = resolve_step_ref(ref, alias_map)
    for step in steps_detail:
        if not isinstance(step, dict):
            continue
        if str(step.get("ref") or "").strip() == want:
            return step
    return None


def last_successful_step_with_outputs(
    steps_detail: list[dict[str, Any]],
) -> dict[str, Any] | None:
    candidates: list[dict[str, Any]] = []
    for step in steps_detail:
        if not isinstance(step, dict):
            continue
        if str(step.get("status") or "").strip().lower() not in _DONE_STATUS:
            continue
        outputs = step.get("outputs")
        if isinstance(outputs, list) and outputs:
            candidates.append(step)
    if not candidates:
        return None
    return max(candidates, key=_ref_sort_key)


def enrich_step_detail(
    detail: dict[str, Any],
    *,
    subtask: dict[str, Any],
    plan_step: dict[str, Any] | None,
    app_step: dict[str, Any] | None,
    index: int,
) -> dict[str, Any]:
    """Attach ``semantic_ref`` and a stable display name to a run-status step row."""
    out = dict(detail)
    semantic = subtask_semantic_ref(subtask)
    if not semantic and isinstance(plan_step, dict):
        semantic = plan_step_semantic_ref(plan_step, index=index)
    if not semantic and isinstance(app_step, dict):
        semantic = plan_step_semantic_ref(app_step, index=index)
    if semantic:
        out["semantic_ref"] = semantic

    plan_name = ""
    for src in (plan_step, app_step):
        if isinstance(src, dict):
            plan_name = str(src.get("name") or src.get("goal") or "").strip()
            if plan_name:
                break
    runtime_name = strip_runtime_step_prefix(str(out.get("name") or ""))
    if plan_name:
        out["display_name"] = plan_name
    elif runtime_name:
        out["display_name"] = runtime_name
    return out


def pick_preferred_run_outputs_step(
    steps_detail: list[dict[str, Any]],
    *,
    answer_ref: str = "",
    alias_map: dict[str, str] | None = None,
) -> dict[str, Any] | None:
    """Rollup → answer node (alias-aware) → last successful step with outputs."""
    aliases = alias_map or {}
    rollup = next(
        (
            s
            for s in steps_detail
            if isinstance(s, dict)
            and (s.get("is_rollup_step") or str(s.get("ref") or "").strip() == "__rollup__")
            and s.get("outputs")
        ),
        None,
    )
    if rollup:
        return rollup

    hint = str(answer_ref or "").strip()
    if hint:
        hit = find_step_by_ref(steps_detail, hint, aliases)
        if hit and hit.get("outputs"):
            return hit

    return last_successful_step_with_outputs(steps_detail)
