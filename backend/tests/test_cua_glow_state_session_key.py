"""CUA 顶部提示条状态：进度字段 + 「解除控制」需要的会话键。

【self-evolution-bot · 2026-11-19 · 第68轮 · 模型:deepseek-v4.1-flash-1017】

为什么有这组测试：
用户反馈「不知道 AI 操作到哪一步，也不知道怎么解除控制」。前端「解除控制」
最终调 chatAbort / POST /chat/sessions/<sk>/execution/stop，两者只认
`session_key`（形如 ``agent:main:new-0093fe5b``）。而状态里原本只有
`thread_id`，那是 LangGraph 的 UUID（``ae5615a4-…``）——前一代前端就是拿它
当 sessionKey 用的，点了按钮停不掉任何会话，只把指示器藏着。

这组测试锁三件事：
1. ``session_key`` 必须出现在快照里（前端取得到）；
2. ``set_cua_glow_thread`` 不传 session_key 时不能把已有的值抹成空；
3. ``step`` 系列字段只增不减，``reset_cua_glow_steps`` 才清零。
"""

from __future__ import annotations

import pytest

from evoflow.collab import cua_glow_state as glow


@pytest.fixture(autouse=True)
def _clean_state():
    """每个用例从干净状态起步（模块级全局，会跨用例串味）。"""
    glow.clear_cua_glow()
    glow.reset_cua_glow_steps()
    with glow._LOCK:
        glow._THREAD_ID["value"] = ""
        glow._THREAD_ID["session_key"] = ""
    yield
    glow.clear_cua_glow()
    glow.reset_cua_glow_steps()
    with glow._LOCK:
        glow._THREAD_ID["value"] = ""
        glow._THREAD_ID["session_key"] = ""


def test_snapshot_exposes_session_key():
    """前端要靠 session_key 停会话；只给 thread_id 等于停不掉（旧缺陷）。"""
    glow.set_cua_glow_thread("ae5615a4-791d-49b4-974e-623247a50878", "agent:main:new-0093fe5b")
    snap = glow.get_cua_glow_status()
    assert snap["thread_id"] == "ae5615a4-791d-49b4-974e-623247a50878"
    assert snap["session_key"] == "agent:main:new-0093fe5b"
    # 两者格式必须不同：同值说明又有人把它们当一回事了。
    assert snap["session_key"] != snap["thread_id"]


def test_session_key_survives_thread_only_update():
    """后续 cell 只报 thread_id 时，不能把已解析到的 session_key 抹空。"""
    glow.set_cua_glow_thread("tid-1", "agent:main:new-aaaa")
    glow.set_cua_glow_thread("tid-1")
    assert glow.get_cua_glow_status()["session_key"] == "agent:main:new-aaaa"


def test_step_fields_present_and_progress_monotonic():
    """步骤文案 + 累计步数：同一句不重复计数，换了才 +1。"""
    snap = glow.get_cua_glow_status()
    for key in ("step", "step_seq", "steps_done", "step_elapsed_ms"):
        assert key in snap, f"快照缺字段 {key}"

    glow.set_cua_glow_step("正在截图查看屏幕")
    glow.set_cua_glow_step("正在截图查看屏幕")
    snap = glow.get_cua_glow_status()
    assert snap["step"] == "正在截图查看屏幕"
    assert snap["steps_done"] == 1, "同一句重复推送不该算两步"

    glow.set_cua_glow_step("正在点击")
    snap = glow.get_cua_glow_status()
    assert snap["step"] == "正在点击"
    assert snap["steps_done"] == 2
    assert snap["step_seq"] == 2


def test_empty_step_clears_label_but_keeps_counter():
    """认不出的代码传空串：只剩主文案，但已完成的步数不能回退。"""
    glow.set_cua_glow_step("正在点击")
    glow.set_cua_glow_step("")
    snap = glow.get_cua_glow_status()
    assert snap["step"] == ""
    assert snap["steps_done"] == 1


def test_reset_cua_glow_steps_zeroes_progress():
    glow.set_cua_glow_step("正在点击")
    glow.reset_cua_glow_steps()
    snap = glow.get_cua_glow_status()
    assert snap["step"] == ""
    assert snap["steps_done"] == 0
    assert snap["step_seq"] == 0


def test_step_does_not_touch_visibility():
    """推进度不该让提示条自己亮起来，也不该改 active/running 语义。"""
    assert glow.get_cua_glow_status()["active"] is False
    glow.set_cua_glow_step("正在点击")
    assert glow.get_cua_glow_status()["active"] is False

    glow.pulse_cua_glow_start(key="call-1")
    glow.set_cua_glow_step("正在输入 / 按键")
    snap = glow.get_cua_glow_status()
    assert snap["active"] is True
    assert snap["running"] == 1
    assert snap["step"] == "正在输入 / 按键"
