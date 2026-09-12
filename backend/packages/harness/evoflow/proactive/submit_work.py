"""Persist a proactive think-cycle via structured tool args (not LLM prose JSON)."""

from __future__ import annotations

import logging
from typing import Any

from evoflow.proactive.models import (
    Initiative,
    InitiativeActionType,
    InitiativeRiskLevel,
    InitiativeStatus,
    ProactiveAutonomyLevel,
    ProactiveRole,
)
from evoflow.proactive.repositories import ProactiveMemoryRepository, ProactiveRepository
from evoflow.timeutil import utc_now_iso_z

logger = logging.getLogger(__name__)

_DEFAULT_MAX_INITIATIVES = 3

_STATUS_ALIASES = {
    "done": InitiativeStatus.COMPLETED,
    "complete": InitiativeStatus.COMPLETED,
    "completed": InitiativeStatus.COMPLETED,
    "success": InitiativeStatus.COMPLETED,
    "fail": InitiativeStatus.FAILED,
    "failed": InitiativeStatus.FAILED,
    "error": InitiativeStatus.FAILED,
    "executing": InitiativeStatus.EXECUTING,
    "in_progress": InitiativeStatus.EXECUTING,
    "progress": InitiativeStatus.EXECUTING,
    "proposed": InitiativeStatus.PROPOSED,
    "pending": InitiativeStatus.PENDING_APPROVAL,
    "pending_approval": InitiativeStatus.PENDING_APPROVAL,
    "rejected": InitiativeStatus.REJECTED,
    "skipped": InitiativeStatus.SKIPPED,
}

_UPDATABLE_STATUSES = frozenset(
    {
        InitiativeStatus.PROPOSED,
        InitiativeStatus.PENDING_APPROVAL,
        InitiativeStatus.APPROVED,
        InitiativeStatus.EXECUTING,
        InitiativeStatus.COMPLETED,
        InitiativeStatus.FAILED,
        InitiativeStatus.SKIPPED,
    }
)


def _as_str_list(raw: Any) -> list[str]:
    if raw is None:
        return []
    if isinstance(raw, str):
        s = raw.strip()
        return [s] if s else []
    if isinstance(raw, list):
        out: list[str] = []
        for item in raw:
            t = str(item or "").strip()
            if t:
                out.append(t)
        return out
    return []


def _normalize_initiative_dicts(raw: Any) -> list[dict[str, Any]]:
    if raw is None:
        return []
    if isinstance(raw, dict):
        raw = [raw]
    if not isinstance(raw, list):
        return []
    out: list[dict[str, Any]] = []
    for item in raw:
        if hasattr(item, "model_dump"):
            try:
                item = item.model_dump()
            except Exception:
                item = dict(item)  # type: ignore[arg-type]
        if isinstance(item, dict):
            out.append(item)
    return out


def _normalize_phase(raw: Any) -> str:
    p = str(raw or "wrap_up").strip().lower().replace("-", "_")
    if p in ("checkin", "check_in", "start", "begin", "kickoff"):
        return "check_in"
    if p in ("progress", "update", "mid", "status"):
        return "progress"
    return "wrap_up"


def _parse_status(raw: Any) -> InitiativeStatus | None:
    key = str(raw or "").strip().lower()
    if not key:
        return None
    return _STATUS_ALIASES.get(key)


def _is_journal(init: Initiative) -> bool:
    plan = init.action_plan if isinstance(init.action_plan, dict) else {}
    return str(plan.get("kind") or "") == "round_log"


def _find_open_by_title(role_code: str, title: str) -> Initiative | None:
    want = str(title or "").strip()
    if not want:
        return None
    for init in ProactiveRepository.list_initiatives(role_agent_code=role_code, limit=60):
        if _is_journal(init):
            continue
        if str(init.title or "").strip() == want:
            return init
    return None


