"""Workflow task: official subtask outcomes → sync/rollup (no raw storage stub)."""

from __future__ import annotations

from pathlib import Path

from evoflow.eval.scenarios._harness import check, finalize, run_scenario
from evoflow.eval.scenarios._persist import expect_app, expect_app_run, expect_task
from evoflow.eval.scenarios._runtime_contract import (
    apply_official_subtask_outcomes,
    find_main_and_subtasks,
    runtime_contract_metrics,
)

_APP = "eval_wf_official_rollup"
_TOKEN = "EVAL_WF_OFFICIAL_OUTCOME_TOKEN"


def _app_def() -> dict:
    return {
        "name": "官方Outcome汇总工作流",
        "description": "official outcome rollup",
        "category": "eval",
        "execution_mode": "workflow",
        "final_rollup": "auto",
        "final_rollup_agent": "general-purpose",
        "final_rollup_instruction": "汇总两步结果。",
        "version": 1,
        "status": "published",
        "parameters": [{"name": "topic", "type": "string", "label": "主题", "default": "rollup"}],
        "steps": [
            {
                "ref": "1",
                "type": "agentStep",
                "title": "收集",
                "assigned_agent": "general-purpose",
                "goal": "收集 {{topic}}",
                "instruction": "收集 {{topic}}",
                "depends_on": [],
            },
            {
                "ref": "2",
                "type": "agentStep",
                "title": "摘要",
                "assigned_agent": "general-purpose",
                "goal": "摘要 {{topic}}",
                "instruction": "摘要 {{topic}}",
                "depends_on": ["1"],
            },
        ],
    }


def _run(home: Path) -> dict:
    del home
    from evoflow.collab import app_runner
    from evoflow.collab.app_rollup import is_rollup_subtask
    from evoflow.persistence import app_repositories
    from evoflow.persistence.db import get_db

    get_db()
    app_repositories.save_app(_APP, _app_def())
    result = app_runner.run_app_workflow(_APP, {"topic": "官方汇总"}, auto_authorize=True)
    task_id = str(result.get("task_id") or "").strip()
    _storage, _task, subs = find_main_and_subtasks(task_id)

    reports: dict[str, dict] = {}
    for st in subs:
        ref = str(st.get("ref") or "")
        sid = str(st.get("id") or "")
        key = ref or sid
        if is_rollup_subtask(st):
            reports[key] = {
                "outcome": "completed",
                "summary": f"## 汇总\n{_TOKEN}\n两步均完成。",
            }
        else:
            reports[key] = {
                "outcome": "completed",
                "summary": f"步骤 {ref} 完成 {_TOKEN}",
            }

    applied = apply_official_subtask_outcomes(task_id, reports) if task_id else {"ok": False}
    _s2, final, subs2 = find_main_and_subtasks(task_id)
    status = str(final.get("status") or "")
    reported = [
        s
        for s in subs2
        if s.get("outcome_reported_at") and _TOKEN in str(s.get("task_report") or "")
    ]
    has_rollup = any(is_rollup_subtask(s) for s in subs2)

    assertions = [
        check(
            "task_created",
            bool(task_id),
            inputs={"app_id": _APP},
            expected="task_id",
            actual=task_id,
            api="run_app_workflow",
        ),
        check(
            "official_outcomes_applied",
            bool(applied.get("ok")),
            inputs={"reports_keys": list(reports.keys())},
            expected="all apply_subtask_outcome_report ok",
            actual=applied.get("applied"),
            api="apply_subtask_outcome_report",
        ),
        check(
            "reports_have_token",
            len(reported) >= 2,
            inputs={"token": _TOKEN},
            expected=">=2 reported with token",
            actual={"count": len(reported), "sample": [r.get("ref") for r in reported]},
            api="subtask.task_report",
        ),
        check(
            "main_completed",
            status in ("completed", "done", "reviewed"),
            inputs={"task_id": task_id},
            expected=["completed", "done", "reviewed"],
            actual=status,
            api="sync_main_task_from_subtasks",
        ),
        check(
            "has_rollup_subtask",
            has_rollup,
            inputs={"task_id": task_id},
            expected=True,
            actual=has_rollup,
            api="is_rollup_subtask",
        ),
        check(
            "rollup_applied",
            final.get("rollup_applied_at") is not None or status in ("completed", "done"),
            inputs={"task_id": task_id},
            expected="rollup_applied_at or completed",
            actual=final.get("rollup_applied_at"),
            api="maybe_rollup_main_task",
        ),
    ]
    persist = [expect_app(_APP, name="官方Outcome汇总工作流")]
    if task_id:
        persist.append(expect_app_run(task_id=task_id, app_id=_APP))
        persist.extend(expect_task(task_id, status=status or None))

    metrics = runtime_contract_metrics(
        task_id=task_id or None,
        extra={"app_id": _APP, "token": _TOKEN, "applied": applied.get("applied")},
    )
    return finalize(
        assertions + persist,
        metrics=metrics,
        steps=[
            {"step": 1, "api": "save_app+run_app_workflow", "task_id": task_id},
            {"step": 2, "api": "apply_subtask_outcome_report (official)"},
            {"step": 3, "api": "sync_main_task_from_subtasks", "status": status},
        ],
    )


def run(**_kwargs) -> dict:
    return run_scenario(_run)
