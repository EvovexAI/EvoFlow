"""用户事项 CRUD 与 inbox 迁移（与 Task 分离）。"""

from __future__ import annotations

import tempfile
from pathlib import Path

import pytest

from evoflow.items import service as items_svc
from evoflow.items.store import reset_store_for_tests
from evoflow.persistence.db import reset_db_for_tests


@pytest.fixture
def items_home(monkeypatch: pytest.MonkeyPatch):
    with tempfile.TemporaryDirectory() as tmp:
        monkeypatch.setenv("EVOFLOW_HOME", tmp)
        reset_db_for_tests()
        reset_store_for_tests()
        try:
            from evoflow.config.paths import reset_paths_cache

            reset_paths_cache()
        except Exception:
            pass
        yield Path(tmp)
        reset_store_for_tests()
        reset_db_for_tests()
        try:
            from evoflow.config.paths import reset_paths_cache

            reset_paths_cache()
        except Exception:
            pass


def test_create_list_update_delete(items_home: Path) -> None:
    created = items_svc.create_item(title="周五交报告", notes="附数据表", tags=["工作", "报告"])
    item = created["item"]
    assert item["id"].startswith("item_")
    assert item["status"] == "todo"
    assert item.get("conclusion") == ""
    assert "工作" in item["tags"]

    listed = items_svc.list_items()
    assert listed["total"] == 1
    assert listed["items"][0]["title"] == "周五交报告"

    updated = items_svc.update_item(
        item["id"],
        {
            "status": "done",
            "progress": 100,
            "conclusion": "报告已交，异常项已同步硬件组",
        },
    )
    assert updated["item"]["status"] == "done"
    assert updated["item"]["progress"] == 100
    assert updated["item"]["conclusion"] == "报告已交，异常项已同步硬件组"

    got = items_svc.get_item(item["id"])
    assert got["item"]["notes"] == "附数据表"
    assert got["item"]["conclusion"] == "报告已交，异常项已同步硬件组"
    assert items_svc.list_items(q="硬件组")["total"] == 1

    deleted = items_svc.delete_item(item["id"])
    assert deleted["ok"] is True
    assert items_svc.list_items()["total"] == 0


def test_list_filters(items_home: Path) -> None:
    items_svc.create_item(title="A 待办", status="todo", tags=["a"], priority="high")
    items_svc.create_item(title="B 完成", status="done", tags=["b"], priority="low")
    assert items_svc.list_items(status="todo")["total"] == 1
    assert items_svc.list_items(include_done=False)["total"] == 1
    assert items_svc.list_items(q="完成")["total"] == 1
    assert items_svc.list_items(tag="a")["total"] == 1
    assert items_svc.list_items(priority="high")["total"] == 1


def test_list_pagination(items_home: Path) -> None:
    for i in range(5):
        items_svc.create_item(title=f"事项 {i}", status="todo")
    page1 = items_svc.list_items(page=1, page_size=2)
    assert page1["total"] == 5
    assert page1["pages"] == 3
    assert len(page1["items"]) == 2
    page3 = items_svc.list_items(page=3, page_size=2)
    assert len(page3["items"]) == 1
    assert page3["page"] == 3


def test_platform_items_actions(items_home: Path) -> None:
    from evoflow.admin.platform_actions import dispatch_platform_action, reset_registry_cache

    reset_registry_cache()
    out = dispatch_platform_action(
        "items.create",
        args_json='{"title":"记一条","notes":"via platform"}',
        confirm=True,
    )
    assert out.get("ok") is True
    item_id = out["item"]["id"]
    listed = dispatch_platform_action("items.list", args_json="{}", confirm=False)
    assert listed["total"] >= 1
    dispatch_platform_action(
        "items.update",
        args_json=f'{{"item_id":"{item_id}","status":"done"}}',
        confirm=True,
    )
    got = dispatch_platform_action("items.get", args_json=f'{{"item_id":"{item_id}"}}')
    assert got["item"]["status"] == "done"


def test_platform_items_create_with_tags(items_home: Path) -> None:
    from evoflow.admin.platform_actions import dispatch_platform_action, reset_registry_cache

    reset_registry_cache()
    out = dispatch_platform_action(
        "items.create",
        args_json='{"title":"带标签事项","tags":["工作","报告"]}',
        confirm=True,
    )
    assert out.get("ok") is True
    assert out["item"]["tags"] == ["工作", "报告"]
    out2 = dispatch_platform_action(
        "items.create",
        args_json='{"title":"逗号标签","tags":"运营, 设计"}',
        confirm=True,
    )
    assert out2["item"]["tags"] == ["运营", "设计"]


