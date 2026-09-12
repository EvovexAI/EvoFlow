"""L2 工作流：必填参数校验失败 + 合法运行拿 run/task + 删除应用."""

from __future__ import annotations

from pathlib import Path

from evoflow.eval.scenarios._harness import check, finalize, run_scenario
from evoflow.eval.scenarios._persist import check_db_absent, expect_app_run, expect_task


def _app_def() -> dict:
    return {
        "name": "模块L2工作流",
        "description": "required param gate",
        "category": "eval",
        "execution_mode": "workflow",
        "version": 1,
        "status": "published",
        "parameters": [
            {"name": "topic", "type": "string", "label": "主题", "required": True},
        ],
        "steps": [
            {
                "ref": "1",
                "type": "agentStep",
                "title": "一步",
                "agent_code": "general-purpose",
                "goal": "处理 {topic}",
                "instruction": "处理 {topic}",
                "depends_on": [],
            }
        ],
    }


def _run(home: Path) -> dict:
    del home
    from evoflow.admin import apps as apps_admin
    from evoflow.admin.errors import ValidationError
    from evoflow.persistence import app_repositories

    app_id = "eval_module_workflow_l2"
    app_repositories.save_app(app_id, _app_def())

    missing_raised = False
    missing_err = ""
    try:
        apps_admin.run_app(app_id, parameters={})
    except ValidationError as exc:
        missing_raised = True
        missing_err = str(exc)
    except Exception as exc:  # noqa: BLE001
        missing_raised = "missing" in str(exc).lower() or "parameter" in str(exc).lower()
        missing_err = str(exc)

    ok_run = apps_admin.run_app(app_id, parameters={"topic": "L2主题"})
    run_obj = ok_run.get("run") if isinstance(ok_run, dict) else {}
    task_id = str((run_obj or {}).get("task_id") or (run_obj or {}).get("main_task_id") or "").strip()
    run_id = str((run_obj or {}).get("run_id") or (run_obj or {}).get("id") or "").strip()

    run_status = None
    if run_id:
        try:
            run_status = apps_admin.get_run(run_id)
        except Exception as exc:  # noqa: BLE001
            run_status = {"error": str(exc)}

    # Reconcile run/task while the app still exists (delete may cascade runs).
    persist_before = []
    if run_id:
        persist_before.append(expect_app_run(run_id, task_id=task_id or None, app_id=app_id))
    if task_id:
        persist_before.extend(expect_task(task_id))

    deleted = app_repositories.delete_app(app_id)
    gone = app_repositories.load_app(app_id) is None

    assertions = [
        check(
            "missing_param_rejected",
            missing_raised,
            inputs={"app_id": app_id, "parameters": {}},
            expected="ValidationError / missing topic",
            actual=missing_err or "no error",
            api="apps_admin.run_app",
        ),
        check(
            "run_with_param",
            bool(task_id or run_id),
            inputs={"app_id": app_id, "parameters": {"topic": "L2主题"}},
            expected="task_id or run_id",
            actual={"task_id": task_id, "run_id": run_id},
            api="apps_admin.run_app",
        ),
        check(
            "get_run_or_task_ref",
            bool(run_status) or bool(task_id),
            inputs={"run_id": run_id},
            expected="get_run payload or task_id",
            actual=run_status if run_status is not None else {"task_id": task_id},
            api="apps_admin.get_run",
        ),
        check(
            "app_deleted",
            bool(deleted) and gone,
            inputs={"app_id": app_id},
            expected={"deleted": True, "gone": True},
            actual={"deleted": deleted, "gone": gone},
            api="app_repositories.delete_app",
        ),
    ]
    persist = persist_before + [
        check_db_absent(
            f"db_no_app_{app_id}",
            "SELECT id FROM evoflow_apps WHERE id=?",
            (app_id,),
        ),
    ]
    return finalize(
        assertions + persist,
        metrics={"app_id": app_id, "task_id": task_id, "run_id": run_id},
        steps=[
            {"step": 1, "api": "save_app"},
            {"step": 2, "api": "run_app({}) → reject", "result": missing_err},
            {"step": 3, "api": "run_app(topic=...)", "result": {"task_id": task_id, "run_id": run_id}},
            {"step": 4, "api": "delete_app", "result": {"gone": gone}},
        ],
    )


def run(**_kwargs) -> dict:
    return run_scenario(_run)
