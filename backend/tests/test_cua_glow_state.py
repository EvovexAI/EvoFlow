"""CUA top-indicator in-process state (ZCode windowsCuaOperationIndicator driver)."""

from evoflow.collab.cua_glow_state import (
    AUTO_HIDE_MS,
    clear_cua_glow,
    get_cua_glow_status,
    pulse_cua_glow_end,
    pulse_cua_glow_start,
    set_cua_glow,
)


def test_cua_glow_start_end_keeps_grace():
    """ZCode: cell end must NOT hard-hide — 30s grace keeps active=True."""
    clear_cua_glow()
    assert get_cua_glow_status()["active"] is False

    a = pulse_cua_glow_start(key="call-1")
    assert a["active"] is True
    assert a["running"] == 1

    b = pulse_cua_glow_start(key="call-2")
    assert b["running"] == 2

    c = pulse_cua_glow_end(key="call-1")
    assert c["active"] is True
    assert c["running"] == 1

    d = pulse_cua_glow_end(key="call-2")
    # Last cell ended → still visible during AUTO_HIDE grace.
    assert d["active"] is True
    assert d["running"] == 0
    assert d["grace_ms_left"] is not None and d["grace_ms_left"] > 0
    assert d["auto_hide_ms"] == int(AUTO_HIDE_MS)


def test_cua_glow_clear_all():
    pulse_cua_glow_start(key="x")
    pulse_cua_glow_start(key="y")
    out = clear_cua_glow()
    assert out["active"] is False
    assert out["running"] == 0


def test_set_cua_glow_compat_empty_key_clears():
    set_cua_glow(active=True, key="x")
    out = set_cua_glow(active=False, key="")
    assert out["active"] is False
# ── 【self-evolution-bot · 2026-11-19 · 第68轮 · 模型:deepseek-v4.1-flash-1017】──
# 用户反馈：「不知道 AI 操作到哪一步，也不知道怎么解除控制。」
# 下面三条钉住本轮加的东西；它们都是**前端唯一能拿到的数据源**，
# 少一个提示条就又退回成一句固定文案（这正是缺陷本身）。


def test_status_carries_step_and_count():
    """进度必须能从 /cua/glow-status 取到，否则前端无从显示「第几步」。"""
    from evoflow.collab.cua_glow_state import set_cua_glow_step

    clear_cua_glow()
    pulse_cua_glow_start(key="call-step")
    st = set_cua_glow_step("正在点击")
    assert st["step"] == "正在点击"
    assert st["step_seq"] >= 1
    assert st["steps_done"] >= 1


def test_step_count_only_grows_within_turn():
    """同一步文案重复推进不许把计数刷成虚高（否则「第 87 步」是假的）。"""
    from evoflow.collab.cua_glow_state import reset_cua_glow_steps, set_cua_glow_step

    clear_cua_glow()
    pulse_cua_glow_start(key="call-grow")
    reset_cua_glow_steps()
    set_cua_glow_step("正在点击")
    first = get_cua_glow_status()
    set_cua_glow_step("正在点击")  # 同一句，重复下发
    second = get_cua_glow_status()
    assert second["steps_done"] == first["steps_done"], "重复同一句不该递增步骤数"
    set_cua_glow_step("正在输入 / 按键")
    assert get_cua_glow_status()["steps_done"] == first["steps_done"] + 1


def test_status_carries_thread_id_for_stop_button():
    """「解除控制」必须知道停哪个会话；多会话并行时猜错就是事故。"""
    from evoflow.collab.cua_glow_state import set_cua_glow_thread

    clear_cua_glow()
    pulse_cua_glow_start(key="call-thread")
    st = set_cua_glow_thread("thread-abc123")
    assert st["thread_id"] == "thread-abc123"


def test_old_callers_get_unchanged_fields():
    """反证：不传 step/thread 的老调用方，既有字段语义必须原样。"""
    clear_cua_glow()
    before = get_cua_glow_status()
    assert before["active"] is False
    assert before["running"] == 0
    a = pulse_cua_glow_start(key="legacy")
    assert a["active"] is True and a["running"] == 1
    b = pulse_cua_glow_end(key="legacy")
    assert b["active"] is True, "cell 结束时必须仍在 grace 内可见"
    assert b["grace_ms_left"] is not None
    assert AUTO_HIDE_MS > 0
