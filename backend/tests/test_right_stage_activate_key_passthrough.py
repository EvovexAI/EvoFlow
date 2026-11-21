"""``right_stage`` 事件过网关后必须保住 ``key``。

【self-evolution-bot · 2026-11-20 · 第101轮 · 模型:deepseek-v4.1-flash-1017】
改了什么：新建本测试，锁住「activate 的 key 在 SSE 归一化层被吞掉」这个缺陷。

为什么（本轮现网实测，有双侧日志）：
  23:28:39.736 ``[py] emit sent type=right_stage action=activate
  event={"action":"activate","surface":null,"key":"shell-page:shell:/tasks"}``
  —— 后端确实发出去了，之后前端**一条 web-state 上报都没有**，
  activeKey 仍停在 ``shell-page:shell:/proactive``。

真因：``agui_stream_normalizer.evf_payload_to_agui_events`` 的 ``right_stage``
分支原先只搬 ``action`` 与 ``surface``。而 ``activate`` **天然没有 surface**，
它唯一的载荷就是 ``key``。key 丢掉之后，前端 ``applyStageSetPayload`` 走的是

    if (action === 'activate') {
      const targetKey = String(payload.key || '').trim()
      if (!targetKey) { logPanelSet('① 动作=activate 失败：缺 key'); return false }
    }

—— 静默拒绝：不切签、不改状态、不上报。用户看到的就是「说切了，屏幕没动」。

判据（可反证）：
1. activate 事件过网关后，``value`` 里必须带 ``key`` 且与输入逐字相等；
2. show 事件（无 key）不得凭空多出 ``key`` 字段 —— 防止把 ``None`` 写成 ``"None"``；
3. 把 patch 撤掉（只搬 action/surface），第 1 条必须红。
"""

from __future__ import annotations

from app.gateway.agui_stream_normalizer import (
    AgUiEncoderState,
    evf_payload_to_agui_events,
)


def _right_stage_values(payload: dict) -> list[dict]:
    state = AgUiEncoderState(thread_id="t-test", run_id="r-test")
    out = evf_payload_to_agui_events(payload, state=state)
    return [
        ev.get("value")
        for ev in out
        if isinstance(ev, dict) and ev.get("name") == "right_stage"
    ]


def test_activate_key_survives_normalization():
    """activate 的唯一载荷是 key，过网关后不许丢。"""
    target = "shell-page:shell:/tasks"
    values = _right_stage_values(
        {
            "type": "right_stage",
            "action": "activate",
            "surface": None,
            "key": target,
        }
    )
    assert len(values) == 1, values
    value = values[0]
    assert value["action"] == "activate"
    assert value.get("key") == target, f"key 必须原样透传，实际 {value.get('key')!r}"


def test_activate_key_kept_when_surface_present():
    """带 surface 的 activate 同样要带 key（不许因分支顺序丢）。"""
    values = _right_stage_values(
        {
            "type": "right_stage",
            "action": "activate",
            "surface": {"kind": "shell-page"},
            "key": "employeeProcess:process:live:reviewer",
        }
    )
    assert values[0].get("key") == "employeeProcess:process:live:reviewer"


def test_show_event_has_no_spurious_key():
    """show 没有 key 时不得凭空补一个（尤其不能是字符串 "None"）。"""
    values = _right_stage_values(
        {
            "type": "right_stage",
            "action": "show",
            "surface": {"kind": "web-embed", "data": {"url": "https://example.com"}},
        }
    )
    value = values[0]
    assert value["action"] == "show"
    assert "key" not in value
    assert value["surface"]["kind"] == "web-embed"


def test_hide_event_still_surface_null():
    """hide 仍以 surface=null 表达，不许被 key 逻辑改写。"""
    values = _right_stage_values(
        {"type": "right_stage", "action": "hide", "surface": None}
    )
    value = values[0]
    assert value["action"] == "hide"
    assert value["surface"] is None
    assert "key" not in value