def _apply_initiative_updates(
    *,
    role_code: str,
    updates: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    applied: list[dict[str, Any]] = []
    for raw in updates:
        iid = str(raw.get("initiative_id") or raw.get("id") or "").strip()
        title = str(raw.get("title") or "").strip()
        note = str(raw.get("progress_note") or raw.get("note") or "").strip()
        exec_result = str(raw.get("execution_result") or raw.get("outcome") or "").strip()
        status = _parse_status(raw.get("status"))

        target: Initiative | None = None
        if iid:
            target = ProactiveRepository.get_initiative(iid)
        if target is None and title:
            target = _find_open_by_title(role_code, title)
        if target is None or target.role_agent_code != role_code:
            applied.append({"ok": False, "error": "initiative not found", "title": title, "initiative_id": iid})
            continue

        dirty = False
        if note:
            # Append progress into description / execution_result trail
            stamp = utc_now_iso_z()
            blob = f"\n\n[{stamp}] 进度：{note}"
            if exec_result:
                target.execution_result = ((target.execution_result or "") + blob + f"\n结果：{exec_result}")[
                    -8000:
                ]
            else:
                target.execution_result = ((target.execution_result or "") + blob)[-8000:]
            dirty = True
        elif exec_result:
            target.execution_result = exec_result[:8000]
            dirty = True

        if status is not None and status in _UPDATABLE_STATUSES:
            # Don't silently overwrite human pending_approval → completed without note;
            # still allow agent to mark completed/failed/executing on proposed/approved/executing.
            target.status = status
            dirty = True

        if dirty:
            target.updated_at = utc_now_iso_z()
            ProactiveRepository.save_initiative(target)
            applied.append(
                {
                    "ok": True,
                    "initiative_id": target.id,
                    "title": target.title,
                    "status": target.status.value,
                }
            )
        else:
            applied.append(
                {
                    "ok": False,
                    "error": "nothing to update",
                    "initiative_id": target.id,
                    "title": target.title,
                }
            )
    return applied


def _upsert_round_journal(
    *,
    role: ProactiveRole,
    round_id: str,
    phase: str,
    goal: str,
    outcome: str,
    reflection: str,
    observations: list[str],
    incomplete: bool = False,
) -> str:
    """Create or refresh the round_log row for this duty cycle."""
    recent = ProactiveRepository.list_initiatives(role_agent_code=role.agent_code, limit=40)
    journal = next(
        (i for i in recent if str(i.round_id or "") == round_id and _is_journal(i)),
        None,
    )

    goal_s = goal
    outcome_s = outcome
    reflection_s = reflection
    obs = observations

    if phase == "check_in":
        title = (goal_s[:80] if goal_s else "本轮开始工作") if not journal else (journal.title or "本轮开始工作")
        desc_parts = ["【开工汇报】已开始本轮工作。"]
        if goal_s:
            desc_parts.append(f"目标：{goal_s}")
        if obs:
            desc_parts.append("初步观察：\n" + "\n".join(f"- {o}" for o in obs[:12]))
        status = InitiativeStatus.EXECUTING
    else:
        title = goal_s[:80] if goal_s else (journal.title if journal else "本轮工作汇报")
        desc_parts = []
        if phase == "progress":
            desc_parts.append("【中途汇报】")
        elif incomplete:
            desc_parts.append("【工作汇报·未完成】系统补齐：模型未显式完成下班小结。")
        else:
            desc_parts.append("【工作汇报】")
        if outcome_s:
            desc_parts.append(outcome_s)
        if reflection_s:
            desc_parts.append(reflection_s)
        if obs:
            desc_parts.append("观察：\n" + "\n".join(f"- {o}" for o in obs[:12]))
        if not desc_parts or len(desc_parts) == 1:
            desc_parts.append(
                "本轮未写完工作汇报，记为未完成。"
                if incomplete
                else (
                    "本轮已汇报，未提出新的待办事项。"
                    if phase == "wrap_up"
                    else "进度已同步。"
                )
            )
        # Incomplete auto wrap is FAILED so it does not look like a healthy patrol.
        if phase == "wrap_up" and incomplete:
            status = InitiativeStatus.FAILED
        elif phase == "wrap_up":
            status = InitiativeStatus.COMPLETED
        else:
            status = InitiativeStatus.EXECUTING

    body = "\n\n".join(desc_parts)[:4000]
    now = utc_now_iso_z()

    # Close stale check_in journals from *previous* rounds before creating a
    # new one.  Without this, a check_in journal that never received a
    # matching wrap_up stays EXECUTING forever and becomes a zombie record.
    if not journal and phase == "check_in":
        for prev in recent:
            if str(prev.round_id or "") == round_id or not _is_journal(prev):
                continue
            prev_plan = prev.action_plan if isinstance(prev.action_plan, dict) else {}
            prev_phase = str(prev_plan.get("phase") or "")
            if prev.status == InitiativeStatus.EXECUTING and prev_phase == "check_in":
                prev.status = InitiativeStatus.FAILED
                prev.execution_result = "上一轮 check_in 未收尾，已被新一轮自动关闭。"
                prev.updated_at = now
                ProactiveRepository.save_initiative(prev)
                logger.info(
                    "proactive.submit_work: closed stale check_in journal=%s prev_round=%s",
                    prev.id,
                    prev.round_id,
                )

    if journal:
        # Keep earlier check-in text when wrapping up
        if phase == "wrap_up" and journal.description and "【开工汇报】" in (journal.description or ""):
            body = (journal.description + "\n\n---\n\n" + body)[:4000]
        journal.title = title[:120]
        journal.description = body
        journal.goal = goal_s or journal.goal
        journal.outcome = outcome_s or reflection_s or journal.outcome
        journal.status = status
        journal.updated_at = now
        journal.action_plan = _round_log_plan(
            phase=phase,
            incomplete=incomplete and phase == "wrap_up",
            reflection=reflection_s,
        )
        ProactiveRepository.save_initiative(journal)
        return journal.id

    note = Initiative(
        id=ProactiveRepository.new_initiative_id(),
        role_agent_code=role.agent_code,
        title=title[:120],
        description=body,
        rationale="",
        action_type=InitiativeActionType.REPORT,
        risk_level=InitiativeRiskLevel.LOW,
        action_plan=_round_log_plan(
            phase=phase,
            incomplete=incomplete and phase == "wrap_up",
            reflection=reflection_s,
        ),
        expected_outcome=outcome_s,
        status=status,
        approval_timeout_minutes=role.config.approval_timeout_minutes,
        config_autonomy_level=role.config.autonomy_level,
        round_id=round_id,
        goal=goal_s,
        outcome=outcome_s or reflection_s,
        execution_result="",
        created_at=now,
        updated_at=now,
    )
    ProactiveRepository.save_initiative(note)
    return note.id


def _round_log_plan(
    *,
    phase: str,
    incomplete: bool = False,
    reflection: str = "",
) -> dict[str, Any]:
    """Structured metadata for round journals (UI scorecard + next-round prompts)."""
    plan: dict[str, Any] = {"kind": "round_log", "phase": phase}
    if incomplete:
        plan["incomplete"] = True
    ref = str(reflection or "").strip()
    if ref:
        plan["reflection"] = ref[:800]
    return plan


def apply_proactive_submit_work(
    *,
    role_agent_code: str,
    round_id: str,
    goal: str = "",
    outcome: str = "",
    reflection: str = "",
    observations: Any = None,
    initiatives: Any = None,
    initiative_updates: Any = None,
    phase: str | None = None,
    max_initiatives: int | None = None,
    incomplete: bool = False,
) -> dict[str, Any]:
    """Write / update work-log rows for one think cycle.

    Supports multi-call:
      - check_in: start-of-shift report (required conceptually)
      - progress: update open initiatives mid-shift
      - wrap_up: end-of-shift report + new initiatives

    ``incomplete=True`` marks an engine-forced wrap_up as FAILED (not success theater)
    and skips overwriting long-term memory with the boilerplate summary.
    """
    code = str(role_agent_code or "").strip()
    rid = str(round_id or "").strip()
    if not code:
        return {"ok": False, "error": "missing proactive_agent_code / session binding"}
    if not rid:
        return {"ok": False, "error": "missing round_id"}

    role = ProactiveRepository.get_role(code)
    if not role:
        return {"ok": False, "error": f"role '{code}' not found"}

    phase_s = _normalize_phase(phase)
    goal_s = str(goal or "").strip()
    outcome_s = str(outcome or "").strip()
    reflection_s = str(reflection or "").strip()
    obs = _as_str_list(observations)
    drafts = _normalize_initiative_dicts(initiatives)
    updates = _normalize_initiative_dicts(initiative_updates)

    max_n = max_initiatives
    if max_n is None:
        max_n = role.config.max_initiatives_per_cycle or _DEFAULT_MAX_INITIATIVES
    max_n = max(0, int(max_n))
    if len(drafts) > max_n:
        drafts = drafts[:max_n]

    # 1) Progress updates on existing items (any phase)
    update_results = _apply_initiative_updates(role_code=code, updates=updates) if updates else []

    recent = ProactiveRepository.list_initiatives(role_agent_code=code, limit=50)
    existing_titles = [
        str(i.title or "").strip()
        for i in recent
        if str(i.title or "").strip() and not _is_journal(i)
    ]
    existing_goals = [
        str(i.goal or i.title or "").strip()
        for i in recent[:25]
        if str(i.goal or i.title or "").strip()
    ]

    from evoflow.proactive.title_similarity import find_near_duplicate_title

    created_ids: list[str] = []
    created_task_ids: list[str] = []
    skipped: list[str] = []
    skipped_near: list[dict[str, str]] = []

    # Also consider existing role work-item task titles for near-dup hints
    # (CLI-created items); no longer create Tasks from initiatives[] here.
    try:
        from evoflow.collab.storage import get_project_storage

        _rn = str(role.role_name or "").strip().lower()
        if _rn:
            _storage = get_project_storage()
            for _p in _storage.list_projects():
                _proj = _storage.load_project(_p["id"])
                if not _proj:
                    continue
                for _t in _proj.get("tasks") or []:
                    if str(_t.get("assigned_role") or "").strip().lower() != _rn:
                        continue
                    _st = str(_t.get("status") or "").strip().lower()
                    if _st in {"cancelled", "failed", "completed"}:
                        continue
                    _nm = str(_t.get("name") or "").strip()
                    if _nm:
                        existing_titles.append(_nm)
                        existing_goals.append(_nm)
    except Exception:
        logger.debug("proactive.submit_work: task title scan failed", exc_info=True)

    # 2) Actionable work items are created via CLI only (evoflow tasks create).
    # initiatives[] is ignored for Task creation to keep a single write path.
    ignored_initiative_titles: list[str] = []
    if phase_s != "check_in" and drafts:
        for data in drafts:
            title = str(data.get("title") or "").strip()
            if not title:
                continue
            ignored_initiative_titles.append(title)
            skipped.append(title)
        if ignored_initiative_titles:
            logger.warning(
                "proactive.submit_work: ignoring initiatives[] for Task create "
                "(use evoflow tasks create) role=%s count=%d",
                code,
                len(ignored_initiative_titles),
            )

    # Soft-guard check_in goal paraphrase: keep journal but warn in observations.
    near_goal = ""
    if phase_s == "check_in" and goal_s:
        near_goal = find_near_duplicate_title(goal_s, existing_goals) or ""
        if near_goal and near_goal != goal_s:
            obs = [
                f"注意：本轮 goal 与近期事项接近「{near_goal[:60]}」。"
                "应优先 initiative_updates 关闭/推进旧事项，勿换措辞重开同题。",
                *obs,
            ]

    # 3) Always refresh round journal for check_in / wrap_up; progress if narrative provided
    journal_id = ""
    if phase_s in ("check_in", "wrap_up") or goal_s or outcome_s or reflection_s or obs:
        journal_id = _upsert_round_journal(
            role=role,
            round_id=rid,
            phase=phase_s,
            goal=goal_s,
            outcome=outcome_s,
            reflection=reflection_s,
            observations=obs,
            incomplete=incomplete and phase_s == "wrap_up",
        )

    if not incomplete and (reflection_s or obs or outcome_s):
        ProactiveMemoryRepository.update_after_think(
            code,
            new_observations=obs,
            reflection=reflection_s or outcome_s or goal_s,
        )

    # Person Kernel: LLM wrap-up (journal / lessons / craft / affect)
    lesson_result: dict[str, Any] | None = None
    person_memory_result: dict[str, Any] | None = None
    craft_result: dict[str, Any] | None = None
    if phase_s == "wrap_up":
        try:
            from evoflow.person_wrap_up_reflect import run_person_wrap_up_llm

            statements: list[str] = []
            if goal_s:
                statements.append(f"本轮目标：{goal_s[:200]}")
            if outcome_s:
                statements.append(f"产出：{outcome_s[:240]}")
            if reflection_s:
                statements.append(f"反思：{reflection_s[:240]}")
            for o in obs[:8]:
                statements.append(f"观察：{str(o)[:200]}")
            if incomplete:
                statements.append("标记：本轮未完整收口（incomplete）")
            if statements:
                pk = run_person_wrap_up_llm(
                    code,
                    statements=statements,
                    round_id=rid,
                    environment_context=goal_s,
                    run_error="incomplete" if incomplete else None,
                    source="wrap_up_llm",
                )
                lesson_result = pk.get("lesson") if isinstance(pk, dict) else None
                person_memory_result = {
                    "ok": bool(pk.get("ok")),
                    "journal_id": pk.get("journal_id"),
                    "skipped": pk.get("skipped"),
                    "error": pk.get("error"),
                }
                craft_result = {
                    "ok": bool(pk.get("craft_id") or pk.get("ok")),
                    "entry_id": pk.get("craft_id"),
                }
            else:
                person_memory_result = {"ok": True, "skipped": True, "reason": "no_statements"}
        except Exception:
            logger.debug("proactive.submit_work: person kernel llm wrap_up skipped", exc_info=True)
            if not incomplete:
                lesson_result = lesson_result or {"ok": False, "error": "lesson_hook_failed"}
                person_memory_result = person_memory_result or {
                    "ok": False,
                    "error": "person_memory_hook_failed",
                }
            craft_result = craft_result or {"ok": False, "error": "craft_hook_failed"}

    proposed_ids = [
        i.id
        for i in ProactiveRepository.list_initiatives(role_agent_code=code, limit=40)
        if str(i.round_id or "") == rid
        and i.status == InitiativeStatus.PROPOSED
        and not _is_journal(i)
    ]

    logger.info(
        "proactive.submit_work role=%s round=%s phase=%s created=%d tasks=%d updates=%d "
        "proposed=%d skipped=%d near=%d incomplete=%s",
        code,
        rid,
        phase_s,
        len(created_ids),
        len(created_task_ids),
        len(update_results),
        len(proposed_ids),
        len(skipped),
        len(skipped_near),
        incomplete,
    )
    result = {
        "ok": True,
        "role_agent_code": code,
        "round_id": rid,
        "phase": phase_s,
        "journal_id": journal_id,
        "created_ids": created_ids,
        "created_task_ids": created_task_ids,
        "proposed_ids": proposed_ids,
        "initiative_updates": update_results,
        "skipped_titles": skipped,
        "skipped_near_duplicates": skipped_near,
        "ignored_initiatives_use_cli": ignored_initiative_titles,
        "near_goal_hint": near_goal or None,
        "incomplete": incomplete,
        "goal": goal_s,
        "initiative_count": len(created_ids) + len(created_task_ids),
        "hint": (
            "开工已记录；继续工作后请再调用 phase=wrap_up 写工作汇报"
            if phase_s == "check_in"
            else (
                "进度已写入；结束本轮请再调用 phase=wrap_up"
                if phase_s == "progress"
                else (
                    "工作汇报已写入（系统补交·未完成）"
                    if incomplete
                    else (
                        "工作汇报已写入工作日志"
                        + (
                            "；可行动项请用 shell：evoflow tasks create "
                            f'--role "{role.role_name}" --raised-by {code} '
                            f"--source-ref {rid}"
                            if ignored_initiative_titles
                            else ""
                        )
                    )
                )
            )
        ),
    }
    if lesson_result is not None:
        result["person_lesson"] = lesson_result
    if person_memory_result is not None:
        result["person_memory"] = person_memory_result
    return result


def _build_initiative(
    role: ProactiveRole,
    data: dict[str, Any],
    *,
    round_id: str,
    goal: str,
    outcome: str,
) -> Initiative | None:
    title = str(data.get("title") or "").strip()
    if not title:
        return None
    description = str(data.get("description") or "").strip() or title

    try:
        action_type = InitiativeActionType(str(data.get("action_type") or "analysis"))
    except ValueError:
        action_type = InitiativeActionType.ANALYSIS
    try:
        risk_level = InitiativeRiskLevel(str(data.get("risk_level") or "low"))
    except ValueError:
        risk_level = InitiativeRiskLevel.LOW

    plan = data.get("action_plan")
    if not isinstance(plan, dict):
        plan = {}
    steps = _as_str_list(data.get("steps"))
    files = _as_str_list(data.get("target_files"))
    if steps and "steps" not in plan:
        plan = {**plan, "steps": steps}
    if files and "target_files" not in plan:
        plan = {**plan, "target_files": files}

    autonomy = role.config.autonomy_level
    if not isinstance(autonomy, ProactiveAutonomyLevel):
        try:
            autonomy = ProactiveAutonomyLevel(str(autonomy))
        except ValueError:
            autonomy = ProactiveAutonomyLevel.APPROVAL_FOR_RISKY

    return Initiative(
        id=ProactiveRepository.new_initiative_id(),
        role_agent_code=role.agent_code,
        title=title,
        description=description,
        rationale=str(data.get("rationale") or "").strip(),
        action_type=action_type,
        risk_level=risk_level,
        action_plan=plan,
        expected_outcome=str(data.get("expected_outcome") or "").strip(),
        status=InitiativeStatus.PROPOSED,
        approval_timeout_minutes=role.config.approval_timeout_minutes,
        config_autonomy_level=autonomy,
        round_id=round_id,
        goal=goal,
        outcome=outcome,
        created_at=utc_now_iso_z(),
        updated_at=utc_now_iso_z(),
    )
