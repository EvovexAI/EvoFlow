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


def test_elapsed_keeps_growing_during_grace():
    """cell 结束进入 grace 后秒表必须继续走 —— 否则胶囊面上「秒数一直不动」。"""
    _reset_all()
    gs.pulse_cua_glow_start(key="c1")
    time.sleep(0.12)
    ended = gs.pulse_cua_glow_end(key="c1")
    at_end = ended["elapsed_ms"]
    assert at_end >= 100, f"收工时应已累计到几百毫秒，实测 {at_end}ms"
    assert ended["running"] == 0
    assert ended["active"] is True, "收工后 30s 内提示条应仍然可见"

    time.sleep(0.20)
    later = gs.get_cua_glow_status()
    assert later["active"] is True
    assert later["elapsed_ms"] >= at_end + 150, (
        f"grace 期间秒表应继续走：收工时 {at_end}ms，0.2s 后变成 {later['elapsed_ms']}ms"
    )


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


def test_new_round_after_grace_expires_resets_elapsed():
    """上一轮 grace 过期后再开电脑控制，秒表必须从 0 起，不能接着旧数。"""
    _reset_all()
    gs.pulse_cua_glow_start(key="c1")
    time.sleep(0.12)
    gs.pulse_cua_glow_end(key="c1")
    mid = gs.get_cua_glow_status()["elapsed_ms"]
    assert mid >= 100

    # 假装 grace 已过（把截止点拨到过去），再读一次快照触发熄灭清零。
    gs._GRACE_UNTIL_MS = gs._now_ms() - 1  # noqa: SLF001 — 测试专用拨钟
    idle = gs.get_cua_glow_status()
    assert idle["active"] is False
    assert idle["elapsed_ms"] == 0, f"熄灭后时长必须归零，实测 {idle['elapsed_ms']}ms"

    gs.pulse_cua_glow_start(key="c2")
    fresh = gs.get_cua_glow_status()["elapsed_ms"]
    assert fresh < 80, f"新一轮应接近 0，不能接着上一轮 {mid}ms，实测 {fresh}ms"


def test_stale_active_since_after_expired_grace_does_not_continue_timer():
    """无人轮询导致 grace 过期但锚点未清时，下一轮 start 仍须归零。"""
    _reset_all()
    gs.pulse_cua_glow_start(key="old")
    time.sleep(0.10)
    gs.pulse_cua_glow_end(key="old")
    old = gs.get_cua_glow_status()["elapsed_ms"]
    assert old >= 80

    # 不走 get_status：直接把 grace 拨过期，模拟「没人轮询、锚点还在」。
    gs._GRACE_UNTIL_MS = gs._now_ms() - 5_000  # noqa: SLF001
    assert gs._ACTIVE_SINCE_MS > 0  # noqa: SLF001 — 锚点故意还挂着

    gs.pulse_cua_glow_start(key="new")
    fresh = gs.get_cua_glow_status()["elapsed_ms"]
    assert fresh < 80, f"过期 grace 后新一轮必须归零，实测 {fresh}ms（旧轮 {old}ms）"


def test_elapsed_is_exposed_on_the_status_payload():
    """HTTP 出口（/cua/glow-status）逐字透传快照 —— 字段必须在快照里存在。"""
    _reset_all()
    payload = gs.get_cua_glow_status()
    for key in ("elapsed_ms", "step_elapsed_ms", "running", "step", "steps_done"):
        assert key in payload, f"快照缺少字段 {key}，前端拿不到它"
    assert isinstance(payload["elapsed_ms"], int), "elapsed_ms 必须是整数毫秒（前端直接格式化）"
