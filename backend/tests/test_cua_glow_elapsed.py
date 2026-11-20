"""提示条「已操作时长」的生命周期。

【self-evolution-bot · 2026-11-19 · 第72轮 · 模型:deepseek-v4.1-flash-1017】
为什么必须测这个而不是「跑起来看着有数字」：
    时长的三个边界全是**看起来正常、实际误导**的形态：
      ① grace 期间秒数还在涨 → 用户以为控制没停；
      ② 同一轮多个 cell 之间重置 → 显示的永远只有最后一步的耗时；
      ③ 用户点「解除控制」后还留着旧秒数 → 等于告诉他没停掉。
    这三种都不会抛异常，肉眼也很难分辨（尤其在只跑 5 秒时）。
"""

from __future__ import annotations

import time

from evoflow.collab import cua_glow_state as gs


def _reset_all() -> None:
    gs.clear_cua_glow()
    gs.reset_cua_glow_steps()


def test_elapsed_starts_at_zero_and_grows_while_running():
    _reset_all()
    assert gs.get_cua_glow_status()["elapsed_ms"] == 0, "空闲时不该有累计时长"

    gs.pulse_cua_glow_start(key="c1")
    time.sleep(0.12)
    mid = gs.get_cua_glow_status()["elapsed_ms"]
    assert mid >= 100, f"跑起来后时长应随时间增长，实测 {mid}ms"
    assert gs.get_cua_glow_status()["running"] == 1


def test_elapsed_freezes_after_cell_ends():
    """cell 结束（进入 grace）后秒表必须停 —— 这是「已停止但秒数还在跳」的防线。"""
    _reset_all()
    gs.pulse_cua_glow_start(key="c1")
    time.sleep(0.15)
    ended = gs.pulse_cua_glow_end(key="c1")
    frozen = ended["elapsed_ms"]
    assert frozen >= 100, f"收工时应已累计到几百毫秒，实测 {frozen}ms"
    assert ended["running"] == 0

    time.sleep(0.20)
    later = gs.get_cua_glow_status()
    assert later["elapsed_ms"] == frozen, (
        f"grace 期间秒表不该继续走：收工时 {frozen}ms，0.2s 后变成 {later['elapsed_ms']}ms"
    )
    # 提示条本身仍可见（ZCode 的 30s grace 语义没被改动）
    assert later["active"] is True, "收工后 30s 内提示条应仍然可见"


def test_elapsed_does_not_reset_between_cells_in_same_turn():
    """同一轮里连续多个 cell 不能把秒表重置 —— 否则显示的永远只是最后一步。"""
    _reset_all()
    gs.pulse_cua_glow_start(key="c1")
    time.sleep(0.15)
    gs.pulse_cua_glow_end(key="c1")
    after_first = gs.get_cua_glow_status()["elapsed_ms"]
    assert after_first >= 100

    # 第二个 cell 接上（同一轮，用户还在看）
    gs.pulse_cua_glow_start(key="c2")
    resumed = gs.get_cua_glow_status()["elapsed_ms"]
    assert resumed >= after_first, (
        f"新一轮 cell 应接着累计而不是归零：上一 cell {after_first}ms → 现在 {resumed}ms"
    )


def test_clear_resets_elapsed_to_zero():
    """用户点「解除控制」后必须归零，否则等于告诉他没停掉。"""
    _reset_all()
    gs.pulse_cua_glow_start(key="c1")
    time.sleep(0.12)
    cleared = gs.clear_cua_glow()
    assert cleared["elapsed_ms"] == 0, f"强制清场后时长必须归零，实测 {cleared['elapsed_ms']}ms"
    assert cleared["active"] is False
    assert gs.get_cua_glow_status()["elapsed_ms"] == 0


def test_clear_and_new_round_reset_steps_done():
    """步数不能跨会话累加——否则胶囊面上会显示「第 17 步」这种错数。"""
    _reset_all()
    gs.pulse_cua_glow_start(key="c1")
    gs.set_cua_glow_step("正在点击")
    gs.set_cua_glow_step("正在输入")
    assert gs.get_cua_glow_status()["steps_done"] == 2

    gs.clear_cua_glow()
    assert gs.get_cua_glow_status()["steps_done"] == 0, "clear 必须清零步数"

    # 新一轮起表也要从 0 起；随后的第一步才是第 1 步。
    gs.pulse_cua_glow_start(key="c2")
    assert gs.get_cua_glow_status()["steps_done"] == 0
    gs.set_cua_glow_step("正在截图")
    assert gs.get_cua_glow_status()["steps_done"] == 1


def test_elapsed_is_exposed_on_the_status_payload():
    """HTTP 出口（/cua/glow-status）逐字透传快照 —— 字段必须在快照里存在。"""
    _reset_all()
    payload = gs.get_cua_glow_status()
    for key in ("elapsed_ms", "step_elapsed_ms", "running", "step", "steps_done"):
        assert key in payload, f"快照缺少字段 {key}，前端拿不到它"
    assert isinstance(payload["elapsed_ms"], int), "elapsed_ms 必须是整数毫秒（前端直接格式化）"
