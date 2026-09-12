"""Tests for child→parent upstream receipt wakes."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from evoflow.collab.upstream_receipt import (
    build_receipt_goal,
    notify_upstream_on_child_terminal,
    resolve_upstream_targets,
    sibling_rollup,
)


def test_resolve_upstream_targets_manager_then_raised_by_when_all_done():
    child = {"assigned_to": "code-agent", "raised_by": "project-architect"}
    parent = {
        "assigned_to": "project-architect",
        "raised_by": "product-manager",
    }
    assert resolve_upstream_targets(child, parent, all_siblings_done=False) == [
        "project-architect"
    ]
    assert resolve_upstream_targets(child, parent, all_siblings_done=True) == [
        "project-architect",
        "product-manager",
    ]


def test_build_receipt_goal_mentions_rollup():
    goal = build_receipt_goal(
        child={
            "id": "2607250900_aaaa",
            "name": "前端核对",
            "assigned_to": "code-agent",
            "summary": "三处文案已是目标，无需改",
        },
        parent={"id": "2607250851_0e79"},
        child_status="completed",
        rollup={
            "total": 3,
            "done": 2,
            "open": 1,
            "all_done": False,
            "open_rows": [
                {"task_id": "2607250854_b220", "assigned_to": "project-debugger"}
            ],
        },
    )
    assert "下游回执" in goal
    assert "验收" in goal or "completed" in goal
    assert "禁止新建" in goal
    assert "2607250900_aaaa" in goal
    assert "2/3" in goal
    assert "project-debugger" in goal


def test_notify_upstream_wakes_manager(monkeypatch):
    child = {
        "id": "Task_child",
        "name": "前端",
        "status": "completed",
        "assigned_to": "code-agent",
        "raised_by": "project-architect",
        "parent_task_id": "Task_parent",
        "summary": "done",
    }
    parent = {
        "id": "Task_parent",
        "assigned_to": "project-architect",
        "raised_by": "product-manager",
        "downstream_receipts": [],
    }
    storage = MagicMock()
    wakes: list[tuple] = []

    def _wake(target, goal="", **kwargs):
        wakes.append((target, goal, kwargs))
        return {"ok": True, "woken": True, "agent_code": target}

    with (
        patch("evoflow.collab.storage.get_project_storage", return_value=storage),
        patch("evoflow.collab.storage.find_main_task", return_value=({}, parent)),
        patch(
            "evoflow.collab.storage.patch_collab_main_task_in_project_storage",
            return_value=True,
        ),
        patch(
            "evoflow.collab.upstream_receipt.list_child_task_rows",
            return_value=[
                child,
                {
                    "id": "Task_be",
                    "status": "executing",
                    "assigned_to": "project-implementer",
                    "parent_task_id": "Task_parent",
                },
            ],
        ),
        patch("evoflow.admin.employees.wake", side_effect=_wake),
        patch(
            "evoflow.collab.upstream_receipt.maybe_push_tree_receipt_feishu",
            return_value={"ok": True, "skipped": True, "reason": "tree_not_complete"},
        ),
    ):
        out = notify_upstream_on_child_terminal(child, terminal_status="completed")

    assert out and out.get("ok")
    assert [w[0] for w in wakes] == ["project-architect"]
    assert "下游回执" in wakes[0][1]
    assert wakes[0][2].get("skip_done_guard") is True
    assert wakes[0][2].get("task_id") == "Task_parent"


def test_notify_upstream_does_not_create_wrapper_without_parent_id():
    """Receipt wake must bind related_task_id=parent so dispatch reuses the board row."""
    child = {
        "id": "Task_child",
        "name": "前端",
        "status": "completed",
        "assigned_to": "code-agent",
        "raised_by": "project-architect",
        "parent_task_id": "Task_parent",
        "summary": "done",
    }
    parent = {
        "id": "Task_parent",
        "assigned_to": "project-architect",
        "raised_by": "product-manager",
        "downstream_receipts": [],
        "status": "awaiting_close",
    }
    wakes: list[dict] = []

    def _wake(target, goal="", **kwargs):
        wakes.append({"target": target, "goal": goal, **kwargs})
        return {"ok": True, "woken": True, "related_task_id": kwargs.get("task_id")}

    with (
        patch("evoflow.collab.storage.get_project_storage", return_value=MagicMock()),
        patch("evoflow.collab.storage.find_main_task", return_value=({}, parent)),
        patch(
            "evoflow.collab.storage.patch_collab_main_task_in_project_storage",
            return_value=True,
        ),
        patch(
            "evoflow.collab.upstream_receipt.list_child_task_rows",
            return_value=[{**child, "status": "completed"}],
        ),
        patch("evoflow.admin.employees.wake", side_effect=_wake),
        patch(
            "evoflow.collab.upstream_receipt.maybe_push_tree_receipt_feishu",
            return_value={"ok": True, "skipped": True, "reason": "tree_not_complete"},
        ),
    ):
        out = notify_upstream_on_child_terminal(child, terminal_status="completed")

    assert out and out.get("ok")
    assert len(wakes) >= 1
    assert all(w.get("task_id") == "Task_parent" for w in wakes)
    assert all(w.get("skip_done_guard") is True for w in wakes)
    # Goal still uses the fixed receipt lead-in, but board title comes from parent reuse.
    assert wakes[0]["goal"].startswith("【下游回执】")

    child = {
        "id": "Task_child",
        "name": "测试",
        "assigned_to": "project-debugger",
        "raised_by": "project-architect",
        "parent_task_id": "Task_parent",
        "summary": "全绿",
    }
    parent = {
        "id": "Task_parent",
        "assigned_to": "project-architect",
        "raised_by": "product-manager",
    }
    wakes: list[str] = []

    with (
        patch("evoflow.collab.storage.get_project_storage", return_value=MagicMock()),
        patch("evoflow.collab.storage.find_main_task", return_value=({}, parent)),
        patch(
            "evoflow.collab.storage.patch_collab_main_task_in_project_storage",
            return_value=True,
        ),
        patch(
            "evoflow.collab.upstream_receipt.list_child_task_rows",
            return_value=[
                {**child, "status": "completed"},
                {
                    "id": "Task_fe",
                    "status": "completed",
                    "assigned_to": "code-agent",
                    "parent_task_id": "Task_parent",
                },
            ],
        ),
        patch(
            "evoflow.admin.employees.wake",
            side_effect=lambda target, **kw: wakes.append(target) or {"ok": True},
        ),
        patch(
            "evoflow.collab.upstream_receipt.maybe_push_tree_receipt_feishu",
            return_value={"ok": True, "root_task_id": "Task_parent", "message_id": "x"},
        ) as mock_feishu,
    ):
        out = notify_upstream_on_child_terminal(child, terminal_status="completed")

    assert out and out.get("all_siblings_done") is True
    assert wakes == ["project-architect", "product-manager"]
    mock_feishu.assert_called_once()


def test_set_task_state_triggers_upstream_receipt():
    from evoflow.admin.tasks import set_task_state

    child = {
        "id": "Task_child",
        "name": "前端",
        "status": "executing",
        "assigned_to": "code-agent",
        "parent_task_id": "Task_parent",
        "progress": 80,
    }
    storage = MagicMock()
    with (
        patch("evoflow.admin.tasks.get_project_storage", return_value=storage),
        patch("evoflow.admin.tasks.find_main_task", return_value=({}, child)),
        patch("evoflow.admin.tasks.patch_collab_main_task_in_project_storage", return_value=True),
        patch("evoflow.admin.tasks.task_handlers_of", return_value=[]),
        patch(
            "evoflow.collab.upstream_receipt.notify_upstream_on_child_terminal",
            return_value={"ok": True, "targets": ["project-architect"]},
        ) as mock_notify,
    ):
        out = set_task_state("Task_child", "completed", summary="前端完成")

    assert out["status"] == "completed"
    mock_notify.assert_called_once()
    assert out.get("upstream_receipt", {}).get("ok") is True


def test_sibling_rollup_counts():
    with patch(
        "evoflow.collab.upstream_receipt.list_child_task_rows",
        return_value=[
            {"id": "a", "status": "completed", "assigned_to": "x"},
            {"id": "b", "status": "failed", "assigned_to": "y"},
            {"id": "c", "status": "executing", "assigned_to": "z"},
        ],
    ):
        r = sibling_rollup("Task_parent")
    assert r["total"] == 3
    assert r["done"] == 2
    assert r["open"] == 1
    assert r["all_done"] is False


def test_sibling_rollup_counts_awaiting_close_as_terminal():
    with patch(
        "evoflow.collab.upstream_receipt.list_child_task_rows",
        return_value=[
            {"id": "a", "status": "awaiting_close", "assigned_to": "x"},
            {"id": "b", "status": "completed", "assigned_to": "y"},
        ],
    ):
        r = sibling_rollup("Task_parent")
    assert r["total"] == 2
    assert r["done"] == 2
    assert r["open"] == 0
    assert r["all_done"] is True


def test_maybe_push_tree_receipt_when_descendants_all_done():
    from evoflow.collab.upstream_receipt import maybe_push_tree_receipt_feishu

    child = {
        "id": "Task_leaf",
        "assigned_to": "project-debugger",
        "parent_task_id": "Task_arch",
        "status": "completed",
    }
    parent = {
        "id": "Task_arch",
        "assigned_to": "project-architect",
        "parent_task_id": "Task_root",
        "raised_by": "product-manager",
    }
    root = {
        "id": "Task_root",
        "name": "第九轮",
        "assigned_to": "product-manager",
        "raised_by": "xiaomi",
        "summary": "方案已出",
    }

    with (
        patch(
            "evoflow.collab.upstream_receipt.find_root_task_row",
            return_value=root,
        ),
        patch(
            "evoflow.collab.upstream_receipt.tree_descendants_all_terminal",
            return_value={
                "total": 2,
                "done": 2,
                "open": 0,
                "all_done": True,
                "open_rows": [],
                "rows": [
                    {"id": "Task_arch", "status": "completed", "assigned_to": "project-architect"},
                    {"id": "Task_leaf", "status": "completed", "assigned_to": "project-debugger", "summary": "全绿"},
                ],
            },
        ),
        patch(
            "evoflow.collab.upstream_receipt._run_async",
            return_value="tree_receipt:Task_root",
        ) as mock_run,
        patch(
            "evoflow.collab.storage.patch_collab_main_task_in_project_storage",
            return_value=True,
        ),
        patch("evoflow.collab.storage.get_project_storage", return_value=MagicMock()),
    ):
        out = maybe_push_tree_receipt_feishu(
            child=child, parent=parent, all_siblings_done=True
        )

    assert out and out.get("ok") is True
    assert out.get("root_task_id") == "Task_root"
    mock_run.assert_called_once()


def test_maybe_push_tree_receipt_skips_when_open_descendants():
    from evoflow.collab.upstream_receipt import maybe_push_tree_receipt_feishu

    with (
        patch(
            "evoflow.collab.upstream_receipt.find_root_task_row",
            return_value={"id": "Task_root"},
        ),
        patch(
            "evoflow.collab.upstream_receipt.tree_descendants_all_terminal",
            return_value={
                "total": 2,
                "done": 1,
                "open": 1,
                "all_done": False,
                "open_rows": [{"task_id": "Task_open", "status": "executing"}],
                "rows": [],
            },
        ),
        patch("evoflow.collab.upstream_receipt._run_async") as mock_run,
    ):
        out = maybe_push_tree_receipt_feishu(
            child={"id": "c", "parent_task_id": "p"},
            parent={"id": "p"},
            all_siblings_done=True,
        )
    assert out and out.get("skipped") is True
    assert out.get("reason") == "tree_not_complete"
    mock_run.assert_not_called()
