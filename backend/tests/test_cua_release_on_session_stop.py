"""用户停对话必须立刻收回电脑控制 —— 否则对话已停、蓝光/grace 还挂着。"""

from __future__ import annotations

from evoflow.collab import cua_glow_state as gs
from evoflow.session_execution.commands import _release_cua_control_on_user_stop


def _reset() -> None:
    gs.clear_cua_glow()
    gs.reset_cua_glow_steps()
    gs.restore_cua_control(reason="test_reset")


def test_user_stop_releases_active_cua_for_same_session():
    _reset()
    gs.pulse_cua_glow_start(key="call_draw")
    gs.set_cua_glow_thread("tid-1", "agent:main:draw")
    assert gs.get_cua_glow_status()["active"] is True

    _release_cua_control_on_user_stop("agent:main:draw")

    snap = gs.get_cua_glow_status()
    assert snap["active"] is False, "停对话后提示条必须熄灭"
    assert snap["control_revoked"] is True
    assert snap["control_reason"] == "user_stop"
    assert snap["elapsed_ms"] == 0


def test_user_stop_does_not_touch_other_session_cua():
    _reset()
    gs.pulse_cua_glow_start(key="call_other")
    gs.set_cua_glow_thread("tid-B", "agent:main:B")
    assert gs.get_cua_glow_status()["active"] is True

    _release_cua_control_on_user_stop("agent:main:A")

    snap = gs.get_cua_glow_status()
    assert snap["active"] is True, "停 A 不能掐掉 B 的电脑控制"
    assert snap["control_revoked"] is False


def test_user_stop_noop_when_cua_already_idle():
    _reset()
    assert gs.get_cua_glow_status()["active"] is False
    _release_cua_control_on_user_stop("agent:main:idle")
    assert gs.get_cua_glow_status()["control_revoked"] is False
