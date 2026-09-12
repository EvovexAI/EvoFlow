"""Scenario: app workflow official outcomes → rollup applied + main completed.

Uses ``apply_subtask_outcome_report`` (not raw project JSON mutation).
"""

from __future__ import annotations

from pathlib import Path

from evoflow.eval.scenarios._harness import check, finalize, run_scenario
from evoflow.eval.scenarios._persist import expect_app, expect_app_run, expect_task
from evoflow.eval.scenarios._runtime_contract import (
    apply_official_subtask_outcomes,
    find_main_and_subtasks,
    runtime_contract_metrics,
)


def _mini_app() -> dict:
    return {
        "name": "评测迷你工作流",
        "description": "两步 + auto rollup",
        "icon": "🧪",
        "category": "eval",
        "execution_mode": "workflow",
        "final_rollup": "auto",
        "final_rollup_agent": "general-purpose",
        "final_rollup_instruction": "汇总两步结果，输出最终报告。",
        "version": 1,
        "status": "published",
        "parameters": [
            {"name": "topic", "type": "string", "label": "主题", "default": "评测"},
        ],
        "steps": [
            {
                "ref": "1",
                "type": "agentStep",
                "title": "收集资料",
                "assigned_agent": "general-purpose",
                "goal": "收集 {{topic}}",
                "instruction": "收集关于 {{topic}} 的资料",
                "depends_on": [],
            },
            {
                "ref": "2",
                "type": "agentStep",
                "title": "撰写摘要",
                "assigned_agent": "general-purpose",
                "goal": "摘要 {{topic}}",
                "instruction": "基于步骤1撰写摘要",
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
    app_def = _mini_app()
    params = {"topic": "评测主题"}
    app_repositories.save_app("eval_mini_rollup", app_def)
    result = app_runner.run_app_workflow(
        "eval_mini_rollup",
        params,
        auto_authorize=True,
    )
    task_id = str(result.get("task_id") or "").strip()
    assertions = [
        check(
            "task_created",
            bool(task_id),
            inputs={"app_id": "eval_mini_rollup", "params": params, "auto_authorize": True},
            expected="非空 task_id",
            actual={"task_id": task_id},
            api="app_runner.run_app_workflow",
        )
    ]
    persist = [expect_app("eval_mini_rollup", name="评测迷你工作流")]
    if not task_id:
        return finalize(assertions + persist)

    _storage, _task, subs = find_main_and_subtasks(task_id)
    reports: dict[str, dict] = {}
    for st in subs:
        ref = str(st.get("ref") or "")
        sid = str(st.get("id") or "")
        key = ref or sid
        if is_rollup_subtask(st):
            reports[key] = {
                "outcome": "completed",
                "summary": "## 评测汇总报告\n两步均已完成，质量合格。",
            }
        else:
            reports[key] = {
                "outcome": "completed",
                "summary": f"步骤 {ref} 完成：内容就绪。",
            }

    applied = apply_official_subtask_outcomes(task_id, reports)
    _s2, ft, subs2 = find_main_and_subtasks(task_id)
    status = str(ft.get("status") or "")
    rollup_at = ft.get("rollup_applied_at")
    has_rollup = any(is_rollup_subtask(s) for s in subs2)

    assertions.extend(
        [
            check(
                "official_outcomes_ok",
                bool(applied.get("ok")),
                inputs={"keys": list(reports.keys())},
                expected=True,
                actual=applied.get("applied"),
                api="apply_subtask_outcome_report",
            ),
            check(
                "has_rollup_subtask",
                has_rollup,
                inputs={"task_id": task_id, "subtask_count": len(subs2)},
                expected=True,
                actual=has_rollup,
                api="is_rollup_subtask",
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
                "rollup_applied",
                rollup_at is not None or status in ("completed", "done"),
                inputs={"task_id": task_id},
                expected="非空 rollup_applied_at 或 completed",
                actual=rollup_at,
                api="sync_main_task_from_subtasks",
            ),
        ]
    )
    persist.append(expect_app_run(task_id=task_id, app_id="eval_mini_rollup"))
    persist.extend(expect_task(task_id, status=status if status else None))
    metrics = runtime_contract_metrics(
        task_id=task_id,
        extra={"status": status, "rollup_applied_at": rollup_at},
    )
    return finalize(
        assertions + persist,
        metrics=metrics,
        steps=[
            {"step": 1, "api": "app_repositories.save_app", "inputs": {"app_id": "eval_mini_rollup"}},
            {"step": 2, "api": "app_runner.run_app_workflow", "result": {"task_id": task_id}},
            {"step": 3, "api": "apply_subtask_outcome_report + sync"},
            {"step": 4, "api": "find_main_task", "result": {"status": status, "rollup_applied_at": rollup_at}},
        ],
    )


def run(**_kwargs) -> dict:
    return run_scenario(_run)
