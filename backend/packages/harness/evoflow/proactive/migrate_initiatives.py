"""Migrate actionable proactive initiatives → collab Tasks (岗位工作项).

Journal / round_log initiatives are left untouched (交班轮次叙事).

Idempotent: skips initiatives whose id already appears as any task's
``source_ref``. Also re-links pending approvals to the new ``task_id``.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)

_JOURNAL_KIND = "round_log"
_TEST_TITLE_MARKERS = ("__role_stamp_test__",)


def _is_journal(init: Any) -> bool:
    plan = init.action_plan if isinstance(getattr(init, "action_plan", None), dict) else {}
    return str(plan.get("kind") or "") == _JOURNAL_KIND


def _is_test_artifact(init: Any) -> bool:
    title = str(getattr(init, "title", "") or "")
    return any(m in title for m in _TEST_TITLE_MARKERS)


def migrate_actionable_initiatives_to_tasks(
    *,
    dry_run: bool = False,
    role_agent_code: str | None = None,
    delete_test_artifacts: bool = True,
) -> dict[str, Any]:
    """One-shot / CLI migration. Returns counts."""
    from evoflow.proactive.models import InitiativeStatus
    from evoflow.proactive.repositories import ProactiveRepository
    from evoflow.proactive.work_items import (
        create_role_work_item,
        initiative_status_to_task_status,
        set_work_item_status,
    )

    # Collect existing source_refs to stay idempotent
    existing_refs: set[str] = set()
    try:
        from evoflow.collab.storage import get_project_storage

        storage = get_project_storage()
        for p in storage.list_projects():
            proj = storage.load_project(p["id"])
            if not proj:
                continue
            for t in proj.get("tasks") or []:
                ref = str(t.get("source_ref") or "").strip()
                if ref:
                    existing_refs.add(ref)
    except Exception:
        logger.warning("migrate: failed to scan existing source_refs", exc_info=True)

    inits = ProactiveRepository.list_initiatives(
        role_agent_code=role_agent_code,
        limit=5000,
    )

    migrated = 0
    skipped_journal = 0
    skipped_existing = 0
    skipped_test = 0
    deleted_test = 0
    errors: list[str] = []
    approval_relinks = 0

    for init in inits:
        if _is_journal(init):
            skipped_journal += 1
            continue
        if _is_test_artifact(init):
            skipped_test += 1
            if delete_test_artifacts and not dry_run:
                try:
                    # Soft: mark cancelled via status if column allows; else leave
                    ProactiveRepository.update_initiative_status(
                        init.id,
                        InitiativeStatus.SKIPPED
                        if hasattr(InitiativeStatus, "SKIPPED")
                        else InitiativeStatus.REJECTED,
                        execution_result="cleaned: __role_stamp_test__",
                    )
                    deleted_test += 1
                except Exception as exc:
                    errors.append(f"test cleanup {init.id}: {exc}")
            continue
        if init.id in existing_refs:
            skipped_existing += 1
            continue

        role = ProactiveRepository.get_role(init.role_agent_code)
        if not role:
            errors.append(f"no role for {init.id} / {init.role_agent_code}")
            continue

        if dry_run:
            migrated += 1
            continue

        try:
            created = create_role_work_item(
                role,
                {
                    "title": init.title,
                    "description": init.description,
                    "rationale": init.rationale,
                    "action_type": init.action_type.value
                    if hasattr(init.action_type, "value")
                    else init.action_type,
                    "risk_level": init.risk_level.value
                    if hasattr(init.risk_level, "value")
                    else init.risk_level,
                    "action_plan": init.action_plan if isinstance(init.action_plan, dict) else {},
                    "expected_outcome": init.expected_outcome,
                },
                round_id=str(init.round_id or ""),
                goal=str(init.goal or ""),
                outcome=str(init.outcome or ""),
                source="proactive_initiative",
                source_ref=init.id,
            )
            if not created:
                errors.append(f"create failed {init.id}")
                continue
            tid = str(created.get("task_id") or "")
            target_status = initiative_status_to_task_status(init.status)
            if target_status != "pending" and tid:
                # Drive through legal transitions when possible
                if target_status == "executing":
                    set_work_item_status(tid, "executing", progress=50)
                elif target_status == "reviewed":
                    set_work_item_status(tid, "executing", progress=90)
                    set_work_item_status(
                        tid,
                        "reviewed",
                        result=str(init.execution_result or "")[:8000] or None,
                        progress=100,
                    )
                elif target_status == "failed":
                    set_work_item_status(
                        tid,
                        "executing",
                        progress=10,
                    )
                    set_work_item_status(
                        tid,
                        "failed",
                        result=str(init.execution_result or "")[:8000] or None,
                    )
                elif target_status == "cancelled":
                    set_work_item_status(
                        tid,
                        "cancelled",
                        result=str(init.execution_result or "migrated cancelled")[:8000],
                    )

            # Relink approval
            appr = ProactiveRepository.get_approval_by_initiative(init.id)
            if appr and tid:
                appr.task_id = tid
                ProactiveRepository.save_approval(appr)
                approval_relinks += 1

            # Mark initiative as migrated (skipped) so UI can hide it
            try:
                from evoflow.proactive.models import InitiativeStatus as IS

                skip = IS.SKIPPED if hasattr(IS, "SKIPPED") else IS.COMPLETED
                ProactiveRepository.update_initiative_status(
                    init.id,
                    skip,
                    execution_result=f"migrated_to_task:{tid}",
                )
            except Exception:
                pass

            existing_refs.add(init.id)
            migrated += 1
        except Exception as exc:
            errors.append(f"{init.id}: {exc}")
            logger.warning("migrate initiative %s failed", init.id, exc_info=True)

    result = {
        "ok": True,
        "dry_run": dry_run,
        "migrated": migrated,
        "skipped_journal": skipped_journal,
        "skipped_existing": skipped_existing,
        "skipped_test": skipped_test,
        "deleted_test": deleted_test,
        "approval_relinks": approval_relinks,
        "errors": errors[:50],
        "error_count": len(errors),
    }
    logger.info("migrate_actionable_initiatives_to_tasks: %s", result)
    return result
