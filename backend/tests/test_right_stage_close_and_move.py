"""右栏「关单个签」「调换位置」两个动作必须真的发得出去、且判据能被反证。

【self-evolution-bot · 2026-11-20 · 第101轮 · 模型:deepseek-v4.1-flash-1017】
改了什么：新建本测试，锁住 ui.close / ui.move 两条新动作。

为什么（用户当场要求，原话）：
  「你可以切换到哪个进行一个显示，或者是给它关掉，或者是打开，或者给它调换位置。
   就这种像人一样的操作。」
  实测发现：前端 store 里 `closeTab(key)` / `reorderTab(activeId, overId)` 早就写好了，
  但后端 ui 域只有 show / update / hide / activate ——
  「关掉那一个」只能整栏 hide（用户的其它签被一起藏）；「调换位置」完全没有入口。

判据（可反证）：
1. close 必须带 key；缺 key 时报错并指路（不许静默 ok）。
2. close 发出的事件是 `action=close` + `key`，**不是** `action=hide` ——
   两者语义不同：hide 收起整栏（签还在），close 真的删掉那一个签。
3. move 必须同时带 key 与 target；两者相同直接报错（不发必然无效果的指令）。
4. move 事件带 key + target 两个字段，缺一个就发不出去。
"""

from __future__ import annotations

import pytest

from evoflow.tools.builtins import stage_tool


@pytest.fixture(autouse=True)
def _isolate(tmp_path, monkeypatch):
    """捕获 emit 事件，别碰现网状态盘与审计日志。"""
    from app.gateway.routers import stage_right_panel as srp
    from evoflow.stage import right_stage_audit_log as audit

    monkeypatch.setattr(srp, "right_stage_state_path", lambda: tmp_path / "state.json")
    monkeypatch.setattr(audit, "_logs_dir", lambda: tmp_path)
    srp._STATE.clear()  # noqa: SLF001
    yield
    srp._STATE.clear()  # noqa: SLF001


def _capture(monkeypatch) -> list[dict]:
    events: list[dict] = []
    monkeypatch.setattr(stage_tool, "_emit", lambda ev: events.append(dict(ev)))
    return events


def test_close_emits_close_not_hide(monkeypatch):
    events = _capture(monkeypatch)
    out = stage_tool.apply_right_panel(action="close", key="shell-page:shell:/tasks")
    assert out["ok"] is True
    assert out["action"] == "close"
    assert out["key"] == "shell-page:shell:/tasks"
    assert len(events) == 1
    ev = events[0]
    assert ev["action"] == "close", f"close 不许退化成 hide，实际 {ev['action']}"
    assert ev["key"] == "shell-page:shell:/tasks"
    assert ev["surface"] is None


def test_close_requires_key():
    out = stage_tool.apply_right_panel(action="close")
    assert out["ok"] is False
    assert "key is required" in out["error"]
    # 必须指路到正确读法，而不是只说「缺参数」
    assert "ui.current" in out["error"]
    assert "ui.hide" in out["error"]


def test_move_emits_key_and_target(monkeypatch):
    events = _capture(monkeypatch)
    out = stage_tool.apply_right_panel(
        action="move",
        key="shell-page:shell:/tasks",
        target_key="employeeProcess:process:live:reviewer",
    )
    assert out["ok"] is True
    ev = events[0]
    assert ev["action"] == "move"
    assert ev["key"] == "shell-page:shell:/tasks"
    assert ev["target"] == "employeeProcess:process:live:reviewer"


def test_move_requires_both_keys():
    out = stage_tool.apply_right_panel(action="move", key="a:b")
    assert out["ok"] is False
    assert "target" in out["error"]


def test_move_rejects_same_tab():
    out = stage_tool.apply_right_panel(action="move", key="a:b", target_key="a:b")
    assert out["ok"] is False
    assert "same tab" in out["error"]


def test_close_and_move_survive_normalization():
    """两个新动作过网关后必须保住 key（move 还要 target）。"""
    from app.gateway.agui_stream_normalizer import (
        AgUiEncoderState,
        evf_payload_to_agui_events,
    )

    def _values(payload: dict) -> list[dict]:
        state = AgUiEncoderState(thread_id="t", run_id="r")
        return [
            ev["value"]
            for ev in evf_payload_to_agui_events(payload, state=state)
            if isinstance(ev, dict) and ev.get("name") == "right_stage"
        ]

    close_vals = _values(
        {"type": "right_stage", "action": "close", "surface": None, "key": "shell-page:shell:/tasks"}
    )
    assert close_vals[0]["action"] == "close"
    assert close_vals[0]["key"] == "shell-page:shell:/tasks"

    move_vals = _values(
        {
            "type": "right_stage",
            "action": "move",
            "surface": None,
            "key": "a:b",
            "target": "c:d",
        }
    )
    assert move_vals[0]["key"] == "a:b"
    assert move_vals[0]["target"] == "c:d", "target 不许在归一化层被吞"
