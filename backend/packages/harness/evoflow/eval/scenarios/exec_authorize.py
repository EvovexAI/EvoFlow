"""Scenario: execution authorize gate — model actor rejected; user ok."""

from __future__ import annotations

from pathlib import Path

from evoflow.eval.scenarios._harness import check, finalize, run_scenario
from evoflow.eval.scenarios._persist import check_db_row, expect_task


def _run(home: Path) -> dict:
    from evoflow.collab.authorize_execution import (
        authorize_main_task_execution,
        is_task_execution_authorized,
    )
    from evoflow.collab.storage import ProjectStorage, new_project_bundle_root_task

    storage = ProjectStorage(home / "bundles")
    project, task = new_project_bundle_root_task(
        "授权门评测",
        "description long enough for eval authorize gate scenario",
        thread_id="eval-auth",
    )
    task["status"] = "planned"
    storage.save_project(project)
    tid = str(task["id"])

    before = is_task_execution_authorized(storage, tid)
    model_ok, model_msg = authorize_main_task_execution(storage, tid, "model")
    after_model = is_task_execution_authorized(storage, tid)
    user_ok, user_msg = authorize_main_task_execution(storage, tid, "user")
    after_user = is_task_execution_authorized(storage, tid)

    assertions = [
        check(
            "unauthorized_before",
            before is False,
            inputs={"task_id": tid},
            expected=False,
            actual=before,
            api="is_task_execution_authorized",
        ),
        check(
            "model_rejected",
            model_ok is False,
            inputs={"task_id": tid, "actor": "model"},
            expected=False,
            actual={"ok": model_ok, "message": model_msg},
            api="authorize_main_task_execution",
        ),
        check(
            "still_unauthorized_after_model",
            after_model is False,
            inputs={"task_id": tid, "after_actor": "model"},
            expected=False,
            actual=after_model,
            api="is_task_execution_authorized",
        ),
        check(
            "user_authorized",
            user_ok is True,
            inputs={"task_id": tid, "actor": "user"},
            expected=True,
            actual={"ok": user_ok, "message": user_msg},
            api="authorize_main_task_execution",
        ),
        check(
            "authorized_flag",
            after_user is True,
            inputs={"task_id": tid, "after_actor": "user"},
            expected=True,
            actual=after_user,
            api="is_task_execution_authorized",
        ),
    ]
    persist = [
        *expect_task(tid),
        check_db_row(
            f"db_task_authorized_{tid}",
            "SELECT task_id, execution_authorized FROM evoflow_collab_tasks WHERE task_id=?",
            (tid,),
            {"task_id": tid, "execution_authorized": 1},
            api="db.evoflow_collab_tasks",
        ),
    ]
    return finalize(
        assertions + persist,
        metrics={"task_id": tid},
        steps=[
            {"step": 1, "api": "new_project_bundle_root_task", "result": {"task_id": tid}},
            {"step": 2, "api": "authorize_main_task_execution(model)", "result": model_msg},
            {"step": 3, "api": "authorize_main_task_execution(user)", "result": user_msg},
        ],
    )


def run(**_kwargs) -> dict:
    return run_scenario(_run)
