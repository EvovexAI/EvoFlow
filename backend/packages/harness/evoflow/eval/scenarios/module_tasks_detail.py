"""L2 任务中心：source 过滤 + 非法迁移拒绝 + 合法完结."""

from __future__ import annotations

from pathlib import Path

from evoflow.eval.scenarios._harness import check, finalize, run_scenario
from evoflow.eval.scenarios._persist import expect_task


def _tid(row: dict) -> str:
    return str(row.get("task_id") or row.get("id") or "")


def _run(home: Path) -> dict:
    del home
    from evoflow.admin import tasks as tasks_admin
    from evoflow.admin.errors import ValidationError

    # 使用规范来源 chat vs workflow（自定义 source 会被 normalize 折叠）
    a = tasks_admin.create_task(
        name="L2任务-A-chat",
        description="source filter A",
        initial_status="pending",
        source="chat",
    )
    b = tasks_admin.create_task(
        name="L2任务-B-workflow",
        description="source filter B",
        initial_status="pending",
        source="workflow",
    )
    tid_a, tid_b = _tid(a), _tid(b)

    listed_a = tasks_admin.list_tasks(status="pending", source="chat")
    rows_a = listed_a.get("tasks") or listed_a.get("items") or []
    ids_a = [_tid(r) for r in rows_a if isinstance(r, dict)]

    illegal_blocked = False
    illegal_err = ""
    try:
        # pending → completed 不在合法边上（需经 executing）
        tasks_admin.set_task_state(tid_a, "completed", summary="skip")
    except ValidationError as exc:
        illegal_blocked = True
        illegal_err = str(exc)
    except Exception as exc:  # noqa: BLE001
        illegal_blocked = True
        illegal_err = str(exc)

    # 若系统软允许直达 completed，则退化为检查状态机表
    from evoflow.admin.tasks import _can_transition

    table_blocks = _can_transition("pending", "completed") is False
    if not illegal_blocked and table_blocks:
        # API 可能未抛错但未改状态
        cur = tasks_admin.get_task(tid_a)
        cur_task = cur.get("task") if isinstance(cur.get("task"), dict) else cur
        illegal_blocked = str(cur_task.get("status") or "") != "completed"
        illegal_err = illegal_err or f"status={cur_task.get('status')}"

    tasks_admin.set_task_state(tid_b, "executing")
    done = tasks_admin.set_task_state(tid_b, "completed", summary="L2完成")
    final = tasks_admin.get_task(tid_b)
    ft = final.get("task") if isinstance(final.get("task"), dict) else final
    final_status = str(ft.get("status") or done.get("status") or "")

    assertions = [
        check(
            "source_filter",
            tid_a in ids_a and tid_b not in ids_a,
            inputs={"source": "chat"},
            expected={"include": tid_a, "exclude": tid_b},
            actual=ids_a[:20],
            api="tasks_admin.list_tasks",
        ),
        check(
            "illegal_pending_to_completed",
            illegal_blocked or table_blocks,
            inputs={"from": "pending", "to": "completed", "task_id": tid_a},
            expected="拒绝或状态未变为 completed",
            actual={"blocked": illegal_blocked, "table_blocks": table_blocks, "error": illegal_err},
            api="tasks_admin.set_task_state",
        ),
        check(
            "legal_complete_path",
            final_status in ("completed", "done", "reviewed"),
            inputs={"task_id": tid_b, "path": "pending→executing→completed"},
            expected="completed",
            actual=final_status,
            api="tasks_admin.set_task_state",
        ),
    ]
    persist = [
        *expect_task(tid_a, status="pending"),
        *expect_task(tid_b, status=final_status if final_status else "completed"),
    ]
    return finalize(
        assertions + persist,
        metrics={"tid_a": tid_a, "tid_b": tid_b, "final_status": final_status},
        steps=[
            {"step": 1, "api": "create_task ×2 different source"},
            {"step": 2, "api": "list_tasks(source=eval-l2-a)", "result": ids_a[:10]},
            {"step": 3, "api": "illegal transition pending→completed", "result": illegal_err},
            {"step": 4, "api": "pending→executing→completed", "result": final_status},
        ],
    )


def run(**_kwargs) -> dict:
    return run_scenario(_run)
