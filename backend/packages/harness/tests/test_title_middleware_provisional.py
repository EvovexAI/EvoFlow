"""TitleMiddleware should still generate when session has provisional title."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import patch

from langchain_core.messages import AIMessage, HumanMessage

from evoflow.agents.middlewares.title_middleware import TitleMiddleware


def test_thread_has_real_title_false_for_provisional() -> None:
    mw = TitleMiddleware()
    with patch(
        "evoflow.persistence.session_repositories.find_session_key_by_thread_id",
        return_value="agent:main:new-abc",
    ), patch(
        "evoflow.persistence.session_repositories.load_session_map",
        return_value={"agent:main:new-abc": {"title": "用户首条..."}},
    ):
        assert mw._thread_has_real_title("thread-1") is False


def test_thread_has_real_title_true_for_llm_title() -> None:
    mw = TitleMiddleware()
    with patch(
        "evoflow.persistence.session_repositories.find_session_key_by_thread_id",
        return_value="agent:main:new-abc",
    ), patch(
        "evoflow.persistence.session_repositories.load_session_map",
        return_value={"agent:main:new-abc": {"title": "季度复盘计划"}},
    ):
        assert mw._thread_has_real_title("thread-1") is True


def test_should_generate_title_with_provisional_in_db() -> None:
    mw = TitleMiddleware()
    state = {
        "messages": [
            HumanMessage(content="请帮我写周报"),
            AIMessage(content="好的"),
        ]
    }
    with patch.object(mw, "_thread_has_real_title", return_value=False), patch(
        "evoflow.config.title_config.get_title_config",
        return_value=SimpleNamespace(enabled=True),
    ):
        assert mw._should_generate_title(state, "thread-1") is True
