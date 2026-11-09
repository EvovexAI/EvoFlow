"""``admin.tasks.create_task`` 的顺序约束：source 必须在配额闸门之前解析。

背景（2026-11-09 实测）：``_enforce_round_initiative_quota`` 的入参里引用了
``source_canon``，但当时 ``source_canon, source_channel = resolve_write_source(...)``
写在调用**之后**，于是每次建单都抛
``UnboundLocalError: cannot access local variable 'source_canon' where it is not associated with a value``。
整条建单链路（岗位 tasks create、任务中心「新建」、handler 派发）全挂，
但只有真正跑一次 create 才暴露——纯静态的类型/引用检查看不出来。

这里锁两件事：
1. 建单不再抛 UnboundLocalError（不论 source 传不传）；
2. 配额闸门收到的是**已解析的规范化 source**，而不是 None/空串——
   否则闸门里的 ``if src != "role": return`` 会静默放行，等于把 P0 配额整个关掉。
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from evoflow.admin import tasks as admin_tasks


@pytest.fixture()
def captured_quota(monkeypatch):
    """替换配额闸门，只记录入参（不触发真实 role 库查询）。"""
    captured: dict[str, object] = {}
    monkeypatch.setattr(
        admin_tasks,
        "_enforce_round_initiative_quota",
        lambda **kwargs: captured.update(kwargs),
    )
    monkeypatch.setattr(admin_tasks, "get_project_storage", lambda: MagicMock())
    return captured


def test_create_task_does_not_raise_unbound_source(captured_quota):
    """回归点：曾经每次建单都 UnboundLocalError。"""
    out = admin_tasks.create_task(
        name="__test_create_task_source_order__",
        assignee="fullstack-dev",
        start=False,
    )
    assert out.get("task_id")
    assert out.get("name") == "__test_create_task_source_order__"


def test_quota_gate_receives_resolved_source(captured_quota):
    """闸门必须拿到 chat|workflow|role，空串会让配额检查静默失效。"""
    admin_tasks.create_task(
        name="__test_quota_source_resolved__",
        assignee="fullstack-dev",
        source="role",
        start=False,
    )
    assert captured_quota.get("source_canon") == "role"


def test_quota_gate_canonicalizes_legacy_source(captured_quota):
    """旧 source 值也要在进闸门前归一（proactive_patrol → role）。"""
    admin_tasks.create_task(
        name="__test_quota_source_legacy__",
        assignee="fullstack-dev",
        source="proactive_patrol",
        start=False,
    )
    assert captured_quota.get("source_canon") == "role"
