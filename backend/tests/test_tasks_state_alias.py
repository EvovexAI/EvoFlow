"""tasks 工具 ``action=state`` 必须接住 ``state=`` 这个别名（第19轮实测后补的契约）。

背景：本 action 名就叫 ``state``，但状态值要传给 ``status``。观测库实测
``error_message='status is required'`` 已发生 3 次（2026-11-15 08:02 / 15:02 / 19:32），
最后一次就在我把报错文案改明确**之后** —— 证明改文案只缓解、不解决。

【self-evolution-bot · 2026-11-16 · 第19轮】
判据取自同文件 ``_resolve_create_description`` 的先例：
① 能兜回来就兜（``status`` 与 ``state`` 都给时以 ``status`` 为准）；
② 兜回来时**回执里明写 warning，不许静默**；
③ 两个都没给时仍要报错，且文案指方向。

接线要点（我第一版写错的地方）：``tasks_admin`` 是 ``tasks_tool`` **函数体内** import 的
（tasks_tool.py:431），不是模块级属性 —— 因此必须打补丁到
``sys.modules["evoflow.admin.tasks"]`` 上，直接 setattr 模块会 AttributeError。
"""

from __future__ import annotations

import importlib
import sys

import pytest

# 包属性会被同名 StructuredTool 遮蔽，必须按模块路径直载（见 tests/test_bash_tool_timeout.py）。
tasks_tool_mod = importlib.import_module("evoflow.tools.builtins.tasks_tool")


@pytest.fixture()
def fake_admin(monkeypatch):
    """把 set_task_state 换成记录器（打补丁到 sys.modules 里的真模块）。"""
    admin_mod = importlib.import_module("evoflow.admin.tasks")
    assert sys.modules["evoflow.admin.tasks"] is admin_mod
    captured: dict = {}

    def _fake_set_state(tid, st, **kw):
        captured["task_id"] = tid
        captured["status"] = st
        return {"task_id": tid, "status": st}

    monkeypatch.setattr(admin_mod, "set_task_state", _fake_set_state)
    monkeypatch.setattr(
        tasks_tool_mod, "_bind_actor_from_runtime", lambda runtime: "test-actor"
    )
    return captured


def _call(**kwargs):
    return tasks_tool_mod.tasks_tool.func(
        action="state", runtime=None, task_id="T1", **kwargs
    )


def test_state_alias_is_accepted_and_warns(fake_admin) -> None:
    out = _call(state="completed")
    assert fake_admin["status"] == "completed", f"别名未生效: {out}"
    assert "warning" in out, f"别名被兜回却未明写 warning: {out}"
    assert "status" in out


def test_status_wins_over_alias(fake_admin) -> None:
    """两者都给时以规范名 status 为准，且不应报 warning。"""
    out = _call(status="failed", state="completed")
    assert fake_admin["status"] == "failed"
    assert "warning" not in out


def test_neither_given_still_errors(fake_admin) -> None:
    out = _call()
    assert fake_admin == {}, "没给状态值却调用了 set_task_state"
    assert "status is required" in out
    assert "state" in out, "报错未提示 state 别名"
