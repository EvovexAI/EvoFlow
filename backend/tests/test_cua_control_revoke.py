"""「解除控制」= 只收回电脑操作权，不是停止 AI。

【self-evolution-bot · 2026-11-19 · 第72轮 · 模型:deepseek-v4.1-flash-1017】

用户原话纠正（上一轮我接错了）：
    「这个停止只是停止电脑控制，并不是停止AI啊。只是电脑控制这个插件，
     当前是取消电脑控制了」

上一轮我把按钮接到了 `stopSessionExecution` —— 那是掐整个 LangGraph run，
AI 这一轮的回答会被硬切断。这些测试锁的就是「不许再退回那个错法」。

四条判据，每条对应一种用户真能看见的错：
  ① 收回后 control_revoked=True，但**不碰** run_status / active 之外的会话态；
  ② 收回后 CUA 路径 must 被拦（模型拿到明确文案，不该反复重试到超时）；
  ③ 只有**新的用户消息**能自动恢复 —— assistant/tool 自己写库不算，
     否则 AI 一边写一边给自己解封，用户的操作完全失效；
  ④ 用户重发消息后恢复，不会变成「一次解除废掉整个会话」。
"""

from __future__ import annotations

import sqlite3

import pytest

from evoflow.collab import cua_glow_state as gs


class _FakeDb:
    """最小 sqlite 替身：只支持本测试用到的那条 SELECT。"""

    def __init__(self, max_user_seq: int = 0) -> None:
        self.max_user_seq = max_user_seq

    def execute(self, sql: str, params=()):
        assert "role = 'user'" in sql, f"判据必须只数 user 消息，实际 SQL={sql}"
        outer = self

        class _Cur:
            def fetchone(self_inner):
                return (outer.max_user_seq,)

        return _Cur()


@pytest.fixture()
def fake_db(monkeypatch):
    db = _FakeDb()
    import evoflow.persistence.db as dbmod

    monkeypatch.setattr(dbmod, "get_db", lambda: db, raising=False)
    return db


def _reset() -> None:
    gs.clear_cua_glow()
    gs.reset_cua_glow_steps()
    gs.restore_cua_control(reason="test_reset")


def test_revoke_marks_revoked_without_stopping_session(fake_db):
    _reset()
    fake_db.max_user_seq = 7

    snap = gs.revoke_cua_control(session_key="agent:main:abc")

    assert snap["control_revoked"] is True, "收回后必须置位，前端才能把按钮改成「已解除」"
    assert snap["control_reason"] == "user_revoked"
    # 提示条立刻收掉（用户点了要有反馈），但这不等于停会话。
    assert snap["active"] is False
    assert gs.is_cua_control_revoked(session_key="agent:main:abc") is True


def test_revoke_resets_steps_done(fake_db):
    """解除控制后步数必须归零，下次亮起从第 1 步开始。"""
    _reset()
    fake_db.max_user_seq = 2
    gs.pulse_cua_glow_start(key="c1")
    gs.set_cua_glow_step("正在点击")
    gs.set_cua_glow_step("正在输入")
    assert gs.get_cua_glow_status()["steps_done"] == 2

    snap = gs.revoke_cua_control(session_key="agent:main:abc")
    assert snap["steps_done"] == 0
    assert gs.get_cua_glow_status()["steps_done"] == 0


def test_revoke_does_not_reset_ai_turn_state(fake_db):
    """收回只动电脑控制，不许动 AI 回合 —— 这是本轮用户纠正的核心。"""
    _reset()
    fake_db.max_user_seq = 3
    gs.revoke_cua_control(session_key="agent:main:abc")
    # 状态模块里没有任何「run_status / 会话状态」字段被改写：
    # 停止会话是 session_execution 的职责，不该从这里发生。
    snap = gs.get_cua_glow_status()
    assert snap["control_revoked"] is True
    assert "run_status" not in snap, "收回控制权不该产生会话终态语义"


def test_new_user_message_auto_restores(fake_db):
    _reset()
    fake_db.max_user_seq = 5
    gs.revoke_cua_control(session_key="agent:main:abc")

    # 用户又发了消息（user seq 变高）→ 视为重新授权
    fake_db.max_user_seq = 6
    assert gs.is_cua_control_revoked(session_key="agent:main:abc") is False, (
        "用户发新消息后必须自动恢复，否则「解除控制」会一次性废掉整个会话"
    )
    assert gs.get_cua_glow_status()["control_revoked"] is False


def test_ai_writes_do_not_self_restore(fake_db):
    """assistant/tool 自己写库不能解封 —— 这是判据最容易写错的地方。"""
    _reset()
    fake_db.max_user_seq = 5
    gs.revoke_cua_control(session_key="agent:main:abc")

    # 关键：AI 继续写 assistant/tool 行时 user_max_seq **不变**（SQL 只数 role='user'）
    fake_db.max_user_seq = 5
    assert gs.is_cua_control_revoked(session_key="agent:main:abc") is True, (
        "AI 自己写库就把控制权解封了，等于用户点了解除却完全无效"
    )


