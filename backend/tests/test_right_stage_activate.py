"""右栏「切到用户已开的某个标签页」必须真的能切，且不破坏用户现场。

【self-evolution-bot · 2026-11-20 · 第100轮 · 模型:deepseek-v4.1-flash-1017】

用户原话：「你要知道当前是哪一个，然后怎么去切换到哪一个要处理好。」

改动前的事实：``platform`` 只有 ui.show / ui.update / ui.hide。
模型想让用户看回某页**只能重新 show**，而 show 会把同一份东西开成第二个签——
正好破坏「用户右栏还拉开着别的东西」这个现场。切签能力根本不存在。

判据（可反证）：
- ``ui.activate`` 缺 key 时报错必须点名「先用 ui.current 取 tabs[].key」，不许只说 required。
- ``apply_right_panel(action="activate", key=...)`` 只发 ``activate`` 事件，不发 show/update。
- 返回里 ``tabCountBefore == tabCountAfter``（切签不动标签集合）。
- 目标 key 不在用户已开标签里时必须如实标记 ``targetExists=False`` 并给出当前 key 列表。
"""

from __future__ import annotations

import pytest

from app.gateway.routers import stage_right_panel as srp
from evoflow.tools.builtins.stage_tool import apply_right_panel


@pytest.fixture(autouse=True)
def _clean_state(tmp_path, monkeypatch):
    # 【self-evolution-bot · 2026-11-20 · 第100轮续 · 模型:deepseek-v4.1-flash-1017】
    # 改了什么：隔离从「只清内存」改为「盘文件指向 tmp_path + 清内存」。
    # 为什么：状态现在落盘跨进程共享，只清 _STATE 时 read_right_stage_state() 会回读
    #   现网真实盘文件（本机已有一份 employeeProcess 状态），于是「没上报过」用例
    #   直接假红 —— 测试隔离必须覆盖它实际读的每一处。
    state_file = tmp_path / "right-stage-state.json"
    monkeypatch.setattr(srp, "right_stage_state_path", lambda: state_file)
    srp._STATE.clear()  # noqa: SLF001 - 测试隔离
    yield
    srp._STATE.clear()  # noqa: SLF001


def _report(active_key: str, tabs: list[dict]) -> None:
    srp.store_right_stage_state(
        {
            "activeKey": active_key,
            "activeKind": (tabs[[t["key"] for t in tabs].index(active_key)].get("kind") if active_key else None),
            "activeTitle": (tabs[[t["key"] for t in tabs].index(active_key)].get("title") if active_key else None),
            "collapsed": False,
            "tabs": tabs,
        }
    )


TABS = [
    {"key": "employeeProcess:primary", "kind": "employeeProcess", "title": "审核员"},
    {"key": "shell-page:tasks", "kind": "shell-page", "title": "任务"},
    {"key": "file:docs/a.md", "kind": "file", "title": "a.md"},
]


def test_activate_emits_activate_not_show(monkeypatch):
    """切签只能发 activate 事件；一旦发 show/update 就会改内容/多开签。"""
    _report("employeeProcess:primary", TABS)
    events: list[dict] = []
    monkeypatch.setattr(
        "evoflow.tools.builtins.stage_tool._emit", lambda event: events.append(event)
    )

    out = apply_right_panel(action="activate", key="file:docs/a.md")

    assert out["ok"] is True
    assert out["action"] == "activate"
    assert out["key"] == "file:docs/a.md"
    assert len(events) == 1
    assert events[0]["type"] == "right_stage"
    assert events[0]["action"] == "activate"
    # 关键反证：绝不能是 show/update
    assert events[0]["action"] not in ("show", "update")


def test_activate_keeps_tab_count(monkeypatch):
    """切签不得增减标签：用户拉开的东西一个不少、也不多出重复签。"""
    _report("employeeProcess:primary", TABS)
    monkeypatch.setattr("evoflow.tools.builtins.stage_tool._emit", lambda event: None)

    out = apply_right_panel(action="activate", key="shell-page:tasks")

    screen = out["userScreen"]
    assert screen["known"] is True
    assert screen["tabCountBefore"] == 3
    assert screen["tabCountAfter"] == 3
    assert screen["targetExists"] is True
    assert screen["before"]["activeKey"] == "employeeProcess:primary"


def test_activate_unknown_key_lists_current_keys(monkeypatch):
    """目标签不存在时不许谎称成功，且要把现有 key 列出来（否则模型只会重复猜）。"""
    _report("employeeProcess:primary", TABS)
    monkeypatch.setattr("evoflow.tools.builtins.stage_tool._emit", lambda event: None)

    out = apply_right_panel(action="activate", key="nope:missing")

    screen = out["userScreen"]
    assert screen["targetExists"] is False
    assert "shell-page:tasks" in screen["note"]
    assert screen["tabCountBefore"] == screen["tabCountAfter"] == 3


def test_activate_without_key_fails_with_actionable_error(monkeypatch):
    """缺 key 的报错必须指路 ui.current，而不是只说 required。"""
    monkeypatch.setattr("evoflow.tools.builtins.stage_tool._emit", lambda event: None)

    out = apply_right_panel(action="activate")

    assert out["ok"] is False
    assert "ui.current" in out["error"]


def test_activate_before_any_report_is_honest(monkeypatch):
    """从没上报过时不许假装知道现场，要如实说无法确认。"""
    monkeypatch.setattr("evoflow.tools.builtins.stage_tool._emit", lambda event: None)

    out = apply_right_panel(action="activate", key="shell-page:tasks")

    assert out["ok"] is True
    assert out["userScreen"]["known"] is False
    assert "无法确认" in out["userScreen"]["note"]


def test_platform_ui_activate_is_registered_read_only():
    """ui.activate 必须注册、且是只读（永不自动弹右栏）。"""
    from evoflow.admin.platform_actions import get_registry
    from evoflow.stage.right_panel_kinds import should_auto_open

    reg = get_registry()
    assert "ui.activate" in reg
    assert reg["ui.activate"].risk == "read"
    assert should_auto_open("ui.activate") is False


def test_platform_ui_activate_requires_key_with_hint():
    """platform ui.activate 缺 key 时应报错并带上当前 tabs 的 key 列表。"""
    from evoflow.admin.platform_handlers import ui_activate

    _report("employeeProcess:primary", TABS)
    with pytest.raises(Exception) as exc:
        ui_activate({})
    msg = str(exc.value)
    assert "ui.current" in msg
    assert "shell-page:tasks" in msg
