"""Module scenario: 工作流 — save/list/get/run (create task, no LLM wait)."""

from __future__ import annotations

from pathlib import Path

from evoflow.eval.scenarios._harness import check, finalize, run_scenario
from evoflow.eval.scenarios._persist import expect_app, expect_app_run, expect_task


def _app_def() -> dict:
    return {
        "name": "模块评测工作流",
        "description": "module workflow CRUD + run create",
        "icon": "🧪",
        "category": "eval",
        "execution_mode": "workflow",
        "version": 1,
        "status": "published",
        "parameters": [
            {"name": "topic", "type": "string", "label": "主题", "default": "评测"},
        ],
        "steps": [
            {
                "ref": "1",
                "type": "agentStep",
                "title": "收集",
                "agent_code": "general-purpose",
                "goal": "收集 {topic}",
                "instruction": "收集关于 {topic}",
                "depends_on": [],
            }
        ],
    }


def _run(home: Path) -> dict:
    del home
    from evoflow.admin import apps as apps_admin
    from evoflow.collab.workflow_validator import validate_app_definition
    from evoflow.persistence import app_repositories

    app_id = "eval_module_workflow"
    app_def = _app_def()
    validated = validate_app_definition(app_def)
    valid_ok = bool(
        validated.get("ok")
        if "ok" in validated
        else validated.get("valid")
        if "valid" in validated
        else not (validated.get("errors") or [])
    )

    app_repositories.save_app(app_id, app_def)
    listed = apps_admin.list_apps(search="模块评测", limit=20)
    ids = [str(i.get("id") or "") for i in (listed.get("items") or [])]
    got = apps_admin.get_app(app_id)
    steps_count = int((got.get("app") or {}).get("steps_count") or 0)

    run_result = apps_admin.run_app(app_id, parameters={"topic": "模块评测主题"})
    run_obj = run_result.get("run") if isinstance(run_result, dict) else {}
    task_id = str(
        (run_obj or {}).get("task_id")
        or (run_obj or {}).get("main_task_id")
        or run_result.get("task_id")
        or ""
    ).strip()
    run_id = str((run_obj or {}).get("run_id") or (run_obj or {}).get("id") or "").strip()

    assertions = [
        check(
            "definition_valid",
            valid_ok,
            inputs={"app_id": app_id, "name": app_def["name"]},
            expected={"valid": True},
            actual=validated,
            api="validate_app_definition",
        ),
        check(
            "saved_and_listed",
            app_id in ids,
            inputs={"search": "模块评测"},
            expected=app_id,
            actual=ids,
            api="apps_admin.list_apps",
        ),
        check(
            "get_app",
            (got.get("app") or {}).get("id") == app_id or steps_count >= 1,
            inputs={"app_id": app_id},
            expected={"id": app_id, "steps_count": ">=1"},
            actual=got.get("app"),
            api="apps_admin.get_app",
        ),
        check(
            "run_creates_task",
            bool(task_id or run_id),
            inputs={"app_id": app_id, "parameters": {"topic": "模块评测主题"}},
            expected="task_id or run_id",
            actual={"task_id": task_id, "run_id": run_id, "run_keys": list((run_obj or {}).keys())[:12]},
            api="apps_admin.run_app",
        ),
    ]
    persist = [expect_app(app_id, name="模块评测工作流")]
    if run_id:
        persist.append(expect_app_run(run_id, task_id=task_id or None, app_id=app_id))
    elif task_id:
        persist.append(expect_app_run(task_id=task_id, app_id=app_id))
    if task_id:
        persist.extend(expect_task(task_id))
    return finalize(
        assertions + persist,
        metrics={"app_id": app_id, "task_id": task_id, "run_id": run_id},
        steps=[
            {"step": 1, "api": "validate_app_definition", "result": validated},
            {"step": 2, "api": "app_repositories.save_app", "inputs": {"app_id": app_id}},
            {"step": 3, "api": "apps_admin.list_apps/get_app", "result": got.get("app")},
            {"step": 4, "api": "apps_admin.run_app", "result": {"task_id": task_id, "run_id": run_id}},
        ],
    )


def run(**_kwargs) -> dict:
    return run_scenario(_run)
