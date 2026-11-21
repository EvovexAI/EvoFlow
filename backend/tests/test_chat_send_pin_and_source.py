"""chat_send 必须把算出来的会话键交给 wake，且 source 不得被当员工名。

【self-evolution-bot · 2026-11-20 · 第100轮 · 模型:deepseek-v4.1-flash-1017】

现网取证（2026-11-20 20:07:30，platform employees.chat_send → reviewer）：
- 面板开的是 ``proactive:reviewer:chat:dept-e52862be9e71``（20:07:32 / 20:07:34 有来有回）
- 服务端却落 ``proactive:reviewer:task:2611202007_de39``（20:07:31→47 另跑一轮，还白建一张任务单）
两个真因：
1. ``chat_send`` 算好 ``sk`` 后**没传给 wake** → wake 恒空钉 → engine 按 related_task_id 兜到 task 桶。
2. ``source="role"``（dispatch 的默认来源标签）被当员工名交给 ``resolve_role_ref`` →
   NotFoundError → 服务端 wake 直接失败，但 chat_send 仍回 ``client_effect``，
   面板在本地把消息发出去 —— 假成功。
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import patch

import pytest

from evoflow.admin import employees as emp


@pytest.fixture()
def _role():
    return SimpleNamespace(agent_code="reviewer", role_name="审核员", status="active")


# 【self-evolution-bot · 2026-11-21 · 第112轮 · 模型:deepseek-v4.1-flash-1017】
# 改了什么：autouse 把 CDP 面板固定成「不可达」。
# 为什么（真机复跑抓到）：文件里三条用例都在断言「算出来的 sk 必须落到 wake」，
#   但 chat_send 的 deliver=auto 是「面板在就驱面板、面板不在才 wake」。本机桌面
#   App 一开着，panel_request 就真成功 → need_wake=False → wake 一次都不调 →
#   `assert seen` 直接红。用例本意是测「sk 有没有传给 wake」，与桌面开没开无关，
#   不打桩等于让 CI/本地结果取决于「此刻有没有人开着 App」，不可复现。
# 判据：无论桌面面板是否在线，本文件结果恒定；要测面板那一路的用例自己另打桩覆盖。
@pytest.fixture(autouse=True)
def _no_panel(monkeypatch: pytest.MonkeyPatch):
    def _unreachable(*_a, **_kw):
        return {"ok": False, "error": "panel_unreachable_in_test"}

    monkeypatch.setattr(
        "evoflow.tools.builtins.panel_engine.panel_request",
        _unreachable,
        raising=False,
    )


def _patch_wake(monkeypatch: pytest.MonkeyPatch) -> list[dict]:
    """打桩 wake，收集它真实收到的参数（被测语义就是「传了什么下去」）。"""
    seen: list[dict] = []

    def _fake_wake(target, goal="", **kwargs):
        seen.append({"target": target, "goal": goal, **kwargs})
        return {
            "ok": True,
            "dispatched": True,
            "task_id": None,
            "agent_code": target,
            "role_name": "审核员",
        }

    monkeypatch.setattr(emp, "wake", _fake_wake)
    return seen


def test_chat_send_passes_computed_session_key_to_wake(monkeypatch, _role):
    """算出来的 sk 必须落到 wake，否则面板桶与服务端桶分家。"""
    seen = _patch_wake(monkeypatch)
    computed = "proactive:reviewer:chat:dept-e52862be9e71"
    with (
        patch.object(emp.ProactiveRepository, "get_role", return_value=_role),
        patch(
            "evoflow.proactive.chat_session.list_employee_conversation_sessions",
            return_value=[
                {
                    "session_key": computed,
                    "kind": "chat",
                    "run_status": "idle",
                }
            ],
        ),
    ):
        out = emp.chat_send("reviewer", "只回一句话", source="xiaomi")

    assert out["session_key"] == computed
    assert seen, "wake 必须被调用"
    assert seen[0]["session_key"] == computed, "算出来的 sk 丢了 → 服务端会落到 task 桶"
    assert seen[0]["pin_is_fresh"] is True, "刚算出来的键不许再被 retarget 协商换掉"


def test_chat_send_treats_unknown_source_as_platform(monkeypatch, _role):
    """source='role' 是来源标签，不是员工名，绝不能拿去 resolve_role_ref。"""
    seen = _patch_wake(monkeypatch)

    def _boom(ref: str):
        raise AssertionError(f"source {ref!r} 被当成员工身份去解析了")

    with (
        patch.object(emp.ProactiveRepository, "get_role", return_value=_role),
        patch.object(emp, "resolve_role_ref", _boom),
        patch(
            "evoflow.proactive.chat_session.list_employee_conversation_sessions",
            return_value=[],
        ),
        patch(
            "evoflow.proactive.chat_session.proactive_chat_session_key",
            return_value="proactive:reviewer:chat:minted",
        ),
    ):
        out = emp.chat_send("reviewer", "只回一句话", source="role")

    assert out["ok"] is True
    assert out.get("error") in (None, ""), f"wake 不该失败：{out.get('error')}"
    assert seen[0]["from_agent"] == "xiaomi"


def test_chat_send_real_role_source_still_attributes(monkeypatch, _role):
    """真正的同事来源仍要如实立案，别为了修 bug 把归因抹平。"""
    seen = _patch_wake(monkeypatch)
    teammate = SimpleNamespace(agent_code="tech-director", role_name="技术总监", status="active")
    with (
        patch.object(emp.ProactiveRepository, "get_role", return_value=_role),
        patch.object(emp, "resolve_role_ref", lambda ref: teammate),
        patch(
            "evoflow.proactive.chat_session.list_employee_conversation_sessions",
            return_value=[],
        ),
        patch(
            "evoflow.proactive.chat_session.proactive_chat_session_key",
            return_value="proactive:reviewer:chat:minted",
        ),
    ):
        emp.chat_send("reviewer", "只回一句话", source="tech-director")

    assert seen[0]["from_agent"] == "tech-director"


def test_wake_pin_is_fresh_skips_retarget(_role):
    """pin_is_fresh=True 时，刚算出的键必须原样采信，不被 prefer 换回旧屏。"""
    called = {"n": 0}

    def _should_not_run(*_a, **_kw):
        called["n"] += 1
        return ("proactive:reviewer:chat:OLD", "retargeted")

    with (
        patch.object(emp.ProactiveRepository, "get_role", return_value=_role),
        patch.object(emp, "resolve_role_ref", return_value=_role),
        patch(
            "evoflow.proactive.chat_session.prefer_newest_human_session",
            _should_not_run,
        ),
        patch.object(
            emp,
            "dispatch",
            lambda *a, **kw: {"ok": True, "session_key": kw.get("session_key")},
        ),
        patch(
            "evoflow.admin.tasks.task_has_pending_handoff_approval",
            lambda *_a, **_kw: False,
        ),
        patch("evoflow.proactive.work_items.all_referenced_tasks_done", lambda *_a, **_kw: (False, [])),
        patch("evoflow.proactive.work_items.load_work_item_task", lambda *_a, **_kw: None),
    ):
        out = emp.wake(
            "reviewer",
            goal="只回一句话",
            session_key="proactive:reviewer:chat:NEW",
            pin_is_fresh=True,
        )

    assert called["n"] == 0, "fresh 键不该进 retarget 协商"
    assert out["session_retarget"] == "fresh"
    assert out["session_key"] == "proactive:reviewer:chat:NEW"
