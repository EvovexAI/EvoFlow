"""Workflow: cancel_run cancels main + in-flight subtasks + app_run."""

from __future__ import annotations

from pathlib import Path

from evoflow.eval.scenarios._harness import check, finalize, run_scenario
from evoflow.eval.scenarios._persist import expect_app, expect_app_run, expect_task
from evoflow.eval.scenarios._runtime_contract import find_main_and_subtasks, runtime_contract_metrics

_APP = "eval_wf_cancel_run"


def _app_def() -> dict:
    return {
        "name": "工作流取消评测",
        "description": "cancel run",
        "category": "eval",
        "execution_mode": "workflow",
        "final_rollup": "off",
        "version": 1,
        "status": "published",
        "parameters": [{"name": "topic", "type": "string", "label": "主题", "default": "x"}],
        "steps": [
            {
                "ref": "1",
                "type": "agentStep",
                "title": "一步",
                "assigned_agent": "general-purpose",
                "goal": "处理 {{topic}}",
                "instruction": "处理 {{topic}}",
                "depends_on": [],
            }
        ],
    }


def _run(home: Path) -> dict:
    del home
    from evoflow.collab import app_runner
    from evoflow.persistence import app_repositories
    from evoflow.persistence.db import get_db

    get_db()
    app_repositories.save_app(_APP, _app_def())
    started = app_runner.run_app_workflow(_APP, {"topic": "cancel"}, auto_authorize=True)
    task_id = str(started.get("task_id") or "")
    run_id = str(started.get("run_id") or "")
    cancelled = app_runner.cancel_run(run_id, reason="eval cancel") if run_id else False
    run_row = app_repositories.load_run(run_id) if run_id else None
    _s, main, subs = find_main_and_subtasks(task_id)
    main_status = str((main or {}).get("status") or "").lower()
    run_status = str((run_row or {}).get("status") or "").lower()
    open_subs = [
        s
        for s in subs
        if str(s.get("status") or "").lower()
        not in ("completed", "done", "failed", "cancelled", "canceled", "skipped")
    ]

    assertions = [
        check(
            "run_started",
            bool(task_id) and bool(run_id),
            inputs={"app_id": _APP},
            expected="task_id+run_id",
            actual={"task_id": task_id, "run_id": run_id},
            api="run_app_workflow",
        ),
        check(
            "cancel_ok",
            bool(cancelled),
            inputs={"run_id": run_id},
            expected=True,
            actual=cancelled,
            api="cancel_run",
        ),
        check(
            "main_cancelled",
            main_status in ("cancelled", "canceled"),
            inputs={"task_id": task_id},
            expected="cancelled",
            actual=main_status,
            api="cancel_run→task bundle",
        ),
        check(
            "app_run_cancelled",
            run_status in ("cancelled", "canceled"),
            inputs={"run_id": run_id},
            expected="cancelled",
            actual=run_status,
            api="update_run_status",
        ),
        check(
            "no_open_subtasks",
            len(open_subs) == 0,
            inputs={"task_id": task_id},
            expected="0 open subtasks",
            actual={"open": [s.get("ref") for s in open_subs], "all": [s.get("status") for s in subs]},
            api="subtasks after cancel",
        ),
    ]
    persist = [expect_app(_APP, name="工作流取消评测")]
    if task_id:
        persist.append(expect_app_run(task_id=task_id, app_id=_APP))
        persist.extend(expect_task(task_id))
    metrics = runtime_contract_metrics(
        task_id=task_id or None,
        extra={"eval_pack": "workflow", "arch": "wf.control.cancel_pause", "run_id": run_id},
    )
    return finalize(
        assertions + persist,
        metrics=metrics,
        steps=[
            {"step": 1, "api": "run_app_workflow", "task_id": task_id, "run_id": run_id},
            {"step": 2, "api": "cancel_run"},
        ],
    )


def run(**_kwargs) -> dict:
    return run_scenario(_run)
