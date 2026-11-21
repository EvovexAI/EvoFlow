"""employees.chat_send must never target the caller's agent:main session."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import patch

import pytest

from evoflow.admin import employees as emp


@pytest.fixture(autouse=True)
def _stub_wake(monkeypatch: pytest.MonkeyPatch) -> None:
    """``chat_send`` 会真的调 ``wake``；本机没有 douyin-analyst 这个 role 的 profile，
    真实 wake 必抛 "Role ... not found" → ``ok`` 恒 False，三条用例全红。

    【self-evolution-bot · 2026-11-20 · 第92轮 · 模型:deepseek-v4.1-flash-1017】
    被测语义是「session_key 归属判定 / 注入的主聊 key 必须被忽略」，与 wake 是否
    在本机跑通无关。autouse 打桩把 wake 固定成 accepted，用例回到只测分派逻辑。
    """
    monkeypatch.setattr(
        emp,
        "wake",
        lambda *a, **kw: {"task_id": None, "skipped": False, "accepted": True},
    )


def _role():
    return SimpleNamespace(
        agent_code="douyin-analyst",
        role_name="抖音拆解师",
        status="active",
    )


def test_employee_owns_session_key_helpers():
    assert emp._employee_owns_session_key("proactive:douyin-analyst:chat:x", "douyin-analyst")
    assert emp._employee_owns_session_key("proactive:douyin-analyst", "douyin-analyst")
    assert not emp._employee_owns_session_key("agent:main:new-10a8acbd", "douyin-analyst")
    assert not emp._employee_owns_session_key("proactive:other:chat:x", "douyin-analyst")
    assert not emp._employee_owns_session_key(
        "proactive:douyin-analyst-extra:chat:x", "douyin-analyst"
    )


def test_chat_send_ignores_injected_main_session_key():
    with (
        patch.object(emp.ProactiveRepository, "get_role", return_value=_role()),
        patch(
            "evoflow.proactive.chat_session.list_employee_conversation_sessions",
            return_value=[],
        ),
        patch(
            "evoflow.proactive.chat_session.proactive_chat_session_key",
            return_value="proactive:douyin-analyst:chat:fixed",
        ) as mint,
    ):
        out = emp.chat_send(
            "douyin-analyst",
            "请拆这条视频",
            session_key="agent:main:new-10a8acbd",
            source="xiaomi",
        )

    assert out["ok"] is True
    assert out["session_key"] == "proactive:douyin-analyst:chat:fixed"
    assert out["ignored_caller_session_key"] == "agent:main:new-10a8acbd"
    assert out["client_effect"] == "employee_chat_send"
    mint.assert_called()


def test_chat_send_keeps_owned_proactive_session():
    owned = "proactive:douyin-analyst:chat:keep-me"
    # 【self-evolution-bot · 2026-11-21 · 第112轮 · 模型:deepseek-v4.1-flash-1017】
    # 改了什么：补 CDP 面板打桩（pane-busy = 面板没接住）。
    # 为什么（真机复跑抓到）：本机桌面面板在线时，chat_send 会真去驱动面板并发消息，
    #   面板回报自己的 sk ``chat:fixed`` → 回执按「实际发送者」回填 → 这里断言 owned 就红。
    #   这条用例测的是「调用方传的、且属于该员工的 sk 不许被丢弃」，与面板在不在线无关；
    #   不打桩等于让用例结果取决于「此刻桌面 App 开没开」，典型不可复现。
    # 判据：无论本机面板是否在线，本用例结果恒定。
    with (
        patch.object(emp.ProactiveRepository, "get_role", return_value=_role()),
        patch(
            "evoflow.tools.builtins.panel_engine.panel_request",
            lambda *a, **kw: _panel_env("pane-busy", session_key=owned),
        ),
    ):
        out = emp.chat_send(
            "douyin-analyst",
            "继续",
            session_key=owned,
            source="xiaomi",
        )
    assert out["session_key"] == owned
    assert "ignored_caller_session_key" not in out


# 【self-evolution-bot · 2026-11-21 · 第109轮 · 模型:deepseek-v4.1-flash-1017】
# 改了什么：补 deliver="panel" 的两条判据——服务端必须**经 CDP 真把面板驱起来**，
#   而不是回个标记等前端猜。
# 为什么（用户 2026-11-21 点破）：「我在右侧面板手打能看到实时结果，你后台触发页面上
#   啥也看不到。」第108轮只回 panel_delivery 标记、指望前端补发；只要这次调用不经过
#   agui 工具结果同步（Xiaomi 主聊 / 手机 / 别的 agent），标记就没人消费，面板照样没流。
# 判据（可反证）：panel_dispatch 非空时前端不得再 pendingSend（否则同一句话发两遍）；
#   为空（CDP 不可用）时前端必须 pendingSend（否则用户什么都看不到）。两条都要能反证。
def _panel_env(
    mode: str,
    session_key: str = "proactive:douyin-analyst:chat:fixed",
    *,
    requested_session_key: str | None = None,
    session_key_matched: bool | None = None,
    session_key_matched_by: str | None = None,
):
    detail: dict = {
        "mode": mode,
        "agentCode": "douyin-analyst",
        "sessionKey": session_key,
        "length": 3,
    }
    if requested_session_key is not None:
        detail["requestedSessionKey"] = requested_session_key
    if session_key_matched is not None:
        detail["sessionKeyMatched"] = session_key_matched
    if session_key_matched_by is not None:
        detail["sessionKeyMatchedBy"] = session_key_matched_by
    return {
        "ok": True,
        "result": {
            "action": "employeeChatSend",
            "detail": detail,
        },
    }


def test_chat_send_deliver_panel_drives_pane_and_skips_wake(monkeypatch):
    calls: list[tuple[str, str, dict]] = []

    def fake_panel_request(method, route, *, body=None, timeout=None):
        calls.append((method, route, body or {}))
        return _panel_env("pane-live")

    monkeypatch.setattr(
        "evoflow.tools.builtins.panel_engine.panel_request",
        fake_panel_request,
    )
    woke: list[str] = []
    monkeypatch.setattr(emp, "wake", lambda *a, **kw: woke.append("x") or {})

    with (
        patch.object(emp.ProactiveRepository, "get_role", return_value=_role()),
        patch(
            "evoflow.proactive.chat_session.list_employee_conversation_sessions",
            return_value=[],
        ),
        patch(
            "evoflow.proactive.chat_session.proactive_chat_session_key",
            return_value="proactive:douyin-analyst:chat:fixed",
        ),
    ):
        out = emp.chat_send(
            "douyin-analyst",
            "请拆这条视频",
            deliver="panel",
        )

    assert out["ok"] is True
    assert out["panel_delivery"] is True
    # 面板已在自己 chatSend → 这是 live SSE，标志必须点名
    assert out["panel_dispatch"] == "pane-live"
    assert out["streaming"] is True
    # 只有面板一条腿：服务端不许再 wake，否则同一句话两个桶
    assert woke == []
    assert calls and calls[0][1] == "action"
    assert calls[0][2]["action"] == "employeeChatSend"


def test_chat_send_deliver_panel_cdp_down_reports_empty_dispatch(monkeypatch):
    monkeypatch.setattr(
        "evoflow.tools.builtins.panel_engine.panel_request",
        lambda *a, **kw: {"ok": False, "error": "bridge down", "code": "backend_unavailable"},
    )

    with (
        patch.object(emp.ProactiveRepository, "get_role", return_value=_role()),
        patch(
            "evoflow.proactive.chat_session.list_employee_conversation_sessions",
            return_value=[],
        ),
        patch(
            "evoflow.proactive.chat_session.proactive_chat_session_key",
            return_value="proactive:douyin-analyst:chat:fixed",
        ),
    ):
        out = emp.chat_send("douyin-analyst", "在吗", deliver="panel")

    # 面板没驱到 → 空字符串，前端必须自己发；不许静默报成「已走流式」
    assert out["panel_dispatch"] == ""
    assert out["panel_delivery"] is True
    assert "streaming" not in out


def test_chat_send_default_auto_prefers_panel(monkeypatch):
    """默认 deliver=auto：面板在 → 走面板真流式，且**不许**再 wake。"""
    monkeypatch.setattr(
        "evoflow.tools.builtins.panel_engine.panel_request",
        lambda *a, **kw: _panel_env("pane-live"),
    )
    woke: list[str] = []
    monkeypatch.setattr(emp, "wake", lambda *a, **kw: woke.append("x") or {})

    with (
        patch.object(emp.ProactiveRepository, "get_role", return_value=_role()),
        patch(
            "evoflow.proactive.chat_session.list_employee_conversation_sessions",
            return_value=[],
        ),
        patch(
            "evoflow.proactive.chat_session.proactive_chat_session_key",
            return_value="proactive:douyin-analyst:chat:fixed",
        ),
    ):
        out = emp.chat_send("douyin-analyst", "你好")

    assert out["panel_dispatch"] == "pane-live"
    assert out["streaming"] is True
    assert out["queued"] is False
    assert woke == []


def test_chat_send_default_auto_falls_back_to_wake_when_panel_down(monkeypatch):
    """面板没开（CDP 不在）→ 回落 wake，保证有来有回；且 panel_delivery 必须为 False，
    否则前端会照 pendingSend 再发一遍 = 同一句话两遍。"""
    monkeypatch.setattr(
        "evoflow.tools.builtins.panel_engine.panel_request",
        lambda *a, **kw: {"ok": False, "error": "bridge down"},
    )
    woke: list[str] = []
    monkeypatch.setattr(
        emp,
        "wake",
        lambda *a, **kw: woke.append("x") or {"skipped": False, "task_id": None},
    )

    with (
        patch.object(emp.ProactiveRepository, "get_role", return_value=_role()),
        patch(
            "evoflow.proactive.chat_session.list_employee_conversation_sessions",
            return_value=[],
        ),
        patch(
            "evoflow.proactive.chat_session.proactive_chat_session_key",
            return_value="proactive:douyin-analyst:chat:fixed",
        ),
    ):
        out = emp.chat_send("douyin-analyst", "在吗")

    assert out["panel_dispatch"] == ""
    assert out["panel_delivery"] is False
    assert out["queued"] is True
    assert woke == ["x"]


def test_chat_send_auto_pane_busy_falls_back_to_wake(monkeypatch):
    """面板在但正忙（pane-busy）→ handleSend 会静默丢消息，绝不能当送达：
    必须回落 wake，且 panel_delivery=False 防前端重复补发。"""
    monkeypatch.setattr(
        "evoflow.tools.builtins.panel_engine.panel_request",
        lambda *a, **kw: _panel_env("pane-busy"),
    )
    woke: list[str] = []
    monkeypatch.setattr(
        emp,
        "wake",
        lambda *a, **kw: woke.append("x") or {"skipped": False, "task_id": None},
    )

    with (
        patch.object(emp.ProactiveRepository, "get_role", return_value=_role()),
        patch(
            "evoflow.proactive.chat_session.list_employee_conversation_sessions",
            return_value=[],
        ),
        patch(
            "evoflow.proactive.chat_session.proactive_chat_session_key",
            return_value="proactive:douyin-analyst:chat:fixed",
        ),
    ):
        out = emp.chat_send("douyin-analyst", "再说一句")

    # pane-busy 不在白名单里 → panel_dispatch 为空 → 必须回落
    assert out["panel_dispatch"] == ""
    assert out["panel_delivery"] is False
    assert out["queued"] is True
    assert woke == ["x"]


# 【self-evolution-bot · 2026-11-21 · 第112轮 · 模型:deepseek-v4.1-flash-1017】
# 改了什么：面板回报的 sk 与服务端预计算不一致时，回执 session_key 以面板为准。
# 为什么（真机 21:20）：预计算 chat:dept-…，面板 mint chat:2026-…，旧回执虚报前者。
# 判据：out["session_key"] == 面板实际 sk；session_key_matched=false + hint 必有。
def test_chat_send_receipt_prefers_panel_actual_session_key(monkeypatch):
    requested = "proactive:douyin-analyst:chat:dept-4de7e33a602b"
    actual = "proactive:douyin-analyst:chat:2026-11-21T13-20-20.208Z"

    def fake_panel_request(method, route, *, body=None, timeout=None):
        return {
            "ok": True,
            "result": {
                "action": "employeeChatSend",
                "detail": {
                    "mode": "pane-live",
                    "agentCode": "douyin-analyst",
                    "sessionKey": actual,
                    "requestedSessionKey": requested,
                    "sessionKeyMatched": False,
                    "sessionKeyMatchedBy": "code-fallback",
                    "length": 4,
                },
            },
        }

    monkeypatch.setattr(
        "evoflow.tools.builtins.panel_engine.panel_request",
        fake_panel_request,
    )
    monkeypatch.setattr(emp, "wake", lambda *a, **kw: {"skipped": True})

    with (
        patch.object(emp.ProactiveRepository, "get_role", return_value=_role()),
        patch(
            "evoflow.proactive.chat_session.list_employee_conversation_sessions",
            return_value=[
                {
                    "session_key": requested,
                    "kind": "chat",
                    "run_status": "idle",
                }
            ],
        ),
    ):
        out = emp.chat_send("douyin-analyst", "在吗", deliver="panel")

    assert out["ok"] is True
    assert out["panel_dispatch"] == "pane-live"
    assert out["session_key"] == actual
    assert out["requested_session_key"] == requested
    assert out["session_key_matched"] is False
    assert out["session_key_matched_by"] == "code-fallback"
    assert "二者不同" in str(out.get("hint") or "")


def test_chat_send_receipt_matched_true_when_panel_agrees(monkeypatch):
    sk = "proactive:douyin-analyst:chat:keep-me"

    def fake_panel_request(method, route, *, body=None, timeout=None):
        return {
            "ok": True,
            "result": {
                "action": "employeeChatSend",
                "detail": {
                    "mode": "pane-live",
                    "agentCode": "douyin-analyst",
                    "sessionKey": sk,
                    "requestedSessionKey": sk,
                    "sessionKeyMatched": True,
                    "sessionKeyMatchedBy": "exact",
                    "length": 2,
                },
            },
        }

    monkeypatch.setattr(
        "evoflow.tools.builtins.panel_engine.panel_request",
        fake_panel_request,
    )
    monkeypatch.setattr(emp, "wake", lambda *a, **kw: {"skipped": True})

    with patch.object(emp.ProactiveRepository, "get_role", return_value=_role()):
        out = emp.chat_send(
            "douyin-analyst",
            "继续",
            session_key=sk,
            deliver="panel",
        )

    assert out["session_key"] == sk
    assert out["session_key_matched"] is True
    assert out["session_key_matched_by"] == "exact"
    assert "requested_session_key" not in out
    assert "二者不同" not in str(out.get("hint") or "")