def test_restore_clears_revocation(fake_db):
    _reset()
    fake_db.max_user_seq = 1
    gs.revoke_cua_control(session_key="agent:main:abc")
    assert gs.is_cua_control_revoked() is True

    snap = gs.restore_cua_control(session_key="agent:main:abc", reason="user_resend")
    assert snap["control_revoked"] is False
    assert gs.is_cua_control_revoked() is False


def test_db_failure_never_blocks_revocation(monkeypatch):
    """取证失败不能把「解除」变成无效：读不到 seq 就当作仍然收回。"""
    _reset()
    import evoflow.persistence.db as dbmod

    def _boom():
        raise sqlite3.OperationalError("database is locked")

    monkeypatch.setattr(dbmod, "get_db", _boom, raising=False)
    snap = gs.revoke_cua_control(session_key="agent:main:abc")
    assert snap["control_revoked"] is True
    assert gs.is_cua_control_revoked(session_key="agent:main:abc") is True


def test_revoke_with_unknown_seq_does_not_instant_auto_restore(fake_db):
    """收回时读不到水位（max_seq=0/-1），下次读到真实 seq 不得立刻解封。

    现网：user_stop 后 6 秒又继续 left_click_drag 画爱心 —— 根因就是
    revoke 写成 max_seq=0，随后 cur≥1 触发 auto_restored_new_user_message。
    """
    _reset()
    fake_db.max_user_seq = 0
    gs.revoke_cua_control(session_key="agent:main:abc", reason="user_stop")

    # 稍后库恢复，读到早已存在的 user seq=8 —— 必须仍收回，不能当「新消息」
    fake_db.max_user_seq = 8
    assert gs.is_cua_control_revoked(session_key="agent:main:abc") is True, (
        "未知水位时第一次读到正 seq 只能锁水位，不能解封"
    )
    # 真正的新用户消息（seq 再涨）才解封
    fake_db.max_user_seq = 9
    assert gs.is_cua_control_revoked(session_key="agent:main:abc") is False


def test_pulse_end_after_revoke_does_not_reopen_grace(fake_db):
    """收回后 in-flight cell 收尾不许再开 30s grace。"""
    _reset()
    fake_db.max_user_seq = 3
    gs.pulse_cua_glow_start(key="in_flight")
    gs.revoke_cua_control(session_key="agent:main:abc", reason="user_stop")
    assert gs.get_cua_glow_status()["active"] is False

    # cell 晚到的 end：必须保持熄灭
    ended = gs.pulse_cua_glow_end(key="in_flight")
    assert ended["active"] is False, f"收回后不应再亮 grace，实测 grace={ended.get('grace_ms_left')}"
    assert ended["grace_ms_left"] in (0, None) or not ended["active"]

def test_revoke_is_scoped_to_one_session(fake_db):
    """A 会话解除控制，不能把 B 会话的电脑操作一起拦掉。

    【self-evolution-bot · 2026-11-19 · 第72轮】用户可能同时开两个对话，
    一个在操作桌面、另一个只是聊天。收回必须只对被收回的那个会话生效。
    """
    _reset()
    fake_db.max_user_seq = 4
    gs.revoke_cua_control(session_key="agent:main:A")

    assert gs.is_cua_control_revoked(session_key="agent:main:A") is True
    assert gs.is_cua_control_revoked(session_key="agent:main:B") is False, (
        "B 会话没点解除，它的电脑操作不该被拦"
    )

def test_unknown_caller_is_blocked_safety_first(fake_db):
    """认不出调用方是谁时必须**拦**（安全优先）。

    【self-evolution-bot · 2026-11-19 · 第72轮】端到端实测过相反的一版
    （"认不出就不拦"），结果是收回控制后 AI 照样动鼠标，而用户正盯着屏幕 ——
    这是最难解释的失败形态。误拦代价小得多：另一个会话的模型收到
    「控制已收回」文案，用户在那边发一句话就自动恢复。
    """
    from evoflow.plugins import node_repl_tool as nrt

    _reset()
    fake_db.max_user_seq = 2
    gs.revoke_cua_control(session_key="agent:main:A")

    # thread_id 在库里查不到映射 ⇒ sk 为空 ⇒ 无法证明是同一会话 ⇒ 必须拦
    assert nrt._cua_control_revoked("some-unknown-thread") is True


def test_revoke_does_not_block_other_known_session(fake_db):
    """能证明是别的会话时，不许误伤（另一个对话的用户完全无从察觉）。"""
    _reset()
    fake_db.max_user_seq = 2
    gs.revoke_cua_control(session_key="agent:main:A")

    assert gs.is_cua_control_revoked(session_key="agent:main:B") is False
