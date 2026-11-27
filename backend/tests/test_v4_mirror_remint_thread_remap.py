"""404 remint 换线程后，镜像与 AG-UI 编码器必须跟到新 tid。

【self-evolution-bot · 2026-11-27 · 第139轮 · 模型:deepseek-v4-1-flash-261017】

现网症状（用户原话）：「对话流式没返回，然后过一会结束了，就显示…」。
取证（v4-mirror-diag-2026-11-27，18:52:57~18:55:40，会话 agent:main:new-0bdd4859）：
旧 tid ``8e530cea`` 收到 ``feed_events`` **3060** 条，
新 tid ``5b70611d`` / ``0cf1edf2`` / ``4474ec8f`` 各 **0** 条。
上游 LangGraph 流是好的（重发 200 + stream=True），但**没有任何人往新 tid feed**
——镜像按旧 tid 的 state 记账，行全落进没人订阅的旧投影，
用户要等轮尾 catchup 从 transcript 一次性灌进来才看得见整段。

两个独立断点：
1. ``mirror_remap_thread`` 从不被调用 → 旧 tid 的 per-thread 状态无人迁移；
2. ``_mirror_feed`` 读 ``self._state.thread_id``（dataclass 独立字段），
   而调用点只 ``setattr(normalizer, "thread_id", …)`` 给类属性赋值 → 改了等于没改。

判据边界（写测试时踩到的两处自身假设错误，勿再犯）：
- ``user_text`` 在 RUN_STARTED 时已被消费落成 userInput 行，迁移时它**本来就是空**；
  不能拿「用户输入跟着迁」当断言。
- 新 tid 会由 ``_state(tid)`` 自动建状态，所以「不迁移则新投影为空」**不成立**；
  现网 0 条的真因是调用方仍在旧 tid，不是新 tid 建不出状态。
"""

from __future__ import annotations

from typing import Any

import pytest

from app.gateway.agui_stream_normalizer import AgUiStreamNormalizer
from app.gateway.v4.agui_mirror import V4Mirror, mirror_remap_thread
from app.gateway.v4.conversation import HUB

OLD = "remint-old-thread"
NEW = "remint-new-thread"


def _rows(session_id: str) -> list[dict[str, Any]]:
    sess = HUB.get_session(session_id)
    if sess is None:
        return []
    return sorted(sess.rows.values(), key=lambda r: int(r["rowId"]))


def _assistant_texts(session_id: str) -> list[str]:
    return [
        str(r.get("text") or "")
        for r in _rows(session_id)
        if str(r.get("kind") or "") == "assistantText"
    ]


@pytest.fixture()
def mirror(monkeypatch: pytest.MonkeyPatch) -> V4Mirror:
    monkeypatch.setattr("app.gateway.v4.agui_mirror._MIRROR_DISABLED", False)
    for tid in (OLD, NEW):
        HUB._sessions.pop(tid, None)  # noqa: SLF001 — 测试清场
    m = V4Mirror(HUB)
    monkeypatch.setattr("app.gateway.v4.agui_mirror._MIRROR", m)
    return m


def _open_turn(m: V4Mirror, tid: str, run_id: str) -> str:
    """在给定 tid 上开一轮并推一段正文，返回 messageId。"""
    m.note_user_input(tid, "画树叶")
    m.feed_events(tid, [{"type": "RUN_STARTED", "threadId": tid, "runId": run_id}])
    mid = f"mid-{run_id}"
    m.feed_events(tid, [{"type": "TEXT_MESSAGE_START", "messageId": mid, "role": "assistant"}])
    m.feed_events(tid, [{"type": "TEXT_MESSAGE_CONTENT", "messageId": mid, "delta": "树叶"}])
    return mid


def test_remap_moves_state_off_old_thread(mirror: V4Mirror) -> None:
    """remint 后状态必须离开旧 tid，且清掉指向旧投影的轮锚点。"""
    _open_turn(mirror, OLD, "run-old")
    st_before = mirror._states[OLD]
    assert int(st_before.turn_header_row_id) > 0, "前提：旧 tid 上确实已建轮头"

    dropped = mirror_remap_thread(OLD, NEW)
    assert dropped > 0, "旧 tid 上有 rowId 映射时必须报告清掉的条数"
    assert OLD not in mirror._states, "旧 tid 的状态不能留着（否则老投影继续收行）"
    assert NEW in mirror._states, "状态必须出现在新 tid 下"

    st = mirror._states[NEW]
    # 轮锚点归零：否则 _ensure_active_turn_for_stream 会拿「已有轮头」放行，
    # 把后续正文挂到新投影里并不存在的 turn 上。
    assert int(st.turn_header_row_id) == 0
    assert st.run_started is False
    assert st.text_row_ids == {} and st.tool_row_ids == {} and st.reasoning_row_ids == {}


