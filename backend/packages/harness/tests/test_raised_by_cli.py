"""raised_by + CLI create_task + round pending scan."""

from __future__ import annotations

from evoflow.admin import tasks as admin_tasks
from evoflow.collab.storage import find_main_task, get_project_storage
from evoflow.proactive.models import (
    ProactiveAutonomyLevel,
    ProactiveRole,
    ProactiveRoleConfig,
)
from evoflow.proactive.work_items import (
    create_role_work_item,
    list_pending_work_items_for_round,
)


def test_create_task_stamps_raised_by_and_round(tmp_path, monkeypatch):
    monkeypatch.setenv("EVOFLOW_DATA_DIR", str(tmp_path))
    created = admin_tasks.create_task(
        name="CLI raised item",
        description="from duty shell",
        assignee="qa-agent",
        assigned_role="质量官",
        source="role",
        source_ref="round:abc",
        raised_by="qa-agent",
        risk_level="medium",
        action_type="analysis",
        round_id="round:abc",
    )
    tid = str(created.get("task_id") or "")
    assert tid
    assert created.get("raised_by") == "qa-agent"
    assert created.get("source_ref") == "round:abc"
    assert created.get("risk_level") == "medium"

    storage = get_project_storage()
    found = find_main_task(storage, tid, bypass_cache=True)
    assert found
    _proj, task = found
    assert task.get("raised_by") == "qa-agent"
    assert task.get("round_id") == "round:abc"
    assert task.get("assigned_role") == "质量官"

    got = admin_tasks.get_task(tid)
    assert got.get("raised_by") == "qa-agent"
    assert got.get("risk_level") == "medium"


def test_list_pending_work_items_for_round_finds_cli_task(tmp_path, monkeypatch):
    monkeypatch.setenv("EVOFLOW_DATA_DIR", str(tmp_path))
    role = ProactiveRole(
        agent_code="scan-agent",
        role_name="扫描岗",
        config=ProactiveRoleConfig(autonomy_level=ProactiveAutonomyLevel.FULL_AUTO),
    )
    rid = "round:scan-1"
    created = admin_tasks.create_task(
        name="Pending round item",
        assignee=role.agent_code,
        assigned_role=role.role_name,
        source="proactive_patrol",
        raised_by=role.agent_code,
        source_ref=rid,
        round_id=rid,
        risk_level="low",
    )
    assert created.get("task_id")

    pending = list_pending_work_items_for_round(role, rid)
    ids = {str(t.get("id") or t.get("task_id") or "") for t in pending}
    assert created["task_id"] in ids


def test_create_role_work_item_defaults_raised_by_user(tmp_path, monkeypatch):
    monkeypatch.setenv("EVOFLOW_DATA_DIR", str(tmp_path))
    role = ProactiveRole(
        agent_code="dispatch-agent",
        role_name="派发岗",
        config=ProactiveRoleConfig(autonomy_level=ProactiveAutonomyLevel.FULL_AUTO),
    )
    out = create_role_work_item(
        role,
        {
            "title": "User dispatch",
            "description": "from panel",
            "action_type": "analysis",
            "risk_level": "low",
        },
        source="employee_page",
        source_ref="dispatch:test",
        raised_by="user",
    )
    assert out
    tid = out["task_id"]
    assert out.get("raised_by") == "user"
    got = admin_tasks.get_task(tid)
    assert got.get("raised_by") == "user"


def test_parent_task_id_handoff_tree(tmp_path, monkeypatch):
    monkeypatch.setenv("EVOFLOW_DATA_DIR", str(tmp_path))
    root = admin_tasks.create_task(
        name="产品需求根",
        assignee="product-manager",
        assigned_role="产品经理",
        source="role",
        raised_by="user",
    )
    root_id = root["task_id"]
    mid = admin_tasks.create_task(
        name="技术总监协调",
        assignee="quality-inspector",
        assigned_role="技术总监",
        source="role",
        raised_by="product-manager",
        parent_task_id=root_id,
        risk_level="medium",
        action_type="task_delegation",
    )
    mid_id = mid["task_id"]
    assert mid.get("parent_task_id") == root_id
    leaf = admin_tasks.create_task(
        name="前端实现",
        assignee="code-agent",
        assigned_role="前端工程师",
        source="role",
        raised_by="quality-inspector",
        parent_task_id=mid_id,
        action_type="code_change",
    )
    leaf_id = leaf["task_id"]
    got_mid = admin_tasks.get_task(mid_id)
    assert got_mid.get("parent_task_id") == root_id
    assert got_mid.get("parent", {}).get("task_id") == root_id
    assert leaf_id in (got_mid.get("child_task_ids") or [])

    got_leaf = admin_tasks.get_task(leaf_id)
    assert got_leaf.get("parent_task_id") == mid_id
    assert got_leaf.get("parent", {}).get("name")

    got_root = admin_tasks.get_task(root_id)
    assert mid_id in (got_root.get("child_task_ids") or [])
    assert got_root.get("parent_task_id") is None
