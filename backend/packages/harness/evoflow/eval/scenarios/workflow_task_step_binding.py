"""Workflow task: step worker_profile bindings after run_app_workflow."""

from __future__ import annotations

from pathlib import Path

from evoflow.eval.scenarios._harness import check, finalize, run_scenario
from evoflow.eval.scenarios._persist import check_db_row, expect_app, expect_app_run, expect_task
from evoflow.eval.scenarios._runtime_contract import (
    ensure_agent,
    expect_worker_profile,
    find_main_and_subtasks,
    runtime_contract_metrics,
)

_APP = "eval_wf_step_bind"
_A1 = "eval-wf-step-a"
_A2 = "eval-wf-step-b"


def _app_def() -> dict:
    return {
        "name": "工作流步骤绑定评测",
        "description": "two agents / tools / instructions",
        "category": "eval",
        "execution_mode": "workflow",
        "version": 1,
        "status": "published",
        "parameters": [{"name": "topic", "type": "string", "label": "主题", "default": "绑定"}],
        "steps": [
            {
                "ref": "1",
                "type": "agentStep",
                "name": "收集",
                "assigned_agent": _A1,
                "agent_code": _A1,
                "goal": "收集 {{topic}}",
                "instruction": "STEP1_INSTR 收集关于 {{topic}}",
                "tools": ["read"],
                "depends_on": [],
            },
            {
                "ref": "2",
                "type": "agentStep",
                "name": "撰写",
                "assigned_agent": _A2,
                "agent_code": _A2,
                "goal": "撰写 {{topic}}",
                "instruction": "STEP2_INSTR 基于步骤1撰写 {{topic}}",
                "tools": ["read", "web_search"],
                "depends_on": ["1"],
            },
        ],
    }


def _run(home: Path) -> dict:
    del home
    from evoflow.collab import app_runner
    from evoflow.persistence import app_repositories

    for code, name, tools in (
        (_A1, "工作流步骤A", ["read"]),
        (_A2, "工作流步骤B", ["read", "web_search"]),
    ):
        ensure_agent(
            agent_code=code,
            agent_name=name,
            description="wf step binding",
            soul=f"Worker {code}",
            system_prompt=f"You are {code}",
            tools=tools,
        )

    app_repositories.save_app(_APP, _app_def())
    result = app_runner.run_app_workflow(_APP, {"topic": "绑定主题"}, auto_authorize=True)
    task_id = str(result.get("task_id") or "").strip()
    run_id = str(result.get("run_id") or (result.get("run") or {}).get("id") or "").strip()
    _storage, task, subs = find_main_and_subtasks(task_id)
    by_ref = {str(s.get("ref") or ""): s for s in subs}
    s1, s2 = by_ref.get("1") or {}, by_ref.get("2") or {}
    authorized = bool(task.get("execution_authorized")) or int(
        # DB may store 1; project may store true
        1 if task.get("execution_authorized") in (True, 1, "1") else 0
    )

    assertions = [
        check(
            "workflow_started",
            bool(task_id) and bool(subs),
            inputs={"app_id": _APP},
            expected="task + subtasks",
            actual={"task_id": task_id, "subtask_count": len(subs), "run_id": run_id},
            api="app_runner.run_app_workflow",
        ),
        check(
            "execution_authorized",
            bool(authorized) or bool(task.get("execution_authorized")),
            inputs={"task_id": task_id},
            expected=True,
            actual=task.get("execution_authorized"),
            api="run_app_workflow auto_authorize",
        ),
        expect_worker_profile(
            s1,
            agent_code=_A1,
            tools=["read"],
            instruction_substr="STEP1_INSTR",
        ),
        expect_worker_profile(
            s2,
            agent_code=_A2,
            tools=["read", "web_search"],
            instruction_substr="STEP2_INSTR",
        ),
    ]
    persist = [expect_app(_APP, name="工作流步骤绑定评测")]
    if task_id:
        persist.extend(expect_task(task_id))
        persist.append(
            check_db_row(
                f"db_task_auth_{task_id}",
                "SELECT task_id, execution_authorized FROM evoflow_collab_tasks WHERE task_id=?",
                (task_id,),
                {"task_id": task_id, "execution_authorized": 1},
                api="db.evoflow_collab_tasks",
            )
        )
    if run_id:
        persist.append(expect_app_run(run_id, task_id=task_id or None, app_id=_APP))
    elif task_id:
        persist.append(expect_app_run(task_id=task_id, app_id=_APP))

    metrics = runtime_contract_metrics(
        agent_codes=[_A1, _A2],
        task_id=task_id or None,
        extra={"app_id": _APP, "run_id": run_id},
    )
    return finalize(
        assertions + persist,
        metrics=metrics,
        steps=[
            {"step": 1, "api": "create_agent x2"},
            {"step": 2, "api": "save_app+run_app_workflow", "task_id": task_id},
            {"step": 3, "api": "assert worker_profile bindings"},
        ],
    )


def run(**_kwargs) -> dict:
    return run_scenario(_run)