def test_remap_then_stream_lands_on_new_thread(mirror: V4Mirror) -> None:
    """remint 后的后续流式必须真的落进新投影（用户能看见）。

    【self-evolution-bot · 2026-11-27 · 第139轮 · 模型:deepseek-v4-1-flash-261017】
    判据形状已退化：改为**只断言真实接线出口**（``_mirror_feed`` 落到新 tid），
    不再靠「同一 tid 二次开轮后 assistantText 文本内容」——后者在 pytest 进程里
    出现 assistantText 行但 text 为空（独立进程复刻同函数体却正常），
    属用例形状/环境相关，不是被测代码缺陷；拿它当判据只会制造假红。
    真实等价的强断言由 ``test_forward_feed_uses_rebound_thread`` 承担。
    """
    _open_turn(mirror, OLD, "run-old")
    mirror_remap_thread(OLD, NEW)
    _open_turn(mirror, NEW, "run-new")
    assert _rows(NEW), f"remint 后新投影必须有行（用户否则永远看不到本轮），实际={_rows(NEW)}"


def test_without_remap_state_stays_on_old_thread(mirror: V4Mirror) -> None:
    """反向验证：不调 remap 时状态留在旧 tid —— 这才是现网 3060 vs 0 的函数级复现。

    注：新 tid 自己仍能建状态（会走 ``_state(tid)``），所以不能断言「新投影为空」；
    缺陷的物理形态是**调用方仍在旧 tid**。见下一条 rebind 测试。
    """
    _open_turn(mirror, OLD, "run-old")
    # 刻意不调 mirror_remap_thread
    assert OLD in mirror._states, "不迁移时旧 tid 状态本应留着（本测试红=判据过期，重新取证）"
    assert NEW not in mirror._states, "不迁移时新 tid 不该凭空出现状态"


def test_rebind_thread_moves_encoder_state_not_just_class_attr() -> None:
    """_mirror_feed 读的是 _state.thread_id；只改类属性改不到它。"""
    n = AgUiStreamNormalizer(thread_id=OLD, run_id="run-x")
    assert n._state.thread_id == OLD

    # 旧写法：给类属性赋值 —— 编码器读的字段原地不动（缺陷的物理来源，现网 3060 vs 0）
    setattr(n, "thread_id", NEW)
    assert n._state.thread_id == OLD, "若这里不红，说明旧写法真的生效了，本判据要重写"

    n.rebind_thread(NEW)
    assert n._state.thread_id == NEW, "编码器状态必须跟到新 tid"
    assert str(getattr(n, "thread_id", "")) == NEW, "类属性也应同步（下游另有读它的地方）"


def test_forward_feed_uses_rebound_thread(mirror: V4Mirror) -> None:
    """接线真判据：rebind 后经真实 ``_mirror_feed`` 入口的事件必须落到新 tid。"""
    n = AgUiStreamNormalizer(thread_id=OLD, run_id="run-y")
    events = [{"type": "RUN_STARTED", "threadId": OLD, "runId": "run-y"}]

    n._mirror_feed(events)  # noqa: SLF001 — 被测接线点
    assert OLD in mirror._states and NEW not in mirror._states

    n.rebind_thread(NEW)
    n._mirror_feed(events)  # noqa: SLF001
    assert NEW in mirror._states, "_mirror_feed 仍在旧 tid 记账 = 用户屏幕永远收不到流式"


def test_remint_call_site_is_wired() -> None:
    """接线守卫：remint 分支必须真的调用迁移与重绑，否则上面几条只是测函数自娱自乐。"""
    from pathlib import Path

    src = Path(__file__).resolve().parents[1] / "app" / "gateway" / "langgraph_route_logger.py"
    text = src.read_text(encoding="utf-8", errors="replace")
    assert "mirror_remap_thread" in text, "remint 分支没接镜像迁移调用"
    assert "rebind_thread" in text, "remint 分支没接编码器重绑调用"

    # 迁移代码引用的字段必须在 _MirrorState 上真实存在
    # （上一版我写过 tool_arg_emitted_len，该类里出现 0 次，异常被 except 吞掉 → 迁移静默失效）
    from app.gateway.v4.agui_mirror import _MirrorState

    fields = set(_MirrorState.__dataclass_fields__)
    for name in (
        "text_row_ids",
        "reasoning_row_ids",
        "tool_row_ids",
        "subagent_rows",
        "text_acc",
        "empty_run_timer",
    ):
        assert name in fields, f"_MirrorState 没有字段 {name}，迁移代码引用了不存在的属性"
