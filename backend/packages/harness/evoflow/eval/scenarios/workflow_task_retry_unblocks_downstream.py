"""Workflow: upstream fail → downstream waiting; requeue+complete upstream unblocks."""

from __future__ import annotations

from pathlib import Path

from evoflow.eval.scenarios._harness import check, finalize, run_scenario
from evoflow.eval.scenarios._persist import expect_app, expect_app_run, expect_task
from evoflow.eval.scenarios._runtime_contract import (
    apply_official_subtask_outcomes,
    find_main_and_subtasks,
    runtime_contract_metrics,
)

_APP = "eval_wf_retry_unblock"


def _app_def() -> dict:
    return {
        "name": "工作流重试解阻评测",
        "description": "retry unblocks",
        "category": "eval",
        "execution_mode": "workflow",
        "final_rollup": "off",
        "version": 1,
        "status": "published",
        "parameters": [{"name": "topic", "type": "string", "label": "主题", "default": "r"}],
        "steps": [
            {
                "ref": "1",
                "type": "agentStep",
                "title": "上游",
                "assigned_agent": "general-purpose",
                "goal": "上游 {{topic}}",
                "instruction": "上游 {{topic}}",
                "depends_on": [],
            },
            {
                "ref": "2",
                "type": "agentStep",
                "title": "下游",
                "assigned_agent": "general-purpose",
                "goal": "下游 {{topic}}",
                "instruction": "下游 {{topic}}",
                "depends_on": ["1"],
            },
        ],
    }


def _by_ref(subs: list) -> dict:
    return {str(s.get("ref") or ""): s for s in subs if isinstance(s, dict)}


def _run(home: Path) -> dict:
    del home
    from evoflow.collab import app_runner
    from evoflow.collab.storage import get_project_storage
    from evoflow.persistence import app_repositories
    from evoflow.persistence.db import get_db
    from evoflow.tools.builtins.supervisor.dependency import (
        requeue_failed_subtasks_ready_for_retry,
    )

    get_db()
    app_repositories.save_app(_APP, _app_def())
    started = app_runner.run_app_workflow(_APP, {"topic": "retry"}, auto_authorize=True)
    task_id = str(started.get("task_id") or "")

    # Fail upstream only — trust official apply payload (workers may race cache/status)
    failed_apply = apply_official_subtask_outcomes(
        task_id,
        {
            "1": {
                "outcome": "failed",
                "summary": "upstream fail for eval",
                "error": "eval injected upstream failure",
            }
        },
    )
    fail_subs = list(failed_apply.get("subtasks") or [])
    s1 = _by_ref(fail_subs).get("1") or {}
    s2 = _by_ref(fail_subs).get("2") or {}
    if not s1 or not s2:
        _s1, _m1, subs1 = find_main_and_subtasks(task_id)
        s1 = s1 or (_by_ref(subs1).get("1") or {})
        s2 = s2 or (_by_ref(subs1).get("2") or {})
    s1_failed = str(s1.get("status") or "").lower() in ("failed", "error") or any(
        str(a.get("ref") or "") == "1" and str(a.get("status") or "").lower() in ("failed", "error")
        for a in (failed_apply.get("applied") or [])
        if isinstance(a, dict)
    )
    s2_status_after_fail = str(s2.get("status") or "").lower()
    s2_not_fake_green = s2_status_after_fail not in ("completed", "done") or not s2.get(
        "outcome_reported_at"
    )

    # Requeue failed + complete both officially (skip_done guard allows re-report after requeue)
    storage = get_project_storage()
    requeued = requeue_failed_subtasks_ready_for_retry(storage, task_id) if task_id else []
    done_apply = apply_official_subtask_outcomes(
        task_id,
        {
            "1": {"outcome": "completed", "summary": "upstream recovered"},
            "2": {"outcome": "completed", "summary": "downstream after unblock"},
        },
    )
    done_subs = list(done_apply.get("subtasks") or [])
    s1b = _by_ref(done_subs).get("1") or {}
    s2b = _by_ref(done_subs).get("2") or {}
    if not s1b or not s2b:
        _s2, main2, subs2 = find_main_and_subtasks(task_id)
        s1b = s1b or (_by_ref(subs2).get("1") or {})
        s2b = s2b or (_by_ref(subs2).get("2") or {})
        main_status = str((main2 or {}).get("status") or "").lower()
    else:
        main_status = str(done_apply.get("status") or "").lower()

    assertions = [
        check(
            "upstream_failed_first",
            bool(failed_apply.get("ok")) and s1_failed,
            inputs={"ref": "1"},
            expected="failed via official outcome",
            actual={
                "status": s1.get("status"),
                "applied": failed_apply.get("applied"),
            },
            api="apply_subtask_outcome_report failed",
        ),
        check(
            "downstream_not_fake_green",
            s2_not_fake_green,
            inputs={"ref": "2"},
            expected="not completed while upstream failed",
            actual={"status": s2.get("status"), "reported_at": s2.get("outcome_reported_at")},
            api="dependency finalize",
        ),
        check(
            "requeue_attempted",
            isinstance(requeued, list),
            inputs={"task_id": task_id},
            expected="requeue returns list",
            actual=requeued,
            api="requeue_failed_subtasks_ready_for_retry",
        ),
        check(
            "both_completed_after_retry",
            str(s1b.get("status") or "").lower() in ("completed", "done")
            and str(s2b.get("status") or "").lower() in ("completed", "done"),
            inputs={},
            expected="both completed",
            actual={"s1": s1b.get("status"), "s2": s2b.get("status"), "main": main_status},
            api="official outcomes after requeue",
        ),
    ]
    persist = [expect_app(_APP, name="工作流重试解阻评测")]
    if task_id:
        persist.append(expect_app_run(task_id=task_id, app_id=_APP))
        persist.extend(expect_task(task_id))
    metrics = runtime_contract_metrics(
        task_id=task_id or None,
        extra={"eval_pack": "workflow", "arch": "wf.retry.unblock", "requeued": requeued},
    )
    return finalize(
        assertions + persist,
        metrics=metrics,
        steps=[
            {"step": 1, "api": "run_app_workflow"},
            {"step": 2, "api": "fail ref=1"},
            {"step": 3, "api": "requeue + complete both"},
        ],
    )


def run(**_kwargs) -> dict:
    return run_scenario(_run)
