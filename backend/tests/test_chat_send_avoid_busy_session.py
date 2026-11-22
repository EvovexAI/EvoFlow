"""派活给正在干活的员工时，必须另开一条会话，不许插进对方正在跑的回合。

【self-evolution-bot · 2026-11-22 · 第125轮 · 模型:deepseek-v4.1-flash】
用户当场点破 + 同日数据取证：
  · 我派自己一句「调一次 search_code_index」，回执 session_key 正是我当前这条对话
    （`sessions.status` 同 key、thread 8e4715ba、run_status=running）；
  · `evoflow_chat_messages` 序号自证：派单工具回执 seq14791 之后，那句被派的话作为
    **user** 落进**同一 thread**（seq14792），紧接着同一串里是我的工具调用（seq14793）；
  · `evoflow_chat_live_runs` 该会话只有**一行 running / 一个 partial_text 字段**
    → 两个回合共用一条流，后来的覆盖先来的，表现就是「话被截断」。

根因：`employees.chat_send` 自动选会话时 `hit = running or chat_hit`，**优先挑
run_status=running 的那条**。修法：挑空闲 chat 继聊；目标在跑就 mint 新会话，
并把被避开的键回给调用方（不许静默换桶）。
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import patch

import pytest

from evoflow.admin import employees as emp

BUSY = "proactive:douyin-analyst:chat:2026-11-19T16-15-39.290Z"
IDLE = "proactive:douyin-analyst:chat:2026-11-20T09-00-00.000Z"


@pytest.fixture(autouse=True)
def _no_side_effects(monkeypatch: pytest.MonkeyPatch) -> None:
    """本机没有真实 role/profile：把 wake 与面板 CDP 都打桩，只测「选哪条会话」。"""
    monkeypatch.setattr(
        emp, "wake", lambda *a, **kw: {"task_id": None, "skipped": False, "accepted": True}
    )
    monkeypatch.setattr(
        "evoflow.tools.builtins.panel_engine.panel_request",
        lambda *a, **kw: {"ok": False, "error": "bridge down"},
    )


def _role():
    return SimpleNamespace(
        agent_code="douyin-analyst", role_name="抖音拆解师", status="active"
    )


def test_busy_target_gets_new_conversation_not_the_running_one():
    """目标正在跑 → 必须 mint 新会话，并把被避开的 busy 键显式回执。"""
    with (
        patch.object(emp.ProactiveRepository, "get_role", return_value=_role()),
        patch(
            "evoflow.proactive.chat_session.list_employee_conversation_sessions",
            return_value=[
                {"session_key": BUSY, "kind": "chat", "run_status": "running"},
            ],
        ),
        patch(
            "evoflow.proactive.chat_session.proactive_chat_session_key",
            return_value="proactive:douyin-analyst:chat:NEW-MINTED",
        ) as mint,
    ):
        out = emp.chat_send("douyin-analyst", "再跑一遍")

    mint.assert_called()  # 必须真去开新的，而不是复用
    assert out["session_key"] == "proactive:douyin-analyst:chat:NEW-MINTED"
    assert out["session_key"] != BUSY, "消息不许插进对方正在跑的回合"
    assert out["busy_avoided_session_key"] == BUSY
    assert out["busy_avoided_reason"] == "target_session_running_new_conversation_minted"


def test_idle_target_reuses_its_conversation():
    """反证：目标空闲时必须继聊原来那条，别把每条消息都开成新会话。"""
    with (
        patch.object(emp.ProactiveRepository, "get_role", return_value=_role()),
        patch(
            "evoflow.proactive.chat_session.list_employee_conversation_sessions",
            return_value=[
                {"session_key": IDLE, "kind": "chat", "run_status": "idle"},
            ],
        ),
        patch(
            "evoflow.proactive.chat_session.proactive_chat_session_key",
            return_value="proactive:douyin-analyst:chat:SHOULD-NOT-BE-USED",
        ) as mint,
    ):
        out = emp.chat_send("douyin-analyst", "接着说")

    mint.assert_not_called()
    assert out["session_key"] == IDLE
    assert "busy_avoided_session_key" not in out


def test_explicit_session_key_still_wins_even_if_running():
    """边界：调用方**显式**指定的会话（属于该员工）照旧尊重 —— 那是人的明示意图。

    否则「继续这条指定对话」会被系统偷偷换成新会话，比原缺陷更难查。
    """
    with patch.object(emp.ProactiveRepository, "get_role", return_value=_role()):
        out = emp.chat_send("douyin-analyst", "继续这条", session_key=BUSY)

    assert out["session_key"] == BUSY
    assert "busy_avoided_session_key" not in out
    assert "ignored_caller_session_key" not in out


def test_busy_and_idle_both_present_picks_idle():
    """最关键的一条反证：busy 与 idle 并存时，旧代码挑 busy（插进正在跑的回合），
    新代码必须挑 idle。

    【为什么必须补这条】我先写的 task 用例名不副实：它没走 chat 继聊分支，旧代码
    在那里也会 mint 新会话，所以拆掉修复它照样绿 —— 那种用例等于没守。探针实测：
    拆掉 busy 过滤后只有 `test_busy_target_gets_new_conversation_not_the_running_one`
    转红，task 用例仍绿。这条用例才是「能区分新旧行为」的那把尺。
    """
    with (
        patch.object(emp.ProactiveRepository, "get_role", return_value=_role()),
        patch(
            "evoflow.proactive.chat_session.list_employee_conversation_sessions",
            return_value=[
                {"session_key": BUSY, "kind": "chat", "run_status": "running"},
                {"session_key": IDLE, "kind": "chat", "run_status": "idle"},
            ],
        ),
        patch(
            "evoflow.proactive.chat_session.proactive_chat_session_key",
            return_value="proactive:douyin-analyst:chat:SHOULD-NOT-BE-USED",
        ) as mint,
    ):
        out = emp.chat_send("douyin-analyst", "接着问一句")

    assert out["session_key"] == IDLE, "必须挑空闲那条，不许挑正在跑的那条"
    mint.assert_not_called()  # 有空闲可继聊时不新开
    assert out["busy_avoided_session_key"] == BUSY
