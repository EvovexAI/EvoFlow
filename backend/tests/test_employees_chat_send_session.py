"""employees.chat_send must never target the caller's agent:main session."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import patch

from evoflow.admin import employees as emp


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
    with patch.object(emp.ProactiveRepository, "get_role", return_value=_role()):
        out = emp.chat_send(
            "douyin-analyst",
            "继续",
            session_key=owned,
            source="xiaomi",
        )
    assert out["session_key"] == owned
    assert "ignored_caller_session_key" not in out
