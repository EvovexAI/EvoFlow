"""Workflow task: first step official fail → main not green-completed."""

from __future__ import annotations

from pathlib import Path

from evoflow.eval.scenarios._harness import check, finalize, run_scenario
from evoflow.eval.scenarios._persist import expect_app, expect_app_run, expect_task
from evoflow.eval.scenarios._runtime_contract import (
    apply_official_subtask_outcomes,
    find_main_and_subtasks,
    runtime_contract_metrics,
)

_APP = "eval_wf_step_fail"


def _app_def() -> dict:
    return {
        "name": "工作流步骤失败评测",
        "description": "step fail halts",
        "category": "eval",
        "execution_mode": "workflow",
        "version": 1,
        "status": "published",
        "parameters": [{"name": "topic", "type": "string", "label": "主题", "default": "fail"}],
        "steps": [
            {
                "ref": "1",
                "type": "agentStep",
                "title": "会失败",
                "assigned_agent": "general-purpose",
                "goal": "尝试 {{topic}}",
                "instruction": "第一步将失败",
                "depends_on": [],
            },
            {
                "ref": "2",
                "type": "agentStep",
                "title": "依赖第一步",
                "assigned_agent": "general-purpose",
                "goal": "依赖 {{topic}}",
                "instruction": "不应伪装完成",
                "depends_on": ["1"],
            },
        ],
    }


def _run(home: Path) -> dict:
    del home
    from evoflow.collab import app_runner
    from evoflow.persistence import app_repositories
    from evoflow.persistence.db import get_db

    get_db()
    app_repositories.save_app(_APP, _app_def())
    result = app_runner.run_app_workflow(_APP, {"topic": "失败主题"}, auto_authorize=True)
    task_id = str(result.get("task_id") or "").strip()
    _storage, _task, subs = find_main_and_subtasks(task_id)
    # Fail step 1 only; leave step 2 pending — main must not look fully completed.
    applied = (
        apply_official_subtask_outcomes(
            task_id,
            {
                "1": {
                    "outcome": "failed",
                    "summary": "步骤1官方失败：评测注入",
                    "error": "eval injected failure",
                }
            },
        )
        if task_id
        else {"ok": False}
    )
    _s2, final, subs2 = find_main_and_subtasks(task_id)
    by_ref = {str(s.get("ref") or ""): s for s in subs2}
    s1 = by_ref.get("1") or {}
    s2 = by_ref.get("2") or {}
    status = str(final.get("status") or "").lower()
    s2_status = str(s2.get("status") or "").lower()
    s1_ok_failed = str(s1.get("status") or "").lower() == "failed" and bool(
        s1.get("outcome_reported_at")
    )
    s2_not_fake_completed = s2_status not in ("completed", "done") or not s2.get(
        "outcome_reported_at"
    )
    main_not_green = status not in ("completed", "done", "reviewed")

    assertions = [
        check(
            "step1_official_failed",
            s1_ok_failed,
            inputs={"task_id": task_id, "ref": "1"},
            expected="failed + outcome_reported_at",
            actual={"status": s1.get("status"), "reported_at": s1.get("outcome_reported_at")},
            api="apply_subtask_outcome_report",
        ),
        check(
            "step2_not_fake_completed",
            s2_not_fake_completed,
            inputs={"ref": "2"},
            expected="not completed with report",
            actual={"status": s2.get("status"), "reported_at": s2.get("outcome_reported_at")},
            api="subtask.status",
        ),
        check(
            "main_not_completed",
            main_not_green,
            inputs={"task_id": task_id},
            expected="not completed/done/reviewed",
            actual=status,
            api="sync_main_task_from_subtasks",
        ),
        check(
            "apply_ok",
            bool(applied.get("ok")),
            inputs={},
            expected=True,
            actual=applied.get("applied"),
            api="apply_official_subtask_outcomes",
        ),
    ]
    persist = [expect_app(_APP, name="工作流步骤失败评测")]
    if task_id:
        persist.append(expect_app_run(task_id=task_id, app_id=_APP))
        persist.extend(expect_task(task_id))

    metrics = runtime_contract_metrics(
        task_id=task_id or None,
        extra={"app_id": _APP, "main_status": status, "step1": s1.get("status")},
    )
    return finalize(
        assertions + persist,
        metrics=metrics,
        steps=[
            {"step": 1, "api": "run_app_workflow", "task_id": task_id},
            {"step": 2, "api": "official fail ref=1"},
            {"step": 3, "api": "assert main not green"},
        ],
    )


def run(**_kwargs) -> dict:
    return run_scenario(_run)