def test_dispatch_item_is_idempotent_for_same_agent(items_home: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Second dispatch to the same open assignee reuses Task; no duplicate linked ids."""
    import asyncio
    from unittest.mock import AsyncMock

    created = items_svc.create_item(title="修粘贴图片", notes="核查")
    item_id = created["item"]["id"]

    class _Role:
        role_name = "前端工程师"
        agent_code = "code-agent"
        status = "active"

    monkeypatch.setattr(
        "evoflow.proactive.repositories.ProactiveRepository.get_role",
        lambda code: _Role() if str(code) == "code-agent" else None,
    )
    wake = AsyncMock(
        return_value={"ok": True, "dispatched": True, "scheduled": True},
    )
    monkeypatch.setattr(items_svc, "_wake_employee_for_item", wake)

    async def _run() -> None:
        first = await items_svc.dispatch_item(item_id, agent_code="code-agent", wake_now=False)
        assert first["ok"] is True
        assert first.get("already_dispatched") is False
        tid1 = first["task_id"]
        assert tid1

        second = await items_svc.dispatch_item(item_id, agent_code="code-agent", wake_now=True)
        assert second["ok"] is True
        assert second.get("already_dispatched") is True
        assert second["task_id"] == tid1
        assert second.get("code") == "ALREADY_DISPATCHED" or second.get("dispatched") is True
        assert wake.await_count == 1

        item = items_svc.get_item(item_id)["item"]
        linked = [str(x) for x in (item.get("linked_task_ids") or []) if str(x).strip()]
        assert linked == [tid1]

        forced = await items_svc.dispatch_item(
            item_id, agent_code="code-agent", wake_now=False, force=True
        )
        assert forced.get("already_dispatched") is False
        assert forced["task_id"] != tid1
        linked2 = items_svc.get_item(item_id)["item"]["linked_task_ids"]
        assert tid1 in linked2 and forced["task_id"] in linked2

    asyncio.run(_run())


def test_dispatch_item_busy_queues_without_second_task(
    items_home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """When wake returns queued_behind_busy, do not mint another Task."""
    import asyncio
    from unittest.mock import AsyncMock

    created = items_svc.create_item(title="紧急修闪烁", notes="x")
    item_id = created["item"]["id"]

    class _Role:
        role_name = "前端工程师"
        agent_code = "code-agent"
        status = "active"

    monkeypatch.setattr(
        "evoflow.proactive.repositories.ProactiveRepository.get_role",
        lambda code: _Role() if str(code) == "code-agent" else None,
    )

    async def _run() -> None:
        first = await items_svc.dispatch_item(item_id, agent_code="code-agent", wake_now=False)
        tid = first["task_id"]
        wake = AsyncMock(
            return_value={
                "ok": True,
                "dispatched": False,
                "busy": True,
                "queued_behind_busy": True,
                "message": "已排队",
            }
        )
        monkeypatch.setattr(items_svc, "_wake_employee_for_item", wake)
        second = await items_svc.dispatch_item(item_id, agent_code="code-agent", wake_now=True)
        assert second["task_id"] == tid
        assert second.get("already_dispatched") is True
        assert second.get("queued_behind_busy") is True
        assert second.get("dispatched") is False
        assert second.get("code") == "QUEUED_BEHIND_BUSY"
        linked = items_svc.get_item(item_id)["item"]["linked_task_ids"]
        assert linked == [tid]

    asyncio.run(_run())


def test_task_complete_syncs_linked_item(items_home: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """E2E gap fix: Task completed → Item done + progress 100."""
    import asyncio
    from unittest.mock import AsyncMock

    from evoflow.admin import tasks as tasks_admin

    created = items_svc.create_item(title="端到端闭环同步事项", notes="验证回写")
    item_id = created["item"]["id"]

    class _Role:
        role_name = "前端工程师"
        agent_code = "code-agent"
        status = "active"
        config = type("C", (), {"workspace_path": str(items_home / "ws")})()

    monkeypatch.setattr(
        "evoflow.proactive.repositories.ProactiveRepository.get_role",
        lambda code: _Role() if str(code) == "code-agent" else None,
    )
    monkeypatch.setattr(
        items_svc,
        "_wake_employee_for_item",
        AsyncMock(return_value={"ok": True, "dispatched": True, "scheduled": True}),
    )

    async def _dispatch() -> str:
        out = await items_svc.dispatch_item(item_id, agent_code="code-agent", wake_now=False)
        return str(out["task_id"])

    tid = asyncio.run(_dispatch())
    item = items_svc.get_item(item_id)["item"]
    assert item["status"] == "waiting"
    assert item["progress"] == 0

    exec_out = tasks_admin.set_task_state(tid, "executing", summary="执行中")
    assert exec_out.get("status") == "executing"
    item = items_svc.get_item(item_id)["item"]
    assert item["status"] == "waiting"
    assert (exec_out.get("item_sync") or {}).get("status") == "waiting"

    done_out = tasks_admin.set_task_state(
        tid, "completed", summary="闭环完成，事项应自动 done"
    )
    assert done_out.get("status") == "completed"
    item = items_svc.get_item(item_id)["item"]
    assert item["status"] == "done"
    assert item["progress"] == 100
    assert (done_out.get("item_sync") or {}).get("status") == "done"


def test_timestamp_on_beijing_day_helpers() -> None:
    from evoflow.admin.employees import _timestamp_on_beijing_day

    assert _timestamp_on_beijing_day("2026-08-15T11:38:34.000000+08:00", "2026-08-15")
    # UTC evening previous calendar day can still be Beijing next morning
    assert _timestamp_on_beijing_day("2026-08-14T17:00:00+00:00", "2026-08-15")
    assert not _timestamp_on_beijing_day("2026-08-14T01:00:00+08:00", "2026-08-15")


def test_store_reloads_when_disk_mtime_changes(items_home: Path) -> None:
    """外进程改写 user_items.json 后，本进程不得继续返回旧缓存。"""
    import json
    import time

    from evoflow.items import store as item_store

    created = items_svc.create_item(title="缓存同步", notes="旧备注")
    iid = created["item"]["id"]
    assert items_svc.get_item(iid)["item"]["status"] == "todo"

    path = item_store._store_path()
    doc = json.loads(path.read_text(encoding="utf-8"))
    for raw in doc.get("items") or []:
        if isinstance(raw, dict) and raw.get("id") == iid:
            raw["status"] = "done"
            raw["progress"] = 100
            raw["conclusion"] = "外进程已写结论"
            break
    # 保证 mtime 变化（Windows 分辨率可能较粗）
    time.sleep(0.02)
    path.write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8")

    got = items_svc.get_item(iid)["item"]
    assert got["status"] == "done"
    assert got["progress"] == 100
    assert got["conclusion"] == "外进程已写结论"
