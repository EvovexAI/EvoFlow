"""Workflow task: parameter render into goal/instruction (no leftover {{topic}})."""

from __future__ import annotations

from pathlib import Path

from evoflow.eval.scenarios._harness import check, finalize, run_scenario
from evoflow.eval.scenarios._persist import expect_app, expect_task
from evoflow.eval.scenarios._runtime_contract import find_main_and_subtasks, runtime_contract_metrics

_APP = "eval_wf_param_render"
_TOPIC = "评测渲染主题Alpha"


def _app_def() -> dict:
    return {
        "name": "工作流参数渲染评测",
        "description": "param render",
        "category": "eval",
        "execution_mode": "workflow",
        "version": 1,
        "status": "published",
        "parameters": [{"name": "topic", "type": "string", "label": "主题", "required": True}],
        "steps": [
            {
                "ref": "1",
                "type": "agentStep",
                "name": "渲染步骤",
                "assigned_agent": "general-purpose",
                "goal": "处理主题 {{topic}}",
                "instruction": "请围绕 {{topic}} 产出摘要",
                "depends_on": [],
            }
        ],
    }


def _run(home: Path) -> dict:
    del home
    from evoflow.collab import app_runner
    from evoflow.persistence import app_repositories

    app_repositories.save_app(_APP, _app_def())
    result = app_runner.run_app_workflow(_APP, {"topic": _TOPIC}, auto_authorize=True)
    task_id = str(result.get("task_id") or "").strip()
    _storage, _task, subs = find_main_and_subtasks(task_id)
    st = next((s for s in subs if str(s.get("ref") or "") == "1"), subs[0] if subs else {})
    wp = st.get("worker_profile") if isinstance(st.get("worker_profile"), dict) else {}
    goal = str(st.get("goal") or "")
    instr = str(wp.get("instruction") or st.get("instruction") or "")
    blob = f"{goal}\n{instr}"

    assertions = [
        check(
            "topic_rendered_in_goal_or_instruction",
            _TOPIC in blob,
            inputs={"topic": _TOPIC},
            expected=f"contains {_TOPIC}",
            actual={"goal": goal, "instruction": instr[:240]},
            api="run_app_workflow render_plan",
        ),
        check(
            "no_literal_placeholder",
            "{{topic}}" not in blob and "{topic}" not in blob,
            inputs={"blob_preview": blob[:200]},
            expected="no {{topic}} leftover",
            actual={
                "has_double_brace": "{{topic}}" in blob,
                "has_single_brace": "{topic}" in blob,
                "blob": blob[:200],
            },
            api="run_app_workflow render_plan",
        ),
    ]
    persist = [expect_app(_APP, name="工作流参数渲染评测")]
    if task_id:
        persist.extend(expect_task(task_id))

    metrics = runtime_contract_metrics(
        task_id=task_id or None,
        extra={"topic": _TOPIC, "goal": goal, "instruction": instr[:240]},
    )
    return finalize(
        assertions + persist,
        metrics=metrics,
        steps=[
            {"step": 1, "api": "save_app"},
            {"step": 2, "api": "run_app_workflow", "params": {"topic": _TOPIC}},
            {"step": 3, "api": "assert rendered goal/instruction"},
        ],
    )


def run(**_kwargs) -> dict:
    return run_scenario(_run)
